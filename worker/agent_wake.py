#!/usr/bin/env python3
"""Wake the Jobbot fill agent NOW instead of on its next poll.

Owner rule (2026-09-08): a button press in Telegram must start the work, not a
30-minute alarm clock. The agent lives in nanoclaw and is driven by rows in its
inbound.db; this module inserts a one-off copy of the fill/submit poller task
(same gate script, same prompt) due immediately. Two callers:

  --local [reason]   insert directly (host process, e.g. worker/ats_resolver.py
                     right after it promoted rows into the fill queue)
  --serve            small HTTP bridge for the Telegram bot edge function, which
                     runs inside docker and cannot touch the sqlite file:
                       POST /wake/jobbot   header X-Wake-Secret: <AGENT_WAKE_SECRET>
                                           body {"reason": "...", "dry": false}
                     It also kicks jobbot-resolver.service so a freshly confirmed
                     card is promoted (form URL probed) before the agent wakes.

The poller itself stays as a 30-minute safety net; the gate script inside the
copied task still decides whether there is real work (and refuses factory hours),
so a spurious wake costs one curl, not a model run.
"""
import json
import os
import random
import sqlite3
import subprocess
import sys
import threading
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
INBOUND = os.environ.get(
    "JOBBOT_AGENT_INBOUND",
    "/home/stuar/nanoclaw-v2/data/v2-sessions/ag-1784275710688-s87c7v/"
    "sess-1784275710698-esmwo9/inbound.db")
POLL_SERIES = "task-1784787379628-6jph2g"   # fill + submit queue poller
DEDUP_SECONDS = 180
PORT = int(os.environ.get("AGENT_WAKE_PORT", "3777"))
BIND = os.environ.get("AGENT_WAKE_BIND", "127.0.0.1,172.20.0.1").split(",")


def _env(name):
    """Read one key from worker/.env (gitignored) without exporting the file."""
    if os.environ.get(name):
        return os.environ[name]
    try:
        for line in open(os.path.join(HERE, ".env")):
            line = line.strip()
            if line.startswith(f"{name}="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    except OSError:
        pass
    return ""


def enqueue(reason, delay_s=0, dry=False):
    """Copy the poller's pending task as a one-off due now (+delay). Returns
    (task_id_or_None, status)."""
    now = datetime.now(timezone.utc)
    c = sqlite3.connect(INBOUND)
    try:
        row = c.execute(
            "select content from messages_in where series_id=? and status='pending' "
            "order by rowid desc limit 1", (POLL_SERIES,)).fetchone()
        if not row:
            return None, "poller row not found"
        since = (now - timedelta(seconds=DEDUP_SECONDS)).strftime("%Y-%m-%d %H:%M:%S")
        recent = c.execute(
            "select id from messages_in where id like 'task-%-evt%' and status='pending' "
            "and timestamp >= ?", (since,)).fetchone()
        if recent:
            return recent[0], "already queued"
        if dry:
            return None, "dry run — would queue"
        tid = f"task-{int(now.timestamp() * 1000)}-evt{random.randint(1000, 9999)}"
        seq = c.execute("select coalesce(max(seq),0)+1 from messages_in").fetchone()[0]
        content = json.loads(row[0])
        content["prompt"] = f"[EVENT WAKE — {reason}]\n" + content.get("prompt", "")
        due = now + timedelta(seconds=delay_s)
        c.execute(
            "insert into messages_in (id,seq,kind,timestamp,status,process_after,"
            "recurrence,series_id,tries,trigger,platform_id,channel_type,thread_id,content) "
            "values (?,?,'task',?,'pending',?,NULL,?,0,1,NULL,NULL,NULL,?)",
            (tid, seq, now.strftime("%Y-%m-%d %H:%M:%S"),
             due.isoformat(timespec="milliseconds").replace("+00:00", "Z"),
             tid, json.dumps(content)))
        c.commit()
        return tid, "queued"
    finally:
        c.close()


class Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):  # one line per call, no client noise
        sys.stdout.write("%s %s\n" % (datetime.now(timezone.utc).isoformat(timespec="seconds"),
                                      fmt % args))
        sys.stdout.flush()

    def _reply(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        if self.path != "/wake/jobbot":
            return self._reply(404, {"error": "unknown path"})
        secret = _env("AGENT_WAKE_SECRET")
        if not secret or self.headers.get("X-Wake-Secret") != secret:
            return self._reply(403, {"error": "bad secret"})
        n = int(self.headers.get("Content-Length") or 0)
        try:
            body = json.loads(self.rfile.read(n) or b"{}") if n else {}
        except ValueError:
            body = {}
        reason = str(body.get("reason") or "telegram")[:80]
        dry = bool(body.get("dry"))
        resolver = "skipped"
        if not dry:
            # Promote pending_manual -> sending (and probe the form) right away so
            # the agent finds the row when it wakes 90 s later.
            r = subprocess.run(["systemctl", "start", "--no-block", "jobbot-resolver.service"],
                               capture_output=True, text=True)
            resolver = "started" if r.returncode == 0 else f"failed: {r.stderr.strip()[:120]}"
        tid, status = enqueue(reason, delay_s=90, dry=dry)
        self._reply(200, {"ok": True, "task": tid, "status": status, "resolver": resolver})


def serve():
    servers = []
    for addr in BIND:
        addr = addr.strip()
        if not addr:
            continue
        try:
            s = ThreadingHTTPServer((addr, PORT), Handler)
        except OSError as e:
            print(f"cannot bind {addr}:{PORT}: {e}", flush=True)
            continue
        threading.Thread(target=s.serve_forever, daemon=True).start()
        servers.append(s)
        print(f"agent-wake listening on {addr}:{PORT}", flush=True)
    if not servers:
        sys.exit(1)
    threading.Event().wait()


if __name__ == "__main__":
    if "--serve" in sys.argv:
        serve()
    elif "--local" in sys.argv:
        reason = " ".join(a for a in sys.argv[1:] if not a.startswith("--")) or "local"
        print(enqueue(reason, dry="--dry" in sys.argv))
    else:
        print(__doc__)

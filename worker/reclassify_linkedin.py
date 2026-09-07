#!/usr/bin/env python3
"""Re-classify stored LinkedIn jobs against the live guest page and queue the
ones that turn out to have an employer form.

Why this exists (2026-09-07): the LinkedIn scan runs inside the long-lived
jobbot-worker process (auto_apply.py imports linkedin_scraper lazily and Python
keeps the module in memory). The worker was started on 02.09 and never restarted
after the 06.09 deploy, so it kept labelling every posting `linkedin_easy_apply`
("no form"). Such rows never get an applications row, the resolver only works on
applications, and nothing was ever filled. A live re-check of the last 40 rows
found 22 of the "easy apply" ones to be offsite (employer form exists).

What it does, per job (owner's user only, source LINKEDIN):
  1. fetch the guest page with the scraper's headers, classify offsite/onsite/closed
     (unknown = page did not render; the row is left untouched);
  2. write the corrected application_form_type (+ an ATS-looking URL from the
     posting text, strict, if the row has none);
  3. if the posting is offsite, scores >= the LinkedIn auto-queue floor and has no
     applications row yet: call generate_application (same Edge Function the
     analyzer uses) and send the usual Telegram card with the approve button.
     The ats_resolver timer then finds the form URL (pending_manual rows).
  4. one summary to the tech bot.

Usage (VPS, as user stuar, from worker/):
  ./venv-vps/bin/python reclassify_linkedin.py --since 2026-09-05 --dry-run
  ./venv-vps/bin/python reclassify_linkedin.py --since 2026-09-05 --high-since 2026-08-24
LinkedIn throttles ~100 guest GETs in 20 min from one IP: keep --pause >= 2.5.
"""

import argparse
import asyncio
import os
import sys
import time
from collections import Counter
from datetime import datetime, timezone

import httpx
from dotenv import load_dotenv
from supabase import create_client

load_dotenv()

import analyze_worker as aw  # noqa: E402  (constants + send_job_card, no side effects)
import linkedin_guest as g  # noqa: E402
from linkedin_scraper import HEADERS  # noqa: E402

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_KEY"]
OWNER_USER_ID = os.environ.get("JOBBOT_OWNER_USER_ID", "f92ee73e-786a-4990-b434-23f67203eb53")
RECLASSIFIABLE = ("linkedin_easy_apply", "linkedin_external")


def guest_kind(client: httpx.Client, job_url: str) -> dict:
    jid = g.job_id_from_url(job_url)
    if not jid:
        return {"kind": "unknown", "description": ""}
    url = f"https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{jid}"
    for attempt in (1, 2):
        try:
            r = client.get(url, headers=HEADERS, timeout=20, follow_redirects=True)
        except Exception:
            r = None
        if r is not None and r.status_code == 200:
            return g.classify_guest_page(r.text)
        time.sleep(15)  # 429/999 = throttled; one retry after a breather
    return {"kind": "unknown", "description": ""}


def select_jobs(sb, since: str, high_since: str | None, min_score: int, limit: int) -> list[dict]:
    cols = ("id,title,company,job_url,source,application_form_type,external_apply_url,"
            "relevance_score,ai_recommendation,tasks_summary,analysis_metadata,track,"
            "location,deadline,created_at")
    q = (sb.table("jobs").select(cols)
         .eq("user_id", OWNER_USER_ID).eq("source", "LINKEDIN")
         .in_("application_form_type", list(RECLASSIFIABLE))
         .gte("created_at", since).order("created_at", desc=True).limit(limit))
    rows = q.execute().data or []
    if high_since:
        hq = (sb.table("jobs").select(cols)
              .eq("user_id", OWNER_USER_ID).eq("source", "LINKEDIN")
              .in_("application_form_type", list(RECLASSIFIABLE))
              .gte("relevance_score", min_score)
              .gte("created_at", high_since).lt("created_at", since)
              .order("relevance_score", desc=True).limit(limit))
        rows += hq.execute().data or []
    seen, out = set(), []
    for r in rows:
        if r["id"] not in seen:
            seen.add(r["id"])
            out.append(r)
    return out


def has_application(sb, job_id: str) -> bool:
    res = sb.table("applications").select("id").eq("job_id", job_id).eq("user_id", OWNER_USER_ID).limit(1).execute()
    return bool(res.data)


async def queue_job(sb, job: dict, chat_id: str, lang: str) -> dict | None:
    async with httpx.AsyncClient() as client:
        res = await aw.generate_soknad_via_api(client, job["id"], OWNER_USER_ID)
        if not (res.get("success") and res.get("application")):
            print(f"   ⚠️ generate_application failed: {res.get('message', '?')[:160]}")
            return None
        app = res["application"]
        meta = job.get("analysis_metadata") or {}
        result = {
            "score": job.get("relevance_score") or 0,
            "analysis": job.get("ai_recommendation") or "",
            "tasks": job.get("tasks_summary") or "",
            "requirements": meta.get("requirements", ""),
            "offers": meta.get("offers", ""),
            "position_uk": meta.get("position_uk", ""),
        }
        try:
            await aw.send_job_card(client, chat_id, job, result, auto_app=app, lang=lang)
        except Exception as e:
            print(f"   ⚠️ card failed: {e}")
        return app


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--since", default="2026-09-05", help="re-check every reclassifiable row created since this date")
    ap.add_argument("--high-since", default=None, help="also rows >= --min-score created since this (older) date")
    ap.add_argument("--min-score", type=int, default=aw.AUTO_SOKNAD_MIN_BY_SOURCE["LINKEDIN"])
    ap.add_argument("--limit", type=int, default=120)
    ap.add_argument("--pause", type=float, default=2.5)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--allow-old-scores", action="store_true",
                    help="queue rows scored before the strict LinkedIn prompt (no analysis_metadata.linkedin_gate)")
    args = ap.parse_args()

    sb = create_client(SUPABASE_URL, SUPABASE_KEY)
    us = (sb.table("user_settings").select("telegram_chat_id,ui_language")
          .eq("user_id", OWNER_USER_ID).limit(1).execute().data or [{}])[0]
    chat_id, lang = us.get("telegram_chat_id"), us.get("ui_language") or "uk"

    jobs = select_jobs(sb, args.since, args.high_since, args.min_score, args.limit)
    print(f"{len(jobs)} LinkedIn rows to re-check (since {args.since}"
          f"{', >=' + str(args.min_score) + ' since ' + args.high_since if args.high_since else ''})"
          f"{' [DRY RUN]' if args.dry_run else ''}")

    tally = Counter()
    queued, candidates = [], []
    with httpx.Client() as client:
        for j in jobs:
            page = guest_kind(client, j["job_url"])
            kind = page["kind"]
            old = j["application_form_type"]
            score = j.get("relevance_score") or 0
            text_url = None
            if kind != "onsite":
                text_url = g.apply_url_from_text(page.get("description") or "", strict=True)
            new = g.form_type_for(kind, j.get("external_apply_url") or text_url)
            tag = f"{old} -> {kind}"
            tally[tag] += 1
            print(f"  {score:3d} | {tag:38s} | {(j.get('company') or '')[:22]:22s} | {j['title'][:40]}")
            if kind == "unknown" or new is None:
                continue
            patch = {}
            if new != old:
                patch["application_form_type"] = new
            if text_url and not j.get("external_apply_url"):
                patch["external_apply_url"] = text_url
            if patch and not args.dry_run:
                sb.table("jobs").update(patch).eq("id", j["id"]).execute()
                j.update(patch)
            if kind == "offsite" and score >= args.min_score and not aw.company_blocked(j.get("company")):
                strict = bool((j.get("analysis_metadata") or {}).get("linkedin_gate"))
                if has_application(sb, j["id"]):
                    tally["already queued"] += 1
                elif not strict and not args.allow_old_scores:
                    # scored with the pre-06.09 lenient prompt; the LinkedIn backlog
                    # re-score decides, then a second pass of this script queues it
                    tally["offsite >=60 but old score, awaiting re-score"] += 1
                    print(f"      ⏳ old score, not queued: {j.get('company')} — {j['title'][:40]}")
                else:
                    candidates.append(j)
            time.sleep(args.pause)

    for j in candidates:
        print(f"✍️ queue: {j.get('company')} — {j['title'][:50]} ({j.get('relevance_score')})")
        if args.dry_run:
            continue
        app = asyncio.run(queue_job(sb, j, chat_id, lang))
        if app:
            queued.append(j)
        time.sleep(1)

    lines = [f"🔁 LinkedIn re-check: {len(jobs)} рядків" + (" (dry run)" if args.dry_run else "")]
    lines += [f"  {k}: {v}" for k, v in tally.most_common()]
    lines.append(f"✍️ у чергу: {len(queued)} з {len(candidates)} кандидатів (≥{args.min_score}, offsite)")
    for j in queued:
        lines.append(f"  • {j.get('company')} — {j['title'][:48]} ({j.get('relevance_score')})")
    text = "\n".join(lines)
    print(text)
    token = os.environ.get("TELEGRAM_TECH_BOT_TOKEN")
    if token and chat_id and not args.dry_run:
        try:
            httpx.post(f"https://api.telegram.org/bot{token}/sendMessage",
                       json={"chat_id": chat_id, "text": text, "disable_web_page_preview": True}, timeout=20)
        except Exception as e:
            print(f"⚠️ tech bot: {e}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

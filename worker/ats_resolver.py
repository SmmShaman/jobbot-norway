#!/usr/bin/env python3
"""
ats_resolver.py — find the employer's real application form for a job that only
has a LinkedIn (or otherwise form-less) posting, using free channels only.

WHY THIS EXISTS
---------------
Until 2026-07-29 this search was done by the Claude agent itself, on the
subscription. Measured cost: ~1.2M tokens per application (16.1M for 13 of them
on 05:06-05:21 CEST, which produced zero sent applications). The work is a plain
text task — search, open a few pages, compare two descriptions — and needs no
paid model at all. Here it costs nothing: DuckDuckGo's HTML endpoint needs no
key, and the match is decided by word overlap, not by an LLM.

DELIBERATELY NARROW SCOPE
-------------------------
The resolver only ever *adds* `jobs.external_apply_url`. It does not move any
application into a queue, because that would create work for the agent - the very
thing we are trying to bound. Re-activating resolved rows is a separate, explicit
decision (`--reactivate N`), so the owner controls how much the agent is asked to
do. Rows it cannot resolve get an `ats-resolver: …` note on the application, both
as a record and so the next run skips them.

USAGE
  python3 ats_resolver.py --dry-run          # search, decide, change nothing
  python3 ats_resolver.py --limit 10         # resolve up to 10 jobs
  python3 ats_resolver.py --reactivate 5     # move 5 resolved manual_review rows
                                             # back into the agent's queue
"""

import argparse
import html
import json
import os
import re
import sys
import time
import urllib.parse
from pathlib import Path

import httpx
from bs4 import BeautifulSoup

ENV_PATH = Path(__file__).resolve().parent / ".env"
OWNER_USER_ID = os.environ.get(
    "JOBBOT_OWNER_USER_ID", "f92ee73e-786a-4990-b434-23f67203eb53"
)

# Domains that host real application forms. A hit here is worth checking; a link
# to a job board that merely reposts the ad is not.
ATS_HINTS = (
    "teamtailor.com", "myworkdayjobs.com", "recman.no", "recman.page",
    "easycruit.com", "webcruiter.com", "varbi.com", "jobylon.com",
    "csod.com", "successfactors.com", "smartrecruiters.com", "greenhouse.io",
    "lever.co", "workable.com", "jobbnorge.no", "reachmee.com", "hrmanager.no",
    "candarine.com", "talentech.com", "emply.com", "hr-manager.net",
)
ATS_PATH_HINTS = ("karriere", "karriar", "career", "jobs", "job", "stilling", "vacan")

# Never fetched as a candidate: aggregators and sites we must not automate.
BLOCKED = (
    "linkedin.com", "finn.no", "indeed.", "glassdoor.", "facebook.com",
    "twitter.com", "x.com", "youtube.com", "jooble.", "neuvoo.", "trovit.",
    "jobbsafari.", "karrierestart.no", "arbeidsplassen.nav.no", "nav.no",
)

UA = {
    "User-Agent": (
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "nb-NO,nb;q=0.9,en;q=0.8",
}

# Norwegian/English words too common to carry any signal about *which* job this is.
STOPWORDS = set("""
about after also andre arbeid arbeide arbeidet also alle andre available based
because been being between både både company contact deg dette der desuden
eller ellers erfaring etter finne first from gjennom good gode great group har
have hos hvor iht into jobb jobben kandidat kompetanse kontakt kunne like ligger
mellom meget mulighet muligheter noen norsk også ogsa oppgaver over personlige
samt seg selv skal skal som stilling store søker soker such team tilbyr under
vare vart ved vere være vil vill with within work working you your dine deres
våre vår vart oss deg din ditt this that they them then than there here will
would should could have has had been being are was were the and for with our
""".split())


# --------------------------------------------------------------------------- #
# env + supabase
# --------------------------------------------------------------------------- #
def load_env() -> None:
    if not ENV_PATH.exists():
        sys.exit(f"env file not found: {ENV_PATH}")
    for line in ENV_PATH.read_text(encoding="utf-8", errors="replace").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


class Supa:
    def __init__(self) -> None:
        self.url = os.environ["SUPABASE_URL"].rstrip("/")
        key = os.environ["SUPABASE_SERVICE_KEY"]
        self.h = {
            "apikey": key,
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        }
        self.c = httpx.Client(timeout=30)

    def get(self, path: str, **params):
        r = self.c.get(f"{self.url}/rest/v1/{path}", headers=self.h, params=params)
        r.raise_for_status()
        return r.json()

    def patch(self, path: str, payload: dict, **params):
        r = self.c.patch(
            f"{self.url}/rest/v1/{path}", headers=self.h, params=params, json=payload
        )
        r.raise_for_status()
        return r


# --------------------------------------------------------------------------- #
# search
# --------------------------------------------------------------------------- #
QUOTA_FILE = Path(__file__).resolve().parent / ".resolver_quota.json"


def quota_take(channel: str, cap: int) -> bool:
    """Hard daily cap per channel, persisted on disk.

    Google's free Custom Search tier is 100 queries/day *per Cloud project*, and
    that project's quota is shared with whatever else uses the same key. Going
    over does not fail — it bills. So the counter is the safety, not the intent.
    """
    today = time.strftime("%Y-%m-%d")
    data = {}
    if QUOTA_FILE.exists():
        try:
            data = json.loads(QUOTA_FILE.read_text())
        except Exception:
            data = {}
    if data.get("date") != today:
        data = {"date": today}
    used = int(data.get(channel, 0))
    if used >= cap:
        return False
    data[channel] = used + 1
    try:
        QUOTA_FILE.write_text(json.dumps(data))
    except Exception:
        pass
    return True


def quota_left(channel: str, cap: int) -> int:
    if not QUOTA_FILE.exists():
        return cap
    try:
        data = json.loads(QUOTA_FILE.read_text())
    except Exception:
        return cap
    if data.get("date") != time.strftime("%Y-%m-%d"):
        return cap
    return max(0, cap - int(data.get(channel, 0)))


def cse_search(client: httpx.Client, query: str) -> list[str]:
    """Google Programmable Search — the reliable channel, 100 queries/day free.

    Needs GOOGLE_SEARCH_KEY (or GOOGLE_API_KEY) + GOOGLE_CSE_ID, the Custom
    Search API enabled on that Cloud project, and the engine set to search the
    entire web. Returns [] and stays quiet if any of that is missing, so the
    caller just falls through to the next channel.
    """
    key = os.environ.get("GOOGLE_SEARCH_KEY") or os.environ.get("GOOGLE_API_KEY")
    cx = os.environ.get("GOOGLE_CSE_ID")
    if not key or not cx:
        return []
    cap = int(os.environ.get("CSE_DAILY_CAP", "80"))
    if not quota_take("cse", cap):
        print("      [cse] daily cap reached — skipping channel")
        return []
    try:
        r = client.get(
            "https://www.googleapis.com/customsearch/v1",
            params={"key": key, "cx": cx, "q": query, "num": 8},
            timeout=25,
        )
        if r.status_code != 200:
            print(f"      [cse] {r.status_code}: {r.text[:120]}")
            return []
        return [i["link"] for i in r.json().get("items", []) if i.get("link")]
    except Exception as e:
        print(f"      [cse] {type(e).__name__}: {e}")
        return []


def searx_search(client: httpx.Client, query: str) -> list[str]:
    """Self-hosted SearxNG, if one is running (SEARX_URL). Keyless and unmetered."""
    base = os.environ.get("SEARX_URL")
    if not base:
        return []
    try:
        r = client.get(
            base.rstrip("/") + "/search",
            params={"q": query, "format": "json", "language": "no"},
            headers=UA,
            timeout=25,
        )
        if r.status_code != 200:
            return []
        return [x["url"] for x in r.json().get("results", []) if x.get("url")]
    except Exception:
        return []


def ddg_search(client: httpx.Client, query: str, tries: int = 2) -> list[str]:
    """DuckDuckGo's keyless HTML endpoints — best-effort only.

    Verified working on 2026-07-29 and then rate-limited within the hour: it
    starts answering 202 with a challenge page instead of results. Treat any
    non-200 as "channel is down right now", never as "no such job".
    """
    urls: list[str] = []
    for endpoint in ("https://html.duckduckgo.com/html/", "https://lite.duckduckgo.com/lite/"):
        for attempt in range(tries):
            try:
                r = client.get(endpoint, params={"q": query}, headers=UA, timeout=25)
                if r.status_code != 200:
                    time.sleep(2 + attempt * 3)
                    continue
                for m in re.finditer(r"uddg=([^&\"']+)", r.text):
                    u = urllib.parse.unquote(html.unescape(m.group(1)))
                    if u.startswith("http") and u not in urls:
                        urls.append(u)
                if urls:
                    return urls
            except Exception:
                time.sleep(2 + attempt * 3)
    return urls


def web_search(client: httpx.Client, query: str, verbose: bool = False) -> tuple[list[str], str]:
    """Try the channels in order of reliability; report which one answered."""
    for name, fn in (("cse", cse_search), ("searx", searx_search), ("ddg", ddg_search)):
        urls = fn(client, query)
        if urls:
            if verbose:
                print(f"      [{name}] {len(urls)} results")
            return urls, name
    return [], "none"


def rank_candidates(urls: list[str], company: str) -> list[str]:
    """ATS domains first, then the company's own careers pages, then the rest."""
    comp = re.sub(r"[^a-z0-9]", "", (company or "").lower())[:12]

    def score(u: str) -> int:
        low = u.lower()
        if any(b in low for b in BLOCKED):
            return -1
        s = 0
        if any(h in low for h in ATS_HINTS):
            s += 10
        if comp and comp in re.sub(r"[^a-z0-9]", "", low):
            s += 4
        if any(p in low for p in ATS_PATH_HINTS):
            s += 2
        return s

    scored = [(score(u), i, u) for i, u in enumerate(urls)]
    return [u for s, _, u in sorted(scored, key=lambda t: (-t[0], t[1])) if s > 0]


# --------------------------------------------------------------------------- #
# matching
# --------------------------------------------------------------------------- #
def words(text: str) -> set[str]:
    toks = re.findall(r"[a-zA-ZÆØÅæøåÄÖäöéèü]{4,}", (text or "").lower())
    return {t for t in toks if t not in STOPWORDS}


def page_text(client: httpx.Client, url: str) -> str:
    r = client.get(url, headers=UA, timeout=30, follow_redirects=True)
    if r.status_code != 200 or "html" not in r.headers.get("content-type", ""):
        return ""
    soup = BeautifulSoup(r.text, "html.parser")
    for tag in soup(["script", "style", "noscript", "svg", "header", "footer", "nav"]):
        tag.decompose()
    return re.sub(r"\s+", " ", soup.get_text(" "))


def overlap(description: str, page: str) -> float:
    """Share of the posting's distinctive words that also appear on the page."""
    d = words(description)
    if len(d) < 15:
        return 0.0
    p = words(page)
    return len(d & p) / len(d)


# --------------------------------------------------------------------------- #
# main flow
# --------------------------------------------------------------------------- #
def pick_jobs(db: Supa, limit: int, statuses: str) -> list[dict]:
    rows = db.get(
        "applications",
        select="id,status,error_message,job_id,jobs!inner(id,title,company,location,description,job_url,source,application_form_type,external_apply_url)",
        user_id=f"eq.{OWNER_USER_ID}",
        status=f"in.({statuses})",
        order="created_at.asc",
        limit=str(limit * 6),
        **{"jobs.external_apply_url": "is.null"},
    )
    out, seen = [], set()
    for r in rows:
        job = r.get("jobs") or {}
        note = r.get("error_message") or ""
        if note.startswith("ats-resolver:"):  # already tried, do not pay twice
            continue
        if job.get("id") in seen:
            continue
        seen.add(job["id"])
        out.append(r)
        if len(out) >= limit:
            break
    return out


def resolve_one(
    client: httpx.Client, job: dict, max_pages: int, verbose: bool
) -> tuple[str | None, float, list[str], bool]:
    title = (job.get("title") or "").strip()
    company = (job.get("company") or "").strip()
    location = (job.get("location") or "").strip().split(",")[0]
    desc = job.get("description") or ""

    queries = [f"{title} {company}".strip()]
    if location:
        queries.append(f"{title} {company} {location}".strip())
    queries.append(f"{company} karriere {title}".strip())

    tried: list[str] = []
    best_url, best_score = None, 0.0
    channels: set[str] = set()
    for q in queries:
        raw, channel = web_search(client, q, verbose)
        channels.add(channel)
        if channel == "none":
            print("      no search channel answered — stopping this job")
            break
        urls = rank_candidates(raw, company)
        for u in urls[:max_pages]:
            if u in tried:
                continue
            tried.append(u)
            try:
                text = page_text(client, u)
            except Exception:
                continue
            sc = overlap(desc, text)
            if verbose:
                print(f"      {sc:.2f}  {u[:100]}")
            if sc > best_score:
                best_url, best_score = u, sc
            if best_score >= 0.60:
                return best_url, best_score, tried
            time.sleep(1.5)
        if best_score >= 0.60:
            break
        time.sleep(2.5)
    searched = channels != {"none"} and channels != set()
    if best_score >= 0.45:
        return best_url, best_score, tried, searched
    return None, best_score, tried, searched


def promote_ready(db: Supa, dry_run: bool) -> int:
    """Move pending_manual rows that already have a form URL into the fill queue.

    This used to be an agent's job: it woke up, wrote a cover letter, and set the
    row to 'sending'. Two things were wrong with that. The letter cost subscription
    tokens for applications that often never reached a form at all, and the status
    change itself needs no intelligence whatsoever.

    Owner's rule (2026-07-29): writing the letter and filling the form are one
    process, and the letter is written last — see skills/form-filling/SKILL.md
    phase 3b. So this function only moves the row; the agent does everything else
    in a single run, at submission time.
    """
    rows = db.get(
        "applications",
        select="id,jobs!inner(id,external_apply_url)",
        user_id=f"eq.{OWNER_USER_ID}",
        status="eq.pending_manual",
        order="created_at.asc",
        **{"jobs.external_apply_url": "not.is.null"},
    )
    for r in rows:
        print(f"  queue {r['id'][:8]} -> sending  ({(r.get('jobs') or {}).get('external_apply_url', '')[:60]})")
        if not dry_run:
            db.patch(
                "applications",
                {"status": "sending", "submission_method": "agent"},
                id=f"eq.{r['id']}",
            )
    return len(rows)


def tech_notify(text: str) -> None:
    token = os.environ.get("TELEGRAM_TECH_BOT_TOKEN")
    chat = os.environ.get("TELEGRAM_TECH_CHAT_ID") or os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat:
        return
    try:
        httpx.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={"chat_id": chat, "text": text, "disable_web_page_preview": True},
            timeout=20,
        )
    except Exception:
        pass


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=8, help="jobs to resolve per run")
    ap.add_argument("--max-pages", type=int, default=3, help="pages fetched per query")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--verbose", action="store_true")
    ap.add_argument("--statuses", default="manual_review,pending_manual")
    ap.add_argument(
        "--reactivate",
        type=int,
        default=0,
        help="move up to N already-resolved manual_review rows back to pending_manual "
        "(this is what creates work for the agent — keep it small and deliberate)",
    )
    args = ap.parse_args()

    load_env()
    db = Supa()

    if args.reactivate:
        rows = db.get(
            "applications",
            select="id,jobs!inner(id,external_apply_url)",
            user_id=f"eq.{OWNER_USER_ID}",
            status="eq.manual_review",
            order="created_at.asc",
            limit=str(args.reactivate),
            **{"jobs.external_apply_url": "not.is.null"},
        )
        for r in rows:
            print(f"reactivate {r['id']} -> pending_manual")
            if not args.dry_run:
                db.patch(
                    "applications",
                    {"status": "pending_manual", "error_message": None},
                    id=f"eq.{r['id']}",
                )
        print(f"reactivated: {len(rows)}")
        return

    promoted = promote_ready(db, args.dry_run)
    if promoted:
        print(f"queued for filling: {promoted}")

    apps = pick_jobs(db, args.limit, args.statuses)
    cse_cap = int(os.environ.get("CSE_DAILY_CAP", "80"))
    print(f"candidates: {len(apps)} | cse budget left today: {quota_left('cse', cse_cap)}/{cse_cap}")
    client = httpx.Client(follow_redirects=True)
    found = missed = blocked = 0

    for app in apps:
        job = app["jobs"]
        print(f"\n[{job.get('company')}] {job.get('title')}  (app {app['id'][:8]})")
        url, score, tried, searched = resolve_one(client, job, args.max_pages, args.verbose)
        if not searched:
            # No search channel answered. This says nothing about the job, so it
            # must not be marked as unresolvable — that note is permanent.
            blocked += 1
            print("  SKIP  search unavailable, leaving the row untouched")
            continue
        if url:
            found += 1
            print(f"  MATCH {score:.2f} -> {url}")
            if not args.dry_run:
                db.patch(
                    "jobs",
                    {"external_apply_url": url, "application_form_type": "external_form"},
                    id=f"eq.{job['id']}",
                )
        else:
            missed += 1
            hosts = ", ".join(sorted({urllib.parse.urlparse(t).netloc for t in tried})[:6]) or "no candidates"
            note = f"ats-resolver: no external form; best={score:.2f}; searched: {hosts}"
            print(f"  MISS  {score:.2f}  ({hosts})")
            if not args.dry_run:
                db.patch("applications", {"error_message": note}, id=f"eq.{app['id']}")

    summary = f"🔎 ATS-resolver: {found} знайдено, {missed} без форми (з {len(apps)})"
    if promoted:
        summary = f"📥 У чергу на заповнення: {promoted}\n" + summary
    if blocked:
        summary += f"; {blocked} відкладено — пошуковий канал недоступний"
    print("\n" + summary)
    if not args.dry_run and apps:
        tech_notify(summary)


if __name__ == "__main__":
    main()

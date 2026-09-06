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

CHANNELS, cheapest first (2026-09-06)
-------------------------------------
LinkedIn's guest page hides the employer's URL behind a sign-in modal, but it
still says whether an employer form exists at all (offsite vs Easy Apply) and
links the company page, which exposes the employer's website. So before any
search engine is asked:
  1. a URL written in the posting text itself (9 % of LinkedIn postings);
  2. the LinkedIn guest page — Easy-Apply-only and closed postings leave the
     queue here with an honest note instead of burning a search;
  3. the employer's website (from the LinkedIn company page) → its careers
     page → the job whose title matches;
  4. SearxNG / Google CSE (SEARX_URL / GOOGLE_CSE_ID), as before.
Every candidate is still verified by description overlap; nothing logs in.

USAGE
  python3 ats_resolver.py --dry-run          # search, decide, change nothing
  python3 ats_resolver.py --limit 10         # resolve up to 10 jobs
  python3 ats_resolver.py --reactivate 5     # move 5 resolved manual_review rows
                                             # back into the agent's queue
"""

import argparse
import json
import os
import re
import sys
import time
import urllib.parse
from pathlib import Path

import httpx
from bs4 import BeautifulSoup

from linkedin_guest import (
    FORM_CLOSED, FORM_EASY_APPLY, GUEST_HEADERS,
    apply_url_from_text, classify_guest_page, company_website_from_guest_page,
    guest_job_url, job_id_from_url,
)

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
    "workday.com", "jobbnorge.no", "jobylon.com", "jobs.lever.co", "ashbyhq.com",
    "bamboohr.com", "personio.", "pinpointhq.com", "applytojob.com", "mojob.io",
)
ATS_PATH_HINTS = ("karriere", "karriar", "career", "jobs", "job", "stilling", "vacan")

# Never fetched as a candidate: aggregators and sites we must not automate.
BLOCKED = (
    "linkedin.com", "finn.no", "indeed.", "glassdoor.", "facebook.com",
    "twitter.com", "x.com", "youtube.com", "jooble.", "neuvoo.", "trovit.",
    "jobbsafari.", "karrierestart.no", "arbeidsplassen.nav.no", "nav.no",
    # aggregators that repost the ad with the full text (all scored 0.7-0.97 on
    # 06.09.2026 and none of them is a form): role.com, tass.no, silver.dev, …
    "role.com", "tass.no", "silver.dev", "jobble.", "uncover.work", "jobs.no/",
    "relomote.", "careerjet.", "jobrapido.", "adzuna.", "talent.com", "jobted.",
    "getclera.", "himalayas.app", "wellfound.com", "remoterocketship.",
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


def search_available() -> bool:
    """Is any search channel actually configured? Used to skip fast instead of waiting."""
    have_cse = bool((os.environ.get("GOOGLE_SEARCH_KEY") or os.environ.get("GOOGLE_API_KEY")) and os.environ.get("GOOGLE_CSE_ID"))
    return have_cse or bool(os.environ.get("SEARX_URL"))


def web_search(client: httpx.Client, query: str, verbose: bool = False) -> tuple[list[str], str]:
    """Try the configured channels in order; report which one answered.

    DuckDuckGo's keyless endpoint was here until 2026-07-29 and is gone at the
    owner's instruction. It was unreliable (200 with results one hour, 202 with an
    anti-bot challenge the next) and its results were poor enough to matter: for
    AutoStore it surfaced a job aggregator that the acceptance rule only just
    caught. A search channel that has to be second-guessed is worse than none,
    because "no channel" is handled cleanly — the job steps aside.
    """
    for name, fn in (("cse", cse_search), ("searx", searx_search)):
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
def covers_company(url: str, company: str) -> bool:
    """Is this URL on the employer's own domain? (autostoresystem.com for AutoStore™)"""
    comp = re.sub(r"[^a-z0-9]", "", (company or "").lower())
    if len(comp) < 4:
        return False
    host = re.sub(r"[^a-z0-9]", "", urllib.parse.urlparse(url).netloc.lower())
    return comp[:12] in host


def words(text: str) -> set[str]:
    toks = re.findall(r"[a-zA-ZÆØÅæøåÄÖäöéèü]{4,}", (text or "").lower())
    return {t for t in toks if t not in STOPWORDS}


def page_text(client: httpx.Client, url: str) -> str:
    return page_text_and_title(client, url)[0]


def page_text_and_title(client: httpx.Client, url: str) -> tuple[str, str]:
    """Visible text of a page plus its headline (og:title / h1 / <title>)."""
    r = client.get(url, headers=UA, timeout=30, follow_redirects=True)
    if r.status_code != 200 or "html" not in r.headers.get("content-type", ""):
        return "", ""
    soup = BeautifulSoup(r.text, "html.parser")
    heads = []
    og = soup.find("meta", attrs={"property": "og:title"})
    if og and og.get("content"):
        heads.append(og["content"])
    h1 = soup.find("h1")
    if h1:
        heads.append(h1.get_text(" ", strip=True))
    if soup.title and soup.title.string:
        heads.append(soup.title.string)
    for tag in soup(["script", "style", "noscript", "svg", "header", "footer", "nav"]):
        tag.decompose()
    return re.sub(r"\s+", " ", soup.get_text(" ")), " | ".join(heads)


def overlap(description: str, page: str) -> float:
    """Share of the posting's distinctive words that also appear on the page."""
    d = words(description)
    if len(d) < 15:
        return 0.0
    p = words(page)
    return len(d & p) / len(d)



# --------------------------------------------------------------------------- #
# keyless channels: posting text, LinkedIn guest page, employer website
# --------------------------------------------------------------------------- #
CAREER_PATHS = (
    "/karriere", "/careers", "/career", "/jobs", "/jobb", "/ledige-stillinger",
    "/stillinger", "/join-us", "/en/careers", "/no/karriere", "/jobb-hos-oss",
    "/om-oss/ledige-stillinger", "/work-with-us", "/karriere/ledige-stillinger",
)
CAREER_WORDS = re.compile(
    r"karriere|karri[aä]r|career|jobb|job|stilling|vacanc|ledig|join|work.?with.?us|bli.?med|hiring",
    re.I,
)


def fetch_html(client: httpx.Client, url: str, timeout: int = 25, headers: dict = UA) -> str:
    try:
        r = client.get(url, headers=headers, timeout=timeout, follow_redirects=True)
    except Exception:
        return ""
    if r.status_code != 200 or "html" not in r.headers.get("content-type", ""):
        return ""
    return r.text


def title_tokens(title: str) -> set[str]:
    toks = re.findall(r"[a-zA-ZÆØÅæøåÄÖäöéèü]{3,}", (title or "").lower())
    drop = {"and", "the", "for", "med", "til", "hos", "som", "our", "new", "senior", "junior"}
    return {t for t in toks if t not in drop}


def title_matches(anchor: str, title: str) -> bool:
    """Does a link's text look like this posting's title? 60 % of the title's words."""
    tt = title_tokens(title)
    if not tt:
        return False
    at = title_tokens(anchor)
    return len(tt & at) / len(tt) >= 0.6


def linkedin_guest_probe(client: httpx.Client, job: dict) -> dict | None:
    """One anonymous GET of the LinkedIn guest page. Returns the classification
    (kind, company_url, description) or None when the job is not a LinkedIn one
    or the page did not render."""
    if (job.get("source") or "").upper() != "LINKEDIN":
        return None
    jid = job_id_from_url(job.get("job_url") or "")
    if not jid:
        return None
    for attempt in (1, 2):
        try:
            r = client.get(guest_job_url(jid), headers=GUEST_HEADERS, timeout=25, follow_redirects=True)
        except Exception:
            return None
        if r.status_code == 200:
            break
        if attempt == 1 and r.status_code in (429, 999):
            time.sleep(20)  # LinkedIn throttles bursts from one IP; one retry is enough
            continue
        return None
    page = classify_guest_page(r.text)
    return page if page["kind"] != "unknown" else None


def employer_site_candidates(
    client: httpx.Client, company_url: str | None, title: str, company: str, verbose: bool
) -> list[str]:
    """Employer website → careers page → links that look like this job.

    The website comes from the LinkedIn *company* guest page ("Nettsted"), which
    needs no login. Returns up to 5 job-page URLs for overlap verification; the
    careers listing itself is never returned (a listing is not a form).
    """
    if not company_url:
        return []
    # LinkedIn answers the guest company page only for a browser-like header set
    site = company_website_from_guest_page(fetch_html(client, company_url, headers=GUEST_HEADERS))
    if not site:
        return []
    if verbose:
        print(f"      [site] {site}")
    time.sleep(1.0)
    site_host = urllib.parse.urlparse(site).netloc.lower().removeprefix("www.")

    def same_site_or_ats(u: str) -> bool:
        h = urllib.parse.urlparse(u).netloc.lower().removeprefix("www.")
        return bool(h) and (h.endswith(site_host) or any(a in h for a in ATS_HINTS))

    def links(html: str, base: str) -> list[tuple[str, str]]:
        out = []
        for a in BeautifulSoup(html, "html.parser").find_all("a", href=True):
            href = urllib.parse.urljoin(base, a["href"].strip())
            if not href.startswith("http") or any(b in href.lower() for b in BLOCKED):
                continue
            out.append((href.split("#")[0], a.get_text(" ", strip=True)))
        return out

    # 1. careers pages: links from the homepage that say "karriere/jobs", plus common paths
    careers: list[str] = []
    home = fetch_html(client, site)
    for href, text in links(home, site):
        if same_site_or_ats(href) and (CAREER_WORDS.search(text) or CAREER_WORDS.search(urllib.parse.urlparse(href).path)):
            if href not in careers:
                careers.append(href)
    for path in CAREER_PATHS:
        guess = site.rstrip("/") + path
        if guess not in careers:
            careers.append(guess)

    # 2. on each careers page (max 3 fetched), links whose text matches the title
    found: list[str] = []
    fetched = 0
    for c in careers:
        if fetched >= 3 or len(found) >= 5:
            break
        html = fetch_html(client, c)
        if not html:
            continue
        fetched += 1
        time.sleep(1.0)
        if verbose:
            print(f"      [careers] {c[:90]}")
        for href, text in links(html, c):
            if href in found or href == c:
                continue
            if title_matches(text, title) and (same_site_or_ats(href) or CAREER_WORDS.search(href)):
                found.append(href)
            elif any(a in href.lower() for a in ATS_HINTS) and title_matches(href.replace("-", " "), title):
                found.append(href)
    return found[:5]

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


def resolve_one(client: httpx.Client, job: dict, max_pages: int, verbose: bool) -> dict:
    """Find the employer's form for one job. Returns
        verdict:  'match' | 'easy_apply' | 'closed' | 'miss' | 'no_channel'
        url, score, tried (URLs fetched), channels (names that answered)
    """
    title = (job.get("title") or "").strip()
    company = (job.get("company") or "").strip()
    location = (job.get("location") or "").strip().split(",")[0]
    desc = job.get("description") or ""

    tried: list[str] = []
    channels: list[str] = []
    best_url, best_score, best_head = None, 0.0, ""

    def consider(u: str) -> tuple[float, bool] | None:
        """Fetch a candidate; return (overlap, headline-matches-title) or None.
        The headline matters because a search engine happily returns a big
        employer's *vacancies listing* whose text overlaps a lot with any of its
        jobs (Euronext's listing scored 0.79 for a Wonderful posting on
        06.09.2026), and because ATS pages such as jobbnorge render the text
        with JavaScript, so the overlap is ~0 although the headline is exact."""
        nonlocal best_url, best_score, best_head
        if u in tried or any(b in u.lower() for b in BLOCKED):
            return None
        tried.append(u)
        try:
            text, head = page_text_and_title(client, u)
        except Exception:
            return None
        if not text and not head:
            return None
        sc = overlap(desc, text)
        titled = title_matches(head, title)
        if verbose:
            print(f"      {sc:.2f}{'*' if titled else ' '} {u[:100]}")
        if sc > best_score:
            best_url, best_score, best_head = u, sc, head
        time.sleep(1.5)
        return sc, titled

    def accept(u: str, sc: float) -> dict:
        nonlocal best_url, best_score
        best_url, best_score = u, sc
        return done()

    def done() -> dict:
        return {"verdict": "match", "url": best_url, "score": best_score, "tried": tried, "channels": channels}

    # 1. the posting text itself — the employer wrote that link, a modest overlap is enough
    in_text = apply_url_from_text(desc)
    if in_text:
        channels.append("text")
        r = consider(in_text)
        if r and (r[0] >= 0.35 or r[1]):
            return accept(in_text, r[0])

    # 2. LinkedIn guest page: is there an employer form at all? (also refreshes the text)
    company_url = None
    probe = linkedin_guest_probe(client, job)
    if probe:
        channels.append("guest")
        company_url = probe.get("company_url")
        if probe["kind"] == "onsite":
            return {"verdict": "easy_apply", "url": None, "score": 0.0, "tried": tried, "channels": channels}
        if probe["kind"] == "closed":
            return {"verdict": "closed", "url": None, "score": 0.0, "tried": tried, "channels": channels}
        if not desc and probe.get("description"):
            desc = probe["description"]
        fresh = apply_url_from_text(probe.get("description") or "")
        if fresh and fresh != in_text:
            r = consider(fresh)
            if r and (r[0] >= 0.35 or r[1]):
                return accept(fresh, r[0])

    # 3. employer website → careers page → matching job link
    if company_url:
        cands = employer_site_candidates(client, company_url, title, company, verbose)
        if cands:
            channels.append("site")
            for u in cands:  # already on the employer's site or a known ATS
                r = consider(u)
                if r and (r[0] >= 0.50 or r[1]):
                    return accept(u, r[0])

    # 4. web search (SearxNG / CSE) — the metered channel, last
    queries = [f"{title} {company}".strip()]
    if location:
        queries.append(f"{title} {company} {location}".strip())
    queries.append(f"{company} karriere {title}".strip())
    queries.append(f'"{title[:80]}" {company}'.strip())
    for q in queries:
        raw, channel = web_search(client, q, verbose)
        if channel == "none":
            break
        channels.append(channel)
        for u in rank_candidates(raw, company)[:max_pages]:
            trusted = any(h in u.lower() for h in ATS_HINTS) or covers_company(u, company)
            if not trusted:
                continue  # an aggregator reposting the ad is never a form
            r = consider(u)
            if r and (r[0] >= 0.50 or r[1]):
                return accept(u, r[0])
        time.sleep(2.5)

    # Accepting a weak match is worse than accepting none: submitting is
    # irreversible, and a 0.53 overlap already produced a job aggregator
    # (getclera.com) rather than AutoStore's own ATS on 2026-07-29. Everything
    # that reached `best` above sits on the employer's site or a known ATS
    # (aggregators are skipped before fetching), so decent overlap is enough.
    if best_url and best_score >= 0.50:
        return done()
    if not channels:
        return {"verdict": "no_channel", "url": None, "score": best_score, "tried": tried, "channels": channels}
    return {"verdict": "miss", "url": None, "score": best_score, "tried": tried, "channels": channels}


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


def sweep_stale(db: Supa, dry_run: bool, hours: int) -> int:
    """Get unresolvable applications out of the queue instead of letting them pile up.

    Owner's rule (2026-07-29): if something cannot be resolved, skip it and move on.
    A row with no form URL is waiting on a search channel that may be down for days
    (Google's project is AUP-flagged, DuckDuckGo rate-limits), and a queue full of
    rows nobody can act on hides the ones that are actually workable.

    They are not deleted — manual_review keeps them visible and the Telegram card
    still works, so the owner can push any of them through by hand.
    """
    from datetime import datetime, timedelta, timezone as _tz

    cutoff = (datetime.now(_tz.utc) - timedelta(hours=hours)).isoformat()
    rows = db.get(
        "applications",
        select="id,created_at,jobs!inner(title,company,external_apply_url)",
        user_id=f"eq.{OWNER_USER_ID}",
        status="eq.pending_manual",
        created_at=f"lt.{cutoff}",
        **{"jobs.external_apply_url": "is.null"},
    )
    for r in rows:
        job = r.get("jobs") or {}
        print(f"  skip {r['id'][:8]} — {(job.get('company') or '?')[:20]} / {(job.get('title') or '')[:40]}")
        if not dry_run:
            db.patch(
                "applications",
                {
                    "status": "manual_review",
                    "error_message": (
                        f"ats-resolver: no form URL after {hours}h — skipped so the queue keeps moving; "
                        "confirm by hand from the Telegram card if you want it"
                    ),
                },
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
        "--skip-after-hours",
        type=int,
        default=None,  # resolved after load_env(): 24h normally, 0 with no channel
        help="a pending_manual row with no form URL older than this is moved out of "
        "the queue to manual_review, so an unresolvable job never blocks the rest",
    )
    ap.add_argument(
        "--reactivate",
        type=int,
        default=0,
        help="move up to N already-resolved manual_review rows back to pending_manual "
        "(this is what creates work for the agent — keep it small and deliberate)",
    )
    args = ap.parse_args()

    load_env()
    if args.skip_after_hours is None:
        # With no search channel configured, waiting a day changes nothing — sweep
        # on the next run instead of parking the row for 24h.
        # Keyless channels always exist now (2026-09-06), so a row gets its
        # attempt within a few runs — the sweep is only for what nothing could fix.
        args.skip_after_hours = int(os.environ.get("RESOLVER_SKIP_AFTER_HOURS", "24"))
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

    skipped = sweep_stale(db, args.dry_run, args.skip_after_hours)
    if skipped:
        print(f"skipped (no form URL, out of the queue): {skipped}")

    if not search_available():
        # The keyless channels (posting text, LinkedIn guest page, employer site)
        # run regardless; only the search-engine step is missing.
        print("no web-search channel configured (SEARX_URL / Google CSE) — keyless channels only")

    apps = pick_jobs(db, args.limit, args.statuses)
    cse_cap = int(os.environ.get("CSE_DAILY_CAP", "80"))
    print(f"candidates: {len(apps)} | cse budget left today: {quota_left('cse', cse_cap)}/{cse_cap}")
    client = httpx.Client(follow_redirects=True)
    found = missed = blocked = no_form = 0

    for app in apps:
        job = app["jobs"]
        print(f"\n[{job.get('company')}] {job.get('title')}  (app {app['id'][:8]})")
        res = resolve_one(client, job, args.max_pages, args.verbose)
        verdict, url, score, tried = res["verdict"], res["url"], res["score"], res["tried"]
        via = "+".join(dict.fromkeys(res["channels"])) or "none"
        if verdict == "no_channel":
            # Nothing at all could be consulted. This says nothing about the job, so
            # it must not be marked as unresolvable — that note is permanent.
            blocked += 1
            print("  SKIP  no channel answered, leaving the row untouched")
            continue
        if verdict == "easy_apply":
            # LinkedIn Easy Apply only: no employer form exists and we never log in.
            no_form += 1
            print("  EASY  LinkedIn Easy Apply only — no external form, out of the queue")
            if not args.dry_run:
                db.patch("jobs", {"application_form_type": FORM_EASY_APPLY}, id=f"eq.{job['id']}")
                db.patch(
                    "applications",
                    {"status": "manual_review",
                     "error_message": "ats-resolver: LinkedIn Easy Apply only — no employer form; apply by hand via LinkedIn if wanted"},
                    id=f"eq.{app['id']}",
                )
            continue
        if verdict == "closed":
            no_form += 1
            print("  GONE  posting no longer accepts applications")
            if not args.dry_run:
                db.patch("jobs", {"application_form_type": FORM_CLOSED}, id=f"eq.{job['id']}")
                db.patch(
                    "applications",
                    {"status": "rejected", "error_message": "ats-resolver: LinkedIn posting closed (no apply button any more)"},
                    id=f"eq.{app['id']}",
                )
            continue
        if url:
            found += 1
            print(f"  MATCH {score:.2f} via {via} -> {url}")
            if not args.dry_run:
                db.patch(
                    "jobs",
                    {"external_apply_url": url, "application_form_type": "external_form"},
                    id=f"eq.{job['id']}",
                )
        else:
            missed += 1
            hosts = ", ".join(sorted({urllib.parse.urlparse(t).netloc for t in tried})[:6]) or "no candidates"
            note = f"ats-resolver: no external form; best={score:.2f}; via {via}; searched: {hosts}"
            print(f"  MISS  {score:.2f}  via {via} ({hosts})")
            if not args.dry_run:
                # Searched properly and found nothing — out of the queue, not left
                # to be retried forever. The card stays live for a manual push.
                db.patch(
                    "applications",
                    {"error_message": note, "status": "manual_review"},
                    id=f"eq.{app['id']}",
                )

    summary = f"🔎 ATS-resolver: {found} знайдено, {missed} без форми (з {len(apps)})"
    if promoted:
        summary = f"📥 У чергу на заповнення: {promoted}\n" + summary
    if skipped:
        summary += f"\n⏭ Пропущено (немає адреси форми, {args.skip_after_hours}год): {skipped}"
    if no_form:
        summary += f"; {no_form} без форми взагалі (Easy Apply / закрито)"
    if blocked:
        summary += f"; {blocked} відкладено — жоден канал не відповів"
    print("\n" + summary)
    if not args.dry_run and apps:
        tech_notify(summary)


if __name__ == "__main__":
    main()

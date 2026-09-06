"""
linkedin_guest.py — what LinkedIn's *guest* (logged-out) pages still tell us.

Measured 2026-09-06 on 30 live postings (score >= 50) with no login at all:
20 had an employer form ("offsite"), 3 were Easy Apply only ("onsite"), 7 had no
apply button any more (closed). The guest page marks the kind of apply button
with a tracking name, but the employer's URL itself is hidden behind a sign-in
modal — it is NOT in the HTML, neither on /jobs/view/<id> nor on
/jobs-guest/jobs/api/jobPosting/<id>. So:

  * the kind of button is free and safe to read (one anonymous GET, same as the
    scraper already does for the description);
  * the form URL has to come from somewhere else: the posting text itself
    (9 % of postings link their ATS in the description), the employer's website
    (the guest *company* page exposes it under "Nettsted"), or a search engine.
    All of that lives in ats_resolver.py; this module only parses.

Nothing here logs in, stores cookies or touches an authenticated endpoint —
the owner's rule "never automate a LinkedIn login" stands.
"""

import re
import urllib.parse
from typing import Optional

from bs4 import BeautifulSoup

GUEST_HEADERS = {
    'User-Agent': (
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
        '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    ),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'nb-NO,nb;q=0.9,en;q=0.5',
}

# application_form_type values written for LinkedIn rows
FORM_EASY_APPLY = 'linkedin_easy_apply'   # onsite only: no employer form exists
FORM_EXTERNAL_PENDING = 'linkedin_external'  # employer form exists, URL still unknown
FORM_EXTERNAL = 'external_form'           # employer form with a known URL
FORM_CLOSED = 'closed'                    # posting no longer accepts applications

# Hosts that are never an application form even when a posting links to them.
NOT_A_FORM = (
    'linkedin.com', 'lnkd.in', 'licdn.com', 'finn.no', 'nav.no', 'indeed.', 'glassdoor.',
    'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'youtube.com', 'youtu.be',
    'tiktok.com', 'google.com', 'goo.gl', 'bit.ly', 'ow.ly', 'jobbsafari.', 'karrierestart.no',
    'wikipedia.org', 'vimeo.com', 'maps.app', 'apple.com', 'play.google',
)


def guest_job_url(job_id: str) -> str:
    return f"https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{job_id}"


def job_id_from_url(url: str) -> Optional[str]:
    m = re.search(r'/jobs/view/(?:[^/]*-)?(\d{6,})', url or '')
    return m.group(1) if m else None


def classify_guest_page(html: str) -> dict:
    """Read a guest job page. Returns
        kind:         'offsite' | 'onsite' | 'closed' | 'unknown'
        title:        posting title (None when the page is not a posting at all)
        company_url:  https://www.linkedin.com/company/<slug> or None
        description:  plain text of the posting
    'unknown' means the page did not render as a posting (auth wall, 999, empty)
    — never treat it as closed.
    """
    soup = BeautifulSoup(html or '', 'html.parser')
    title_el = soup.find(class_=re.compile(r'top-card-layout__title|topcard__title'))
    title = title_el.get_text(strip=True) if title_el else None

    desc_el = soup.find('div', class_='show-more-less-html__markup') or \
        soup.find('div', class_='description__text')
    description = desc_el.get_text(' ', strip=True) if desc_el else ''

    company_url = None
    org = soup.find(attrs={'data-tracking-control-name': re.compile(r'topcard-org-name|topcard_org')})
    if org and org.get('href'):
        href = org['href'].split('?')[0]
        m = re.search(r'linkedin\.com/company/([^/?#]+)', href)
        if m:
            company_url = f"https://www.linkedin.com/company/{m.group(1)}"

    if 'public_jobs_apply-link-onsite' in html:
        kind = 'onsite'
    elif 'public_jobs_apply-link-offsite' in html:
        kind = 'offsite'
    elif title and description:
        # A real posting with no apply control at all: LinkedIn shows exactly this
        # once the employer stops accepting applications.
        kind = 'closed'
    else:
        kind = 'unknown'
    return {'kind': kind, 'title': title, 'company_url': company_url, 'description': description}


def form_type_for(kind: str, external_url: Optional[str]) -> Optional[str]:
    """Map a guest-page classification to jobs.application_form_type."""
    if kind == 'onsite':
        return FORM_EASY_APPLY
    if kind == 'closed':
        return FORM_CLOSED
    if kind == 'offsite':
        return FORM_EXTERNAL if external_url else FORM_EXTERNAL_PENDING
    return FORM_EXTERNAL if external_url else None


_URL_RE = re.compile(r'https?://[^\s<>"\')\]]+', re.I)


def apply_url_from_text(text: str) -> Optional[str]:
    """First URL in the posting text that can plausibly be an application form.

    Employers who post on LinkedIn without paying for offsite apply often write
    "søk her: https://…" in the description. Aggregators, social links and
    LinkedIn's own domains are ignored; the caller still verifies the page.
    """
    for raw in _URL_RE.findall(text or ''):
        url = raw.rstrip('.,;:!?)')
        host = urllib.parse.urlparse(url).netloc.lower()
        if not host or any(b in host for b in NOT_A_FORM):
            continue
        path = urllib.parse.urlparse(url).path.lower()
        # a bare homepage is not a form; deeper paths or ATS hosts are worth a look
        if path in ('', '/') and not re.search(r'karriere|career|jobb|job|stilling', host):
            continue
        return url
    return None


def company_website_from_guest_page(html: str) -> Optional[str]:
    """The employer's own website as shown on the guest company page ("Nettsted")."""
    soup = BeautifulSoup(html or '', 'html.parser')
    a = soup.find('a', attrs={'data-tracking-control-name': re.compile(r'about_website')})
    if a and a.get('href'):
        href = a['href']
        # LinkedIn may wrap it in a redirector: https://www.linkedin.com/redir/redirect?url=…
        m = re.search(r'[?&]url=([^&]+)', href)
        if 'linkedin.com/redir' in href and m:
            href = urllib.parse.unquote(m.group(1))
        host = urllib.parse.urlparse(href).netloc.lower()
        if host and 'linkedin.com' not in host:
            return href.split('?')[0].rstrip('/')
    return None

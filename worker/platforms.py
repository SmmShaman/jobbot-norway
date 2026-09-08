#!/usr/bin/env python3
"""
platforms.py — the platform registry and the cheap pre-check that runs BEFORE an
application is handed to the fill agent.

WHY (owner's rule, 2026-09-08)
------------------------------
"Спочатку визначити: чи відома платформа, чи можна залогінитися, чи немає там
капчі — і лише потім щось заповнювати." Until now the queue learned all of that
the expensive way: the agent woke up (~6.8M tokens for a brand-new ATS), ran
recon, and only then met the reCAPTCHA (Enode/Ashby 07.09), the LinkedIn-only
sign-up (Dex 06.09) or the Turnstile wall (Kahoot 31.07). And knowledge was keyed
by HOST, so Teamtailor at nofence.teamtailor.com counted as "unknown" although
karriere.frend.no (also Teamtailor) had already been scripted and SENT.

WHAT
----
1. ENGINES: form engines recognised by host suffix and/or page markers. Each engine
   lists the form-scripts directories that implement it, so a new employer host on
   a known engine reuses the existing fill.mjs instead of a new recon.
2. BLOCKED: hosts/paths the agent must never be woken for, with the reason and
   the date it was learned. A negative result is worth caching (CACHE.md).
3. probe(url): one HTTP GET with browser headers. Verdicts:
     ready    — engine known AND a form-scripts dir exists for it
     unknown  — reachable, no knowledge yet (goes through the recon budget as before)
     blocked  — registry says so, or the page is a bot wall (Vercel/Cloudflare
                challenge), an e-mail-only "form", or an OAuth-only sign-up
     dead     — 404/410/connection error
   plus captcha_suspected=True when a captcha script is loaded on the page (not
   blocking by itself — contact forms load it too — but the agent checks it first).

The verdict is stored on applications.skyvern_metadata.platform (merged, never
replaced) by ats_resolver.promote_ready; the fill gate reads platform.cache_dir.
Registry-only classification (no HTTP) is `classify(url)`; analyze_worker uses it
to keep blocked platforms out of the queue at card time.
"""

import os
import re
import time
import urllib.parse
from datetime import datetime, timezone
from typing import Optional

import httpx

FORM_CACHE_DIR = os.environ.get('FORM_CACHE_DIR', '/home/stuar/nanoclaw-v2/groups/jobbot/form-scripts')

BROWSER_HEADERS = {
    'User-Agent': ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
                   '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'),
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'nb-NO,nb;q=0.9,en;q=0.5',
}

# engine -> host suffixes, html markers, form-scripts dirs that implement it.
# dirs are tried in order; the first one present in FORM_CACHE_DIR wins.
ENGINES: dict[str, dict] = {
    'teamtailor': {
        'hosts': ('teamtailor.com',),
        'markers': ('teamtailor-cdn.com', 'Karriereside av Teamtailor', 'data-teamtailor'),
        'dirs': ('karriere.frend.no', 'jobb.humananorge.no', 'careers-no.fortedigital.com'),
    },
    'reachmee': {
        'hosts': ('reachmee.com',),
        'markers': ('reachmee.com', 'rmpage=apply', 'id="riframe"'),
        'dirs': ('attract.reachmee.com', 'www.rema.no', 'tess.no'),
    },
    'recman': {
        'hosts': ('recman.page', 'recman.no'),
        'markers': ('recman.page', 'recman.no/'),
        'dirs': ('recman.page',),
    },
    'easycruit': {'hosts': ('easycruit.com',), 'markers': ('easycruit',), 'dirs': ('easycruit.com',)},
    'webcruiter': {'hosts': ('webcruiter.com',), 'markers': ('webcruiter',), 'dirs': ('candidate.webcruiter.com',)},
    'jobbnorge': {'hosts': ('jobbnorge.no',), 'markers': ('jobbnorge',), 'dirs': ('www.jobbnorge.no', 'jobbnorge.no')},
    'workday': {'hosts': ('myworkdayjobs.com', 'myworkdaysite.com'), 'markers': ('myworkdayjobs',), 'dirs': ('myworkdayjobs.com',)},
    'ashby': {'hosts': ('ashbyhq.com',), 'markers': ('ashbyhq',), 'dirs': ('jobs.ashbyhq.com',)},
    'lever': {'hosts': ('lever.co',), 'markers': ('lever.co',), 'dirs': ('jobs.lever.co',)},
    'greenhouse': {'hosts': ('greenhouse.io',), 'markers': ('greenhouse.io',), 'dirs': ('boards.greenhouse.io',)},
    'workable': {'hosts': ('workable.com',), 'markers': ('workable.com',), 'dirs': ('apply.workable.com',)},
    'hr-manager': {'hosts': ('hr-manager.net',), 'markers': ('hr-manager.net',), 'dirs': ('candidate.hr-manager.net',)},
    'jobylon': {'hosts': ('jobylon.com',), 'markers': ('jobylon',), 'dirs': ('jobylon.com',)},
    'varbi': {'hosts': ('varbi.com',), 'markers': ('varbi',), 'dirs': ('varbi.com',)},
    'cornerstone': {'hosts': ('csod.com',), 'markers': ('csod.com',), 'dirs': ('csod.com',)},
    'successfactors': {'hosts': ('successfactors.com', 'successfactors.eu'), 'markers': ('successfactors',), 'dirs': ('successfactors.com',)},
    'nuu': {'hosts': ('nuu.no',), 'markers': ('nuu.no',), 'dirs': ('nuu.no',)},
    'finn': {'hosts': ('finn.no',), 'markers': (), 'dirs': ('finn.no',)},
    'strawberry': {'hosts': ('strawberryhotels.com',), 'markers': (), 'dirs': ('jobs.strawberryhotels.com',)},
}

# Never wake the agent for these. (host suffix, path prefix or '') -> reason.
# Dated so the next session knows how fresh the verdict is.
BLOCKED: list[tuple[str, str, str]] = [
    ('linkedin.com', '', 'LinkedIn: the bot never logs in (owner rule 06.09.2026)'),
    ('app.meetdex.ai', '', 'sign-up only via LinkedIn OAuth — never automated (06.09.2026)'),
    ('jobs.meetdex.ai', '', 'sign-up only via LinkedIn OAuth — never automated (06.09.2026)'),
    ('jobs.ashbyhq.com', '/enode/', 'Ashby form for Enode blocks submit with reCAPTCHA (07.09.2026); never bypassed'),
    ('apply.workable.com', '/kahoot/', 'Cloudflare Turnstile CAPTCHA on Kahoot Workable form (31.07.2026)'),
    ('app.vilect.com', '', 'e-mail-only "form", no web form (CACHE.md); e-mail applications are not automated'),
    ('nav.no', '', 'NAV page is the posting, not a form'),
    ('finn.no', '/job/apply', 'FINN Enkel søknad: account CAPTCHA-gated login (04.09.2026), strategy manual_review in finn.no profile'),
]

BOT_WALL_MARKERS = (
    'Vercel Security Checkpoint', 'challenges.cloudflare.com', 'cf-chl-', 'Just a moment...',
    'Attention Required! | Cloudflare', 'Access denied | ', 'Pardon Our Interruption',
)
CAPTCHA_MARKERS = ('www.google.com/recaptcha', 'recaptcha/api.js', 'hcaptcha.com/1/api.js',
                   'challenges.cloudflare.com/turnstile', 'grecaptcha')
OAUTH_ONLY_MARKERS = ('Sign in with LinkedIn to apply', 'Continue with LinkedIn to apply', 'Apply with LinkedIn to')


def host_of(url: str) -> str:
    try:
        return (urllib.parse.urlparse(url or '').hostname or '').lower().removeprefix('www.')
    except Exception:
        return ''


def _suffix(host: str, base: str) -> bool:
    base = base.removeprefix('www.')
    return bool(host) and (host == base or host.endswith('.' + base))


def engine_for(url: str, html: str = '') -> Optional[str]:
    host = host_of(url)
    for name, spec in ENGINES.items():
        if any(_suffix(host, h) for h in spec['hosts']):
            return name
    if html:
        low = html[:400_000]
        for name, spec in ENGINES.items():
            if any(m in low for m in spec['markers'] if len(m) > 6):
                return name
    return None


def cached_dirs() -> list[str]:
    if not os.path.isdir(FORM_CACHE_DIR):
        return []
    return sorted(d for d in os.listdir(FORM_CACHE_DIR)
                  if os.path.isdir(os.path.join(FORM_CACHE_DIR, d)) and not d.startswith('_'))


def dir_for_host(host: str, dirs: Optional[list[str]] = None) -> Optional[str]:
    """The form-scripts dir that covers this host by suffix (the gate's own rule)."""
    for d in (dirs if dirs is not None else cached_dirs()):
        if _suffix(host, d):
            return d
    return None


def cache_dir_for(url: str, engine: Optional[str], dirs: Optional[list[str]] = None) -> Optional[str]:
    """Host match first (the agent's own knowledge of exactly this site), then any
    dir that implements the same engine."""
    dirs = dirs if dirs is not None else cached_dirs()
    own = dir_for_host(host_of(url), dirs)
    if own:
        return own
    if engine:
        for d in ENGINES[engine]['dirs']:
            if d in dirs:
                return d
    return None


def blocked_reason(url: str) -> Optional[str]:
    host = host_of(url)
    path = (urllib.parse.urlparse(url or '').path or '/').lower()
    for h, prefix, reason in BLOCKED:
        if _suffix(host, h) and (not prefix or path.startswith(prefix)):
            return reason
    return None


def classify(url: str) -> dict:
    """Registry-only verdict, no network. Used at card time."""
    engine = engine_for(url)
    reason = blocked_reason(url)
    cache = cache_dir_for(url, engine)
    if reason:
        status = 'blocked'
    elif cache:
        status = 'ready'
    else:
        status = 'unknown'
    return {'engine': engine, 'host': host_of(url), 'status': status, 'reason': reason, 'cache_dir': cache}


def probe(url: str, client: Optional[httpx.Client] = None, timeout: float = 25.0) -> dict:
    """Registry + one GET. Never raises."""
    out = classify(url)
    out.update({'final_url': url, 'http': None, 'captcha_suspected': False,
                'probed_at': datetime.now(timezone.utc).isoformat(timespec='seconds')})
    if out['status'] == 'blocked':
        return out
    own = client is None
    c = client or httpx.Client(follow_redirects=True)
    html = ''
    try:
        r = c.get(url, headers=BROWSER_HEADERS, timeout=timeout)
        out['http'] = r.status_code
        out['final_url'] = str(r.url)
        html = r.text or ''
    except Exception as e:
        out.update({'status': 'dead', 'reason': f'no answer: {type(e).__name__}'})
        return out
    finally:
        if own:
            c.close()

    if out['http'] in (404, 410):
        out.update({'status': 'dead', 'reason': f'HTTP {out["http"]}'})
        return out
    # A redirect can land on a different host (marketing page -> ATS). Re-classify.
    if host_of(out['final_url']) != out['host']:
        again = classify(out['final_url'])
        out.update({k: again[k] for k in ('engine', 'host', 'cache_dir')})
        if again['status'] == 'blocked':
            out.update({'status': 'blocked', 'reason': again['reason']})
            return out
    if not out['engine']:
        out['engine'] = engine_for(out['final_url'], html)
        out['cache_dir'] = cache_dir_for(out['final_url'], out['engine'])
    if any(m in html for m in BOT_WALL_MARKERS) or out['http'] in (403, 503):
        out.update({'status': 'blocked', 'reason': f'bot wall on {out["host"]} (HTTP {out["http"]}); try the ATS page instead of the marketing site'})
        return out
    if any(m in html for m in OAUTH_ONLY_MARKERS):
        out.update({'status': 'blocked', 'reason': 'apply only via LinkedIn sign-in'})
        return out
    out['captcha_suspected'] = any(m in html for m in CAPTCHA_MARKERS)
    if re.search(r'mailto:[^"\']+', html) and not re.search(r'<form[\s>]', html, re.I) and not out['engine']:
        out.update({'status': 'blocked', 'reason': 'page offers only a mailto: link, no web form'})
        return out
    out['status'] = 'ready' if out['cache_dir'] else 'unknown'
    return out


if __name__ == '__main__':
    import json
    import sys
    for u in sys.argv[1:]:
        print(json.dumps(probe(u), ensure_ascii=False))
        time.sleep(1)

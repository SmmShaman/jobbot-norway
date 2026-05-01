"""
LinkedIn Job Scraper - Guest API (no login required).
Runs from local worker machine to avoid datacenter IP blocking.
Called by auto_apply.py or standalone.
"""

import asyncio
import os
import re
import httpx
from bs4 import BeautifulSoup
from datetime import datetime, timezone
from dotenv import load_dotenv
from supabase import create_client, Client

load_dotenv()

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY")

supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'nb-NO,nb;q=0.9,en;q=0.5'
}


def normalize_for_dedup(text: str) -> str:
    """Normalize text for cross-source deduplication."""
    return re.sub(r'[^a-zæøå0-9\s]', '', (text or '').lower()).strip()


async def scrape_linkedin_jobs(keyword: str, location: str = "Norway", max_results: int = 25) -> list:
    """Scrape LinkedIn Guest API for job listings."""
    url = (
        f"https://www.linkedin.com/jobs-guest/jobs/api/seeMoreJobPostings/search"
        f"?keywords={keyword}&location={location}&f_TPR=r86400&sortBy=DD&start=0"
    )

    jobs = []
    async with httpx.AsyncClient() as client:
        resp = await client.get(url, headers=HEADERS, timeout=15.0)
        if resp.status_code != 200:
            print(f"⚠️ LinkedIn returned {resp.status_code}")
            return []

        soup = BeautifulSoup(resp.text, 'html.parser')
        cards = soup.find_all('div', class_='base-search-card')

        for card in cards[:max_results]:
            # Extract URL
            link_el = card.find('a', class_='base-card__full-link')
            if not link_el:
                continue
            raw_url = link_el.get('href', '')
            job_url = raw_url.split('?')[0].strip()
            if not job_url:
                continue

            # Extract job ID
            job_id_match = re.search(r'/jobs/view/[^/]*?(\d+)', job_url)
            if not job_id_match:
                continue

            # Normalize URL
            job_id = job_id_match.group(1)
            job_url = f"https://www.linkedin.com/jobs/view/{job_id}"

            # Extract title
            title_el = card.find('h3', class_='base-search-card__title')
            title = title_el.get_text(strip=True) if title_el else ''
            if not title:
                continue

            # Extract company
            company_el = card.find('h4', class_='base-search-card__subtitle')
            company = company_el.get_text(strip=True) if company_el else 'Unknown Company'

            # Extract location
            loc_el = card.find('span', class_='job-search-card__location')
            location_text = loc_el.get_text(strip=True) if loc_el else 'Norway'

            # Extract posted date
            time_el = card.find('time')
            posted_date = time_el.get('datetime', '') if time_el else ''

            jobs.append({
                'job_url': job_url,
                'title': title,
                'company': company,
                'location': location_text,
                'source': 'LINKEDIN',
                'status': 'NEW',
                'posted_date': posted_date,
                'linkedin_job_id': job_id
            })

    return jobs


async def fetch_job_description(job_id: str) -> dict:
    """Fetch full job description from LinkedIn Guest API."""
    url = f"https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/{job_id}"

    async with httpx.AsyncClient() as client:
        resp = await client.get(url, headers=HEADERS, timeout=15.0)
        if resp.status_code != 200:
            return {}

        soup = BeautifulSoup(resp.text, 'html.parser')

        # Extract description
        desc_el = soup.find('div', class_='show-more-less-html__markup') or \
                  soup.find('div', class_='description__text')
        description = desc_el.get_text(strip=True) if desc_el else ''

        # Extract apply URL (external link if exists)
        apply_el = soup.find('a', class_='apply-button') or \
                   soup.find('a', attrs={'href': re.compile(r'applyUrl|externalApply')})
        apply_url = apply_el.get('href', '') if apply_el else ''

        # Clean apply URL
        if apply_url and 'linkedin.com' not in apply_url:
            apply_url = apply_url.split('?')[0]
        else:
            apply_url = ''

        return {
            'description': description[:5000] if description else '',
            'external_apply_url': apply_url,
            'application_form_type': 'external_form' if apply_url else 'linkedin_easy_apply'
        }


async def scan_linkedin_for_user(user_id: str) -> dict:
    """Run LinkedIn scan for a specific user. Returns stats."""
    # Get user settings
    settings = supabase.table('user_settings') \
        .select('linkedin_search_terms, linkedin_scan_enabled, linkedin_location, telegram_chat_id') \
        .eq('user_id', user_id).single().execute()

    if not settings.data:
        return {'error': 'No settings found'}

    s = settings.data
    if not s.get('linkedin_scan_enabled'):
        return {'skipped': True, 'reason': 'LinkedIn disabled'}

    terms = s.get('linkedin_search_terms', [])
    if not terms:
        return {'skipped': True, 'reason': 'No search terms'}

    location = s.get('linkedin_location', 'Norway')
    chat_id = s.get('telegram_chat_id')

    # Check last scan time (max 2x/day)
    last_scan = supabase.table('system_logs') \
        .select('created_at') \
        .eq('user_id', user_id) \
        .eq('event_type', 'SCAN') \
        .like('message', '%LinkedIn%') \
        .order('created_at', desc=True).limit(1).execute()

    if last_scan.data:
        import re as _re
        _ts = last_scan.data[0]['created_at']
        _ts = _re.sub(r'[+-]\d{2}:\d{2}$|Z$', '', _ts)  # strip tz offset (Python 3.10 compat)
        _ts = _re.sub(r'\.(\d+)$', lambda m: '.' + m.group(1)[:6].ljust(6, '0'), _ts)  # normalize microseconds
        hours_since = (datetime.now(timezone.utc) -
                       datetime.fromisoformat(_ts).replace(tzinfo=timezone.utc)).total_seconds() / 3600
        if hours_since < 10:
            return {'skipped': True, 'reason': f'Last scan {hours_since:.1f}h ago'}

    # Get existing jobs for dedup
    from datetime import timedelta
    thirty_days_ago = (datetime.now(timezone.utc) - timedelta(days=30)).isoformat()
    recent = supabase.table('jobs') \
        .select('title, company, job_url') \
        .eq('user_id', user_id) \
        .gte('created_at', thirty_days_ago).execute()

    existing_urls = set(j['job_url'] for j in (recent.data or []))
    existing_keys = set(
        f"{normalize_for_dedup(j['company'])}||{normalize_for_dedup(j['title'])}"
        for j in (recent.data or [])
    )

    total_found = 0
    total_new = 0

    # Notify via Telegram
    if chat_id:
        tg_token = os.getenv('TELEGRAM_BOT_TOKEN', '')
        if tg_token:
            async with httpx.AsyncClient() as client:
                await client.post(
                    f"https://api.telegram.org/bot{tg_token}/sendMessage",
                    json={
                        "chat_id": chat_id,
                        "text": f"🟣 <b>LinkedIn сканування...</b>\n📍 {location}\n🔎 {', '.join(terms)}",
                        "parse_mode": "HTML"
                    }, timeout=10.0
                )

    for term in terms:
        print(f"🟣 LinkedIn: searching '{term}' in {location}...")
        jobs = await scrape_linkedin_jobs(term, location)
        total_found += len(jobs)
        print(f"   Found: {len(jobs)} jobs")

        # Filter duplicates
        new_jobs = []
        for j in jobs:
            if j['job_url'] in existing_urls:
                continue
            key = f"{normalize_for_dedup(j['company'])}||{normalize_for_dedup(j['title'])}"
            if key in existing_keys:
                continue
            new_jobs.append(j)
            existing_urls.add(j['job_url'])
            existing_keys.add(key)

        print(f"   New (after dedup): {len(new_jobs)}")

        if new_jobs:
            # Insert jobs (without posted_date and linkedin_job_id)
            to_insert = []
            for j in new_jobs:
                to_insert.append({
                    'job_url': j['job_url'],
                    'title': j['title'],
                    'company': j['company'],
                    'location': j['location'],
                    'source': 'LINKEDIN',
                    'status': 'NEW',
                    'user_id': user_id
                })
            supabase.table('jobs').insert(to_insert).execute()
            total_new += len(new_jobs)

            # Fetch descriptions for new jobs
            for j in new_jobs:
                try:
                    details = await fetch_job_description(j['linkedin_job_id'])
                    if details:
                        updates = {}
                        if details.get('description'):
                            updates['description'] = details['description']
                        if details.get('external_apply_url'):
                            updates['external_apply_url'] = details['external_apply_url']
                        if details.get('application_form_type'):
                            updates['application_form_type'] = details['application_form_type']
                        if updates:
                            supabase.table('jobs').update(updates) \
                                .eq('job_url', j['job_url']).eq('user_id', user_id).execute()
                    await asyncio.sleep(2)  # Rate limit
                except Exception as e:
                    print(f"   ⚠️ Detail fetch failed: {e}")

        # Telegram notification per term
        if chat_id:
            tg_token = os.getenv('TELEGRAM_BOT_TOKEN', '')
            if tg_token:
                async with httpx.AsyncClient() as client:
                    await client.post(
                        f"https://api.telegram.org/bot{tg_token}/sendMessage",
                        json={
                            "chat_id": chat_id,
                            "text": f"🟣 <b>LinkedIn \"{term}\":</b>\n   📋 Знайдено: {len(jobs)}\n   🔄 Дублікати: {len(jobs) - len(new_jobs)}\n   🆕 Нових: {len(new_jobs)}",
                            "parse_mode": "HTML"
                        }, timeout=10.0
                    )

        await asyncio.sleep(3)  # Rate limit between terms

    # Log scan
    supabase.table('system_logs').insert({
        'user_id': user_id,
        'event_type': 'SCAN',
        'status': 'SUCCESS',
        'message': f'LinkedIn scan: {total_found} found, {total_new} new',
        'details': {'linkedin': True, 'terms': terms, 'found': total_found, 'inserted': total_new},
        'source': 'LINKEDIN'
    }).execute()

    print(f"🟣 LinkedIn done: {total_found} found, {total_new} new")
    return {'found': total_found, 'new': total_new}


async def scan_all_users():
    """Scan LinkedIn for all users with linkedin_scan_enabled."""
    users = supabase.table('user_settings') \
        .select('user_id') \
        .eq('linkedin_scan_enabled', True).execute()

    for u in (users.data or []):
        result = await scan_linkedin_for_user(u['user_id'])
        print(f"User {u['user_id'][:8]}: {result}")


if __name__ == '__main__':
    asyncio.run(scan_all_users())

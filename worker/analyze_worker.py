#!/usr/bin/env python3
"""
Analyze Worker - анализирует вакансии через Gemini API
Запускается через GitHub Actions после scheduled-scanner

Использование:
    python analyze_worker.py              # Анализировать все непроанализированные
    python analyze_worker.py --limit 50   # Лимит вакансий
    python analyze_worker.py --user UUID  # Только для конкретного юзера
"""

import os
import sys
import json
import asyncio
import argparse
from datetime import datetime
from typing import Optional

import httpx
from dotenv import load_dotenv
from supabase import create_client, Client

# Load .env for local development
load_dotenv()

# Configuration
SUPABASE_URL = os.environ.get('SUPABASE_URL')
SUPABASE_KEY = os.environ.get('SUPABASE_SERVICE_KEY')
GEMINI_API_KEY = os.environ.get('GEMINI_API_KEY')
GEMINI_MODEL = 'gemini-2.5-pro'
TELEGRAM_TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN')
TELEGRAM_TECH_TOKEN = os.environ.get('TELEGRAM_TECH_BOT_TOKEN')

# Pricing (Gemini 2.5 Pro - approximate)
PRICE_INPUT = 1.25 / 1_000_000   # $1.25 per 1M tokens
PRICE_OUTPUT = 10.00 / 1_000_000  # $10.00 per 1M tokens

# Aura color mapping
AURA_COLORS = {
    'Toxic': '#ef4444',
    'Growth': '#22c55e',
    'Balanced': '#3b82f6',
    'Chill': '#06b6d4',
    'Grind': '#a855f7',
    'Neutral': '#6b7280'
}

# Language code to full name mapping (must match job-analyzer/index.ts)
LANG_MAP = {
    'uk': 'Ukrainian',
    'no': 'Norwegian (Bokmål)',
    'en': 'English'
}

# Default analysis prompt
DEFAULT_ANALYSIS_PROMPT = """You are a Vibe & Fit Scanner for Recruitment.

TASK:
1. Analyze how well the candidate fits this job.
2. Provide a Relevance Score (0-100).
3. AURA SCAN: Detect the "vibe" of the job description.
4. RADAR METRICS: Rate the job on 5 specific axes (0-100).
5. EXTRACT TASKS: List specifically what the candidate needs to DO (duties/responsibilities).
6. EXTRACT REQUIREMENTS: List qualifications, skills, experience the employer requires.
7. EXTRACT OFFERS: List what the company offers (benefits, salary, perks, work conditions).

CANDIDATE EVALUATION RULES (CRITICAL):
- The candidate may have a DIVERSE career spanning multiple fields and decades.
- You MUST consider ALL work experience listed in the profile — not just recent roles.
- Old experience (even 10-20+ years ago) is STILL RELEVANT if it matches the job requirements.
- Examples: teaching experience matters for education jobs, management experience matters for leader roles, military/security experience matters for safety roles, economics background matters for finance roles.
- Do NOT bias the score toward the candidate's most recent or most prominent career track.
- Match the SPECIFIC job requirements against the ENTIRE profile — find the best-fitting experience from ANY period.
- Education and certifications from any period are always relevant.
- Transferable skills (leadership, communication, planning, budgeting) apply across fields.

SCORING GUIDELINES:
- 70-100: Strong match — candidate has direct experience or education in this field
- 50-69: Moderate match — candidate has transferable skills or partial experience
- 30-49: Weak match — some overlap but significant gaps
- 0-29: Poor match — very little relevant experience

ANALYSIS FORMAT (CRITICAL):
The "analysis" field MUST use this EXACT structure — cons FIRST, then pros:
❌ Мінуси:
- [specific con about candidate fit]
- [another con]

✅ Плюси:
- [specific pro about candidate fit]
- [another pro]

Write 2-5 bullet points for each section. Always include BOTH sections even if one side is weak.
When listing pros, explicitly reference the SPECIFIC role/period from the candidate's history that is relevant.
If the target language is Norwegian, use "❌ Ulemper:" and "✅ Fordeler:".
If the target language is English, use "❌ Cons:" and "✅ Pros:".

OUTPUT FORMAT (JSON ONLY):
{
  "score": number (0-100),
  "analysis": "string (structured cons/pros format as described above)",
  "tasks": "string (bullet point list of duties/responsibilities)",
  "requirements": "string (bullet point list of required qualifications)",
  "offers": "string (bullet point list of what the company offers)",
  "aura": {
    "status": "Toxic" | "Growth" | "Balanced" | "Chill" | "Grind" | "Neutral",
    "color": "#hex color code",
    "tags": ["string", "string"],
    "explanation": "short reason for aura"
  },
  "radar": {
    "tech_stack": number (0-100),
    "soft_skills": number (0-100),
    "culture": number (0-100),
    "salary_potential": number (0-100),
    "career_growth": number (0-100)
  }
}"""


def validate_config():
    """Validate required environment variables"""
    missing = []
    if not SUPABASE_URL:
        missing.append('SUPABASE_URL')
    if not SUPABASE_KEY:
        missing.append('SUPABASE_SERVICE_KEY')
    if not GEMINI_API_KEY:
        missing.append('GEMINI_API_KEY')

    if missing:
        print(f"❌ Missing environment variables: {', '.join(missing)}")
        sys.exit(1)


def validate_aura(aura: Optional[dict]) -> Optional[dict]:
    """Validate and fix aura data"""
    if not aura or not aura.get('status'):
        return None

    # Ensure color is valid
    if not aura.get('color', '').startswith('#'):
        aura['color'] = AURA_COLORS.get(aura['status'], AURA_COLORS['Neutral'])

    # Ensure tags is array
    if not isinstance(aura.get('tags'), list):
        aura['tags'] = []

    return aura


def validate_radar(radar: Optional[dict]) -> Optional[dict]:
    """Validate and fix radar data"""
    if not radar:
        return None

    fields = ['tech_stack', 'soft_skills', 'culture', 'salary_potential', 'career_growth']
    for field in fields:
        val = radar.get(field)
        if not isinstance(val, (int, float)) or val < 0 or val > 100:
            radar[field] = 50

    return radar


async def analyze_job(
    client: httpx.AsyncClient,
    job: dict,
    profile: str,
    lang: str,
    custom_prompt: Optional[str] = None
) -> dict:
    """Analyze a single job using Gemini API"""

    # Map language code to full name (e.g., 'uk' -> 'Ukrainian')
    lang_full = LANG_MAP.get(lang, 'Ukrainian')

    analysis_prompt = custom_prompt or DEFAULT_ANALYSIS_PROMPT

    full_prompt = f"""{analysis_prompt}

LANGUAGE REQUIREMENT (MANDATORY):
You MUST write the following fields in {lang_full}:
- "analysis" field - write in {lang_full}
- "tasks" field - write in {lang_full}
- "requirements" field - write in {lang_full}
- "offers" field - write in {lang_full}
- "aura.explanation" field - write in {lang_full}

DO NOT write these fields in English unless {lang_full} IS English.

--- CANDIDATE PROFILE ---
{profile}

--- JOB DESCRIPTION ---
Title: {job['title']}
Company: {job['company']}
Location: {job.get('location', 'Unknown')}

{job.get('description', 'No description available')}
"""

    url = f"https://generativelanguage.googleapis.com/v1beta/models/{GEMINI_MODEL}:generateContent?key={GEMINI_API_KEY}"

    max_retries = 3
    for attempt in range(max_retries + 1):
        try:
            response = await client.post(
                url,
                headers={
                    'Content-Type': 'application/json'
                },
                json={
                    'contents': [
                        {
                            'role': 'user',
                            'parts': [{'text': full_prompt}]
                        }
                    ],
                    'systemInstruction': {
                        'parts': [{'text': f'You are a helpful HR assistant that outputs strictly valid JSON. Write all text content in {lang_full} language.'}]
                    },
                    'generationConfig': {
                        'temperature': 0.3,
                        'responseMimeType': 'application/json'
                    }
                },
                timeout=60.0
            )

            # Retry on 503/429 with exponential backoff
            if response.status_code in (503, 429) and attempt < max_retries:
                wait = 2 ** attempt * 3  # 3s, 6s, 12s
                print(f"   ⏳ Gemini {response.status_code}, retry {attempt + 1}/{max_retries} in {wait}s...")
                await asyncio.sleep(wait)
                continue

            if response.status_code != 200:
                raise Exception(f"Gemini API error: {response.status_code} - {response.text}")

            data = response.json()

            # Extract text from Gemini response
            candidates = data.get('candidates', [])
            if not candidates:
                raise Exception("No candidates in Gemini response")

            text_content = candidates[0].get('content', {}).get('parts', [{}])[0].get('text', '')
            content = json.loads(text_content)

            usage_metadata = data.get('usageMetadata', {})

            # Validate aura and radar
            aura = validate_aura(content.get('aura'))
            radar = validate_radar(content.get('radar'))

            # Calculate cost
            tokens_in = usage_metadata.get('promptTokenCount', 0)
            tokens_out = usage_metadata.get('candidatesTokenCount', 0)
            cost = (tokens_in * PRICE_INPUT) + (tokens_out * PRICE_OUTPUT)

            return {
                'success': True,
                'score': content.get('score', 0),
                'analysis': content.get('analysis', ''),
                'tasks': content.get('tasks', ''),
                'requirements': content.get('requirements', ''),
                'offers': content.get('offers', ''),
                'aura': aura,
                'radar': radar,
                'cost': cost,
                'tokens_in': tokens_in,
                'tokens_out': tokens_out
            }

        except asyncio.TimeoutError:
            if attempt < max_retries:
                wait = 2 ** attempt * 3
                print(f"   ⏳ Timeout, retry {attempt + 1}/{max_retries} in {wait}s...")
                await asyncio.sleep(wait)
                continue
            return {'success': False, 'error': f'Timeout after {max_retries + 1} attempts'}
        except json.JSONDecodeError as e:
            return {'success': False, 'error': f'JSON parse error: {e}'}
        except Exception as e:
            return {'success': False, 'error': str(e)}


async def send_job_card(
    client: httpx.AsyncClient,
    chat_id: str,
    job: dict,
    result: dict,
    auto_app: dict = None,
    lang: str = 'uk'
):
    """Send unified job card to Telegram (analysis + optional auto-søknad in one message)"""
    if not TELEGRAM_TOKEN or not chat_id:
        if not chat_id:
            print(f"   ⚠️ No chat_id, skip TG for: {job.get('title', '?')[:30]}")
        return

    score = result.get('score', 0)

    score_emoji = "🟢" if score >= 70 else "🟡" if score >= 40 else "🔴"
    hot_emoji = " 🔥" if score >= 80 else ""

    # AI analysis (already in user's language)
    ai_analysis = result.get('analysis', '')
    if ai_analysis and len(ai_analysis) > 600:
        ai_analysis = ai_analysis[:600] + '...'

    # Tasks (duties)
    tasks = result.get('tasks', '')
    if tasks and len(tasks) > 500:
        tasks = tasks[:500] + '...'

    # Requirements
    requirements = result.get('requirements', '')
    if requirements and len(requirements) > 500:
        requirements = requirements[:500] + '...'

    # Offers
    offers = result.get('offers', '')
    if offers and len(offers) > 500:
        offers = offers[:500] + '...'

    # Build unified job card
    msg = f"📊 <b>{job['title']}</b>\n"
    msg += f"🏭 {job.get('company', 'Компанія не вказана')}\n"
    msg += f"📍 {job.get('location', 'Norway')}\n"
    if job.get('deadline'):
        msg += f"📅 Frist: {job['deadline']}\n"
    if job.get('has_enkel_soknad'):
        msg += f"⚡ Enkel søknad\n"
    msg += f"🎯 <b>{score}/100</b> {score_emoji}{hot_emoji}\n\n"

    # Job details shown openly
    if tasks:
        msg += f"📋 <b>Обов'язки:</b>\n{tasks}\n\n"
    if requirements:
        msg += f"📝 <b>Вимоги:</b>\n{requirements}\n\n"
    if offers:
        msg += f"🎁 <b>Пропонують:</b>\n{offers}\n\n"

    # AI analysis (pros/cons) under collapsible spoiler
    if ai_analysis:
        msg += f"<blockquote expandable>💬 {ai_analysis}</blockquote>\n\n"

    msg += f"🔗 <a href=\"{job.get('job_url', '')}\">Переглянути вакансію</a>"

    # Append auto-søknad if generated (single language, expandable blockquote)
    if auto_app:
        if lang == 'uk':
            cover = (auto_app.get('cover_letter_uk') or auto_app.get('cover_letter_no') or '')[:1500]
        else:
            cover = (auto_app.get('cover_letter_no') or auto_app.get('cover_letter_uk') or '')[:1500]
        msg += f"\n\n{'─' * 20}\n"
        msg += f"✨ <b>Авто-Søknad:</b>\n"
        msg += f"<blockquote expandable>{cover}</blockquote>"

    # Button logic
    payload = {
        'chat_id': chat_id,
        'text': msg,
        'parse_mode': 'HTML',
        'disable_web_page_preview': True,
    }
    if auto_app:
        # Auto-søknad generated → approve button
        payload['reply_markup'] = {
            "inline_keyboard": [[
                {"text": "✅ Підтвердити", "callback_data": f"approve_app_{auto_app['id']}"}
            ]]
        }
    elif score >= 50:
        # No auto-søknad but relevant → write button
        payload['reply_markup'] = {
            "inline_keyboard": [[
                {"text": "✍️ Написати Søknad", "callback_data": f"write_app_{job['id']}"}
            ]]
        }

    try:
        resp = await client.post(
            f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage",
            json=payload
        )
        if resp.status_code == 200:
            label = " +søknad" if auto_app else ""
            print(f"   📨 TG sent: {job['title'][:30]}{label}")
        else:
            print(f"   ⚠️ TG error {resp.status_code}: {job['title'][:30]}")
    except Exception as e:
        print(f"   ⚠️ TG send failed for {job['title']}: {e}")


async def generate_soknad_via_api(
    client: httpx.AsyncClient,
    job_id: str,
    user_id: str
) -> dict:
    """Call generate_application Edge Function to create søknad"""
    url = f"{SUPABASE_URL}/functions/v1/generate_application"
    max_retries = 2
    for attempt in range(max_retries + 1):
        try:
            response = await client.post(
                url,
                headers={
                    'Authorization': f'Bearer {SUPABASE_KEY}',
                    'Content-Type': 'application/json'
                },
                json={'job_id': job_id, 'user_id': user_id},
                timeout=60.0
            )
            if response.status_code == 200:
                return response.json()
            # Retry on 503/429 (Gemini overload propagated through Edge Function)
            if response.status_code in (503, 429) and attempt < max_retries:
                wait = 2 ** attempt * 3
                print(f"   ⏳ Søknad API {response.status_code}, retry {attempt + 1}/{max_retries} in {wait}s...")
                await asyncio.sleep(wait)
                continue
            return {'success': False, 'message': f'Gemini API returned error: {response.status_code} - {response.text}'}
        except Exception as e:
            return {'success': False, 'message': str(e)}


async def send_auto_soknad_card(
    client: httpx.AsyncClient,
    chat_id: str,
    job: dict,
    app: dict,
    score: int,
    lang: str = 'uk'
):
    """Send auto-generated søknad to Telegram with expandable blockquote"""
    if not TELEGRAM_TOKEN or not chat_id:
        return

    score_emoji = "🟢" if score >= 70 else "🟡" if score >= 40 else "🔴"

    # Single language cover letter based on user preference
    if lang == 'uk':
        cover = (app.get('cover_letter_uk') or app.get('cover_letter_no') or '')[:1500]
    else:
        cover = (app.get('cover_letter_no') or app.get('cover_letter_uk') or '')[:1500]

    msg = f"✨ <b>Авто-Søknad</b>\n\n"
    msg += f"📊 <b>{job['title']}</b> ({score}/100 {score_emoji})\n"
    msg += f"🏭 {job.get('company', '?')}\n\n"
    msg += f"<blockquote expandable>{cover}</blockquote>"

    payload = {
        'chat_id': chat_id,
        'text': msg,
        'parse_mode': 'HTML',
        'disable_web_page_preview': True,
        'reply_markup': {
            "inline_keyboard": [[
                {"text": "✅ Підтвердити", "callback_data": f"approve_app_{app['id']}"}
            ]]
        }
    }

    try:
        resp = await client.post(
            f"https://api.telegram.org/bot{TELEGRAM_TOKEN}/sendMessage",
            json=payload
        )
        if resp.status_code == 200:
            print(f"   📨 Auto-søknad TG sent: {job['title'][:30]}")
        else:
            print(f"   ⚠️ Auto-søknad TG error {resp.status_code}: {job['title'][:30]}")
    except Exception as e:
        print(f"   ⚠️ TG auto-søknad failed: {e}")


async def main(limit: int = 100, user_id: Optional[str] = None):
    """Main worker function"""
    validate_config()

    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

    print(f"🚀 Analyze Worker started at {datetime.now().isoformat()}")
    print(f"   Limit: {limit}, User: {user_id or 'all'}")

    # 1. Get unanalyzed jobs
    query = supabase.table('jobs').select('*').neq('status', 'ANALYZED').not_.is_('description', 'null')

    if user_id:
        query = query.eq('user_id', user_id)

    response = query.order('created_at').limit(limit).execute()
    jobs = response.data

    if not jobs:
        print("✅ Нет вакансий для анализа")
        return

    print(f"📋 Найдено {len(jobs)} вакансий для анализа")

    # 2. Group by user_id
    jobs_by_user: dict = {}
    for job in jobs:
        uid = job.get('user_id')
        if uid not in jobs_by_user:
            jobs_by_user[uid] = []
        jobs_by_user[uid].append(job)

    # 3. Process each user's jobs
    total_analyzed = 0
    total_cost = 0.0

    async with httpx.AsyncClient() as client:
        for uid, user_jobs in jobs_by_user.items():
            if not uid:
                print(f"⚠️ Skipping {len(user_jobs)} jobs without user_id")
                continue

            # Get user's profile
            profile_resp = supabase.table('cv_profiles').select('content').eq('user_id', uid).eq('is_active', True).limit(1).execute()

            if not profile_resp.data or not profile_resp.data[0].get('content'):
                print(f"⚠️ No profile for user {uid[:8]}..., skipping {len(user_jobs)} jobs")
                continue

            profile = profile_resp.data[0]['content']

            # Get user settings
            settings_resp = supabase.table('user_settings').select('preferred_analysis_language, telegram_chat_id, job_analysis_prompt, auto_soknad_enabled, auto_soknad_min_score').eq('user_id', uid).limit(1).execute()

            lang = 'uk'
            chat_id = None
            custom_prompt = None
            auto_soknad = False
            min_score = 50

            if settings_resp.data:
                settings = settings_resp.data[0]
                lang = settings.get('preferred_analysis_language') or 'uk'
                raw_chat_id = settings.get('telegram_chat_id')
                chat_id = str(raw_chat_id) if raw_chat_id else None
                custom_prompt = settings.get('job_analysis_prompt')
                auto_soknad = settings.get('auto_soknad_enabled', False) or False
                min_score = settings.get('auto_soknad_min_score', 50) or 50

            lang_full_name = LANG_MAP.get(lang, 'Ukrainian')
            auto_label = f" | auto-søknad≥{min_score}%" if auto_soknad else ""
            print(f"\n👤 User {uid[:8]}... | {len(user_jobs)} jobs | lang={lang} ({lang_full_name}) | tg={'SET: ' + chat_id[:6] + '...' if chat_id else 'NOT SET'}{auto_label}")

            auto_soknad_count = 0
            auto_soknad_cost = 0.0
            user_analyzed = 0
            user_cost = 0.0
            user_tokens_used = 0

            for job in user_jobs:
                result = await analyze_job(client, job, profile, lang, custom_prompt)

                if result['success']:
                    # Update database
                    supabase.table('jobs').update({
                        'relevance_score': result['score'],
                        'ai_recommendation': result['analysis'],
                        'tasks_summary': result['tasks'],
                        'analysis_metadata': {
                            'aura': result['aura'],
                            'radar': result['radar'],
                            'requirements': result.get('requirements', ''),
                            'offers': result.get('offers', '')
                        },
                        'status': 'ANALYZED',
                        'analyzed_at': datetime.utcnow().isoformat(),
                        'cost_usd': result['cost'],
                        'tokens_input': result['tokens_in'],
                        'tokens_output': result['tokens_out']
                    }).eq('id', job['id']).execute()

                    score = result['score']
                    emoji = "🟢" if score >= 70 else "🟡" if score >= 50 else "⚪"
                    title = job['title'][:40]
                    print(f"   {emoji} {title} | {score}% | ${result['cost']:.4f}")

                    # Auto-søknad generation (before sending card, so it's included)
                    auto_app = None
                    if auto_soknad and result['score'] >= min_score:
                        print(f"   ✍️ Auto-søknad for: {job['title'][:30]} (score={result['score']})")
                        soknad_result = await generate_soknad_via_api(client, job['id'], uid)
                        if soknad_result.get('success') and soknad_result.get('application'):
                            auto_app = soknad_result['application']
                            auto_soknad_count += 1
                            auto_soknad_cost += auto_app.get('cost_usd', 0) or 0
                        else:
                            err = soknad_result.get('message', 'Unknown error')
                            print(f"   ⚠️ Auto-søknad failed: {err}")

                    # Send unified job card to Telegram (analysis + søknad in one message)
                    await send_job_card(client, chat_id, job, result, auto_app=auto_app, lang=lang)

                    if auto_app:
                        await asyncio.sleep(1.5)  # Rate limiting for Gemini API

                    total_analyzed += 1
                    total_cost += result['cost']
                    user_analyzed += 1
                    user_cost += result['cost']
                    user_tokens_used += result.get('tokens_in', 0) + result.get('tokens_out', 0)
                else:
                    print(f"   ❌ {job['title'][:40]} | Error: {result['error']}")

                # Rate limiting for Gemini API
                await asyncio.sleep(1.0)

            # Auto-søknad summary for this user (sent to tech bot)
            if auto_soknad and auto_soknad_count > 0 and chat_id:
                tech_token = TELEGRAM_TECH_TOKEN or TELEGRAM_TOKEN
                if tech_token:
                    summary = f"📋 <b>Авто-søknader:</b>\n"
                    summary += f"✅ Створено: {auto_soknad_count}\n"
                    summary += f"📊 Поріг: ≥{min_score}%\n"
                    summary += f"💰 Вартість: ${auto_soknad_cost:.4f}"
                    try:
                        await client.post(
                            f"https://api.telegram.org/bot{tech_token}/sendMessage",
                            json={'chat_id': chat_id, 'text': summary, 'parse_mode': 'HTML'}
                        )
                    except Exception as e:
                        print(f"   ⚠️ TG summary failed: {e}")

            # Per-user system_log (so getTotalCost filtered by user_id works)
            if user_analyzed > 0:
                try:
                    supabase.table('system_logs').insert({
                        'user_id': uid,
                        'event_type': 'ANALYSIS',
                        'status': 'SUCCESS',
                        'message': f'Analysis: {user_analyzed} jobs',
                        'details': {'jobs_analyzed': user_analyzed, 'total_cost': user_cost},
                        'tokens_used': user_tokens_used,
                        'cost_usd': user_cost,
                        'source': 'GITHUB_ACTIONS'
                    }).execute()
                except Exception as e:
                    print(f"   ⚠️ Failed to write per-user system log: {e}")

    # 4. Log summary
    print(f"\n{'='*50}")
    print(f"✅ Analyzed: {total_analyzed} jobs")
    print(f"💰 Total cost: ${total_cost:.4f}")
    print(f"⏱️ Finished at {datetime.now().isoformat()}")

    # 5. Write summary system_log (no user_id, cost_usd=0 to avoid double-counting)
    try:
        supabase.table('system_logs').insert({
            'event_type': 'ANALYSIS',
            'status': 'SUCCESS',
            'message': f'Analyze worker completed: {total_analyzed} jobs for {len(jobs_by_user)} users',
            'details': {
                'jobs_analyzed': total_analyzed,
                'total_cost': total_cost,
                'users_processed': len(jobs_by_user)
            },
            'tokens_used': 0,
            'cost_usd': 0,
            'source': 'GITHUB_ACTIONS'
        }).execute()
    except Exception as e:
        print(f"⚠️ Failed to write system log: {e}")

    # 6. Send analysis summary to tech bot
    tech_token = TELEGRAM_TECH_TOKEN or TELEGRAM_TOKEN
    if tech_token and total_analyzed > 0:
        # Find admin chat_id to send summary
        try:
            admin_settings = supabase.table('user_settings').select('telegram_chat_id').eq('role', 'admin').limit(1).execute()
            admin_chat = admin_settings.data[0].get('telegram_chat_id') if admin_settings.data else None
            if admin_chat:
                summary_msg = (
                    f"📊 <b>Аналіз завершено</b>\n\n"
                    f"📋 Оброблено: {total_analyzed} вакансій\n"
                    f"👥 Користувачів: {len(jobs_by_user)}\n"
                    f"💰 Вартість: ${total_cost:.4f}"
                )
                async with httpx.AsyncClient() as tc:
                    await tc.post(
                        f"https://api.telegram.org/bot{tech_token}/sendMessage",
                        json={'chat_id': str(admin_chat), 'text': summary_msg, 'parse_mode': 'HTML'}
                    )
        except Exception as e:
            print(f"⚠️ Failed to send tech summary: {e}")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Analyze jobs worker')
    parser.add_argument('--limit', type=int, default=100, help='Max jobs to analyze')
    parser.add_argument('--user', type=str, help='Specific user ID to process')
    parser.add_argument('--users', type=str, help='Comma-separated user IDs to process')

    args = parser.parse_args()

    if args.users:
        # Run for each user separately
        for uid in args.users.split(','):
            uid = uid.strip()
            if uid:
                asyncio.run(main(limit=args.limit, user_id=uid))
    else:
        asyncio.run(main(limit=args.limit, user_id=args.user))

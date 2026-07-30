#!/usr/bin/env python3
"""
Analyze Worker - аналізує вакансії через Groq API (llama-3.3-70b-versatile)
Запускається через GitHub Actions після scheduled-scanner

Використання:
    python analyze_worker.py              # Аналізувати всі непроаналізовані
    python analyze_worker.py --limit 50   # Ліміт вакансій
    python analyze_worker.py --user UUID  # Тільки для конкретного юзера
"""

import os
import sys
import json
import asyncio
import argparse
from datetime import datetime, timedelta
from typing import Optional

import httpx
from dotenv import load_dotenv
from supabase import create_client, Client

# Load .env for local development
load_dotenv()

# Configuration
SUPABASE_URL = os.environ.get('SUPABASE_URL')
SUPABASE_KEY = os.environ.get('SUPABASE_SERVICE_KEY')
GROQ_API_KEY = os.environ.get('GROQ_API_KEY')
# Groq rate limits are per-model per-org, and this key is shared with the
# vitalii.no publishing pipeline. llama-3.3-70b has a 100k TPD pool that both
# projects were draining together, so job analysis lives on its own pools now.
GROQ_MODEL = 'openai/gpt-oss-120b'
GROQ_FALLBACK_MODEL = 'openai/gpt-oss-20b'
# llama-3.1-8b-instant was the last resort until 2026-07-29, when it turned out its
# 6000 TPM ceiling sits below a single one of our requests (6221-7350 measured), so
# every fallback ended in 413. Gemini takes that slot: different provider, different
# quota, and jobbot now has its own Google project rather than sharing portfolio's.
# 2026-07-30: 2.0-flash-lite has quota 0 on this project (429 on every call — the
# 30.07 run analyzed 2/43). gemini-3.1-flash-lite is the model this free tier
# actually grants: 500 RPD, no thinking tokens, verified live with this key.
GEMINI_MODEL = os.environ.get('GEMINI_ANALYSIS_MODEL', 'gemini-3.1-flash-lite')
GEMINI_API_KEY = os.environ.get('GEMINI_API_KEY')
# gpt-oss models reason before answering; without an explicit effort cap they
# spend the whole completion budget on hidden reasoning and return empty text.
GROQ_REASONING_EFFORT = 'low'
TELEGRAM_TOKEN = os.environ.get('TELEGRAM_BOT_TOKEN')
TELEGRAM_TECH_TOKEN = os.environ.get('TELEGRAM_TECH_BOT_TOKEN')

def build_groq_payload(model: str, system_message: str, user_message: str) -> dict:
    """Groq chat payload. gpt-oss models need an explicit reasoning_effort or the
    completion budget is consumed by hidden reasoning and content comes back empty."""
    payload = {
        'model': model,
        'messages': [
            {'role': 'system', 'content': system_message},
            {'role': 'user', 'content': user_message},
        ],
        'temperature': 0.3,
        'response_format': {'type': 'json_object'},
    }
    if model.startswith('openai/gpt-oss'):
        payload['reasoning_effort'] = GROQ_REASONING_EFFORT
    return payload

# Pricing per 1M tokens (notional - we run on the free tier, this only feeds
# the cost column in the dashboard).
MODEL_PRICES = {
    'openai/gpt-oss-120b': (0.15 / 1_000_000, 0.75 / 1_000_000),
    'openai/gpt-oss-20b': (0.10 / 1_000_000, 0.50 / 1_000_000),
    'llama-3.1-8b-instant': (0.05 / 1_000_000, 0.08 / 1_000_000),
    'llama-3.3-70b-versatile': (0.59 / 1_000_000, 0.79 / 1_000_000),
}
PRICE_INPUT, PRICE_OUTPUT = MODEL_PRICES['openai/gpt-oss-120b']

# Aura color mapping
AURA_COLORS = {
    'Toxic': '#ef4444',
    'Growth': '#22c55e',
    'Balanced': '#3b82f6',
    'Chill': '#06b6d4',
    'Grind': '#a855f7',
    'Neutral': '#6b7280'
}

# Auto-søknad threshold per source (owner's rule, 2026-07-29).
#
# A LinkedIn job costs far more to act on than a NAV/FINN one: the posting carries
# no application form, so someone has to find the employer's real ATS page first,
# and only then can the form be filled. NAV and FINN hand over a working apply URL
# with the ad. So LinkedIn has to clear a much higher bar to be worth starting,
# while everything from NAV/FINN passes at the normal threshold.
#
# The number also has to be read against the 2026-07-29 rescoring: the scorer used
# to give 85 to three quarters of everything, so 85 meant nothing. It now spreads,
# and 85 means "every significant requirement is met".
AUTO_SOKNAD_MIN_BY_SOURCE = {
    'LINKEDIN': 85,
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

HARD REQUIREMENT GATE (CRITICAL — check this FIRST, before scoring):
- Determine if the job requires a specific licensed/vocational/formal qualification
  (e.g. culinary chef training, licensed mechanic/electrician/welder, professional
  engineering degree, healthcare license, specific certified trade).
- If such a requirement exists AND the candidate's profile shows NO matching education,
  license, or hands-on trade experience — this is a HARD BLOCKER:
  - Score MUST NOT exceed 35, regardless of leadership/soft-skill/business experience.
  - Prefix the cons section with "🚫 Блокуюча вимога: [конкретна вимога]" (or the
    equivalent in the target language).
- Distinguish this from ordinary industry-adjacent gaps (e.g. general retail experience
  vs. this specific chain), which should score normally based on transferable overlap —
  the gate is ONLY for genuine licensed/vocational trade mismatches.
- Do NOT invent generic filler pros (e.g. "experience with various clients/technologies/
  products") to fill the pros section when genuine overlap is weak or absent. Writing
  0-1 pro bullets, or a single line like "Немає прямого релевантного досвіду, окрім
  загальних управлінських навичок", is CORRECT and preferred over padding with
  unrelated buzzwords pulled from the candidate's general summary.

SCORING — YOU COUNT, THE SYSTEM COMPUTES:
Do not invent a number. Classify the employer's requirements and report the counts;
the score is calculated from them outside this prompt.
1. List the employer's requirements as 3-8 discrete items -> req_total.
2. Classify each one:
   - req_met      — direct evidence; you can name the role and period that proves it.
   - req_partial  — transferable or adjacent experience only, no direct evidence.
   - everything else is missing (req_total - req_met - req_partial).
3. Report req_total / req_met / req_partial as integers in the JSON.
4. Also report these booleans, honestly, from the job text and the profile:
   - needs_norwegian  — the ad requires fluent/good Norwegian AND the profile does
                        not evidence it (the candidate is B1; "flytende norsk" is
                        not evidenced)
   - needs_licence    — the core daily duty requires formal training, a licence or a
                        certified trade the profile does not show
A requirement the candidate cannot demonstrate is MISSING, not PARTIAL. Counting
a gap as partial credit is the single easiest way to make this whole system lie.
Still give "score" your own estimate — it is kept only as a cross-check.

CALIBRATION (requirement, not a hint):
90-100 could start tomorrow with no gaps — rare, never manufacture one.
80-89 every significant requirement MET. 60-79 real but incomplete match.
40-59 transferable skills only. Below 40 should not apply.
Most jobs in a batch land below 60. Scores clustering in one band mean you are
describing the job instead of comparing it to this candidate.
Open the "analysis" field with the tally, e.g. "Оцінка: 3/7 вимог виконано, 2 частково → 49".

ANALYSIS FORMAT (CRITICAL):
The "analysis" field MUST use this EXACT structure — cons FIRST, then pros:
❌ Мінуси:
- [specific con about candidate fit]
- [another con]

✅ Плюси:
- [specific pro about candidate fit]
- [another pro]

Write 2-5 bullet points for the cons section. For pros, write ONLY as many bullets as are
genuinely justified by real profile overlap (0-5) — never pad with generic filler just to
fill space.
When listing pros, explicitly reference the SPECIFIC role/period from the candidate's history that is relevant.
If the target language is Norwegian, use "❌ Ulemper:" and "✅ Fordeler:".
If the target language is English, use "❌ Cons:" and "✅ Pros:".

OUTPUT FORMAT (JSON ONLY):
{
  "score": number (0-100, your own estimate — cross-check only),
  "req_total": number (how many requirements you listed, 3-8),
  "req_met": number (requirements with direct evidence in the profile),
  "req_partial": number (requirements covered only by transferable experience),
  "needs_norwegian": boolean (fluent Norwegian required and not evidenced),
  "needs_licence": boolean (formal licence/trade required and not evidenced),
  "position_uk": "string (job title/position translated to Ukrainian, short — e.g. 'Менеджер з продажу', 'Водій', 'Бізнес-контролер')",
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
    if not GROQ_API_KEY:
        missing.append('GROQ_API_KEY')

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


# Deterministic safety net: the LLM sometimes ignores the HARD REQUIREMENT GATE prompt
# instruction (temperature=0.3, no cross-field consistency guarantee between "score" and
# "requirements"). Keyword-match on title + the ❌ (unmet) requirements text and force-cap
# the score, independent of what the model decided.
VOCATIONAL_GATE_KEYWORDS = [
    'kokk', 'kjøkkensjef', 'kokkefaget',
    'mekaniker', 'bilmekaniker',
    'elektriker', 'elektrofag',
    'snekker', 'tømrer', 'rørlegger', 'sveiser',
    'sivilingeniør', 'ingeniør', 'ingeniørfag',
    'frisør', 'tannlege', 'sykepleier', 'jordmor',
    'advokat', 'revisor', 'lege',
]


def apply_hard_requirement_gate(score: int, title: str, requirements_text: str) -> int:
    """Cap score if the job title/requirements name a licensed/vocational trade and the
    requirements text itself lists an unmet (❌) item — deterministic backstop for the
    prompt-level HARD REQUIREMENT GATE."""
    if not requirements_text:
        return score
    haystack = f"{title} {requirements_text}".lower()
    has_vocational_keyword = any(kw in haystack for kw in VOCATIONAL_GATE_KEYWORDS)
    has_unmet_marker = '❌' in requirements_text
    if has_vocational_keyword and has_unmet_marker:
        return min(score, 35)
    return score


# Career-track scoring honesty calibration (added 2026-07-19): the LLM had been scoring
# career-track roles optimistically on two specific real blockers — seniority (years of
# PAID employment in the craft, not just self-taught/personal-project skill) and Norwegian
# language level (Vitalii's documented level is B1, not flytende/morsmål). Same
# prompt+deterministic-backstop pattern as the vocational HARD REQUIREMENT GATE above: the
# prompt instructs the model to prefix the relevant cons bullet with an invariant "❗️"
# marker (kept as-is across languages, only the words after it translate), and a
# keyword+marker backstop re-caps the score if the model ignores the instruction. Only
# applies to track == 'career' (see skills/application-pipeline).
CAREER_SENIORITY_GATE_TITLES = [
    'head of engineering', 'engineering manager', 'senior engineer', 'senior developer',
    'senior software', 'principal engineer', 'principal architect', 'architect',
    'lead engineer', 'lead developer', 'tech lead', 'chief technology officer',
    'vp of engineering', 'head of it', 'it-sjef', 'it-direktør',
]
CAREER_LANGUAGE_GATE_KEYWORDS = [
    'flytende norsk', 'morsmål', 'som morsmål', 'native norwegian', 'perfekt norsk',
]

CAREER_SENIORITY_GATE_PROMPT = """
SENIORITY GATE (career track — check BEFORE finalizing the score):
- This role demands many years of PROFESSIONAL (paid, employed) experience in a specific
  craft (e.g. Head of Engineering, Senior/Principal Engineer, Architect, Engineering Manager).
- If the candidate's profile shows this craft ONLY via self-taught skills or personal/hobby
  projects, with NO paid employment history in that exact craft, this is a real seniority gap.
- When that gap applies: score MUST NOT exceed 60, and the FIRST cons bullet must be exactly
  "❗️ Немає професійного найму в цій ролі — навички самостійні" (translate the words after ❗️
  to the target language, keep the ❗️ character itself).
"""

CAREER_LANGUAGE_GATE_PROMPT = """
LANGUAGE GATE (career track — check BEFORE finalizing the score):
- If the job posting explicitly requires native-level or fully fluent Norwegian (flytende
  norsk, morsmål, native speaker), and the candidate's documented Norwegian level is B1 (NOT
  fluent, NOT native) — this is a real language mismatch.
- When that gap applies: score MUST NOT exceed 50, and the FIRST cons bullet must be exactly
  "❗️ Вимагається вільна/рідна норвезька, у кандидата документований рівень B1" (translate the
  words after ❗️ to the target language, keep the ❗️ character itself).
- Do NOT apply this gate to English-language job postings.
"""

CAREER_CONS_ORDERING_PROMPT = """
CONS ORDERING (career track): the FIRST bullet in the cons section overall must state the
single biggest REAL obstacle to this specific candidate getting this specific role — language
level, seniority/professional-hire gap, or a missing formal diploma/license — stated plainly,
with no sugar-coating. If a SENIORITY GATE or LANGUAGE GATE marker applies, that marker IS the
first bullet.
"""


def apply_seniority_gate(score: int, track: str, title: str, analysis_text: str) -> int:
    """Deterministic backstop for the SENIORITY GATE prompt instruction (career track only)."""
    if track != 'career' or not analysis_text:
        return score
    haystack_title = (title or '').lower()
    if any(kw in haystack_title for kw in CAREER_SENIORITY_GATE_TITLES) and '❗️' in analysis_text:
        return min(score, 60)
    return score


def apply_language_gate(score: int, track: str, title: str, description: str, analysis_text: str) -> int:
    """Deterministic backstop for the LANGUAGE GATE prompt instruction (career track only)."""
    if track != 'career' or not analysis_text:
        return score
    haystack = f"{title} {description or ''}".lower()
    if any(kw in haystack for kw in CAREER_LANGUAGE_GATE_KEYWORDS) and '❗️' in analysis_text:
        return min(score, 50)
    return score


# Search tracks: nav_quota (NAV activity-report jobs, "can I do this") vs
# career (leadership/IT jobs, "fit with leadership experience + company potential").
# LinkedIn jobs are always career. NAV/FINN jobs are career only if a leadership or
# IT signal is present in title+description, otherwise nav_quota by default.
TRACK_LEADERSHIP_KEYWORDS = [
    'leder', 'ledelse', 'daglig leder', 'avdelingsleder', 'teamleder', 'seksjonsleder',
    'enhetsleder', 'driftsleder', 'styreleder', 'direktør', 'sjef', 'manager',
    # Vitalii is an HK-dir approved teacher — leadership positions in education count
    # as career, but a plain lærervikar (substitute teacher, no leadership) stays nav_quota.
    'rektor', 'undervisningsinspektør', 'styrer barnehage', 'barnehagestyrer',
]
TRACK_IT_KEYWORDS = [
    'it-', 'utvikler', 'developer', 'programmerer', 'systemutvikler', 'dataingeniør',
    'devops', 'backend', 'frontend', 'fullstack', 'cloud engineer', 'it-konsulent',
    'cto', 'tech lead',
]


def classify_track(job: dict) -> str:
    """Classify a job into 'nav_quota' or 'career'. LinkedIn is always career;
    NAV/FINN jobs are career only when a leadership/IT signal is present."""
    if (job.get('source') or '').upper() == 'LINKEDIN':
        return 'career'
    haystack = f"{job.get('title', '')} {job.get('description', '')}".lower()
    if any(kw in haystack for kw in TRACK_LEADERSHIP_KEYWORDS) or \
       any(kw in haystack for kw in TRACK_IT_KEYWORDS):
        return 'career'
    return 'nav_quota'


def score_from_counts(content: dict) -> int:
    """Derive the score from the model's requirement tally instead of its own number.

    Why (2026-07-29): asked to follow a rubric, the model wrote a fine analysis and
    then produced a number unrelated to it. AutoStore's AI Solution Analyst scored
    100 while the same answer said there was no direct HR/Legal/Strategy experience
    and no evidenced Norwegian — two facts that cap it far below that under the
    rubric. Classification is what models are good at; arithmetic is what they drift
    on. So the model counts, and this function computes.

    Falls back to the model's own score only when the counts are missing or absurd,
    so a malformed answer degrades to the old behaviour rather than to zero.
    """
    try:
        total = int(content.get('req_total') or 0)
        met = int(content.get('req_met') or 0)
        partial = int(content.get('req_partial') or 0)
    except (TypeError, ValueError):
        return int(content.get('score') or 0)

    if total < 1 or met < 0 or partial < 0 or (met + partial) > total:
        return int(content.get('score') or 0)

    score = round(100 * (met + 0.4 * partial) / total)

    if content.get('needs_licence'):
        score = min(score, 45)
    if content.get('needs_norwegian'):
        score = min(score, 55)
    if met <= 1 and total >= 3:
        score = min(score, 50)

    return max(0, min(100, score))


async def analyze_job(
    client: httpx.AsyncClient,
    job: dict,
    profile: str,
    lang: str,
    custom_prompt: Optional[str] = None,
    track: str = 'nav_quota'
) -> dict:
    """Analyze a single job using Groq API"""

    lang_full = LANG_MAP.get(lang, 'Ukrainian')
    analysis_prompt = custom_prompt or DEFAULT_ANALYSIS_PROMPT
    if track == 'career':
        analysis_prompt = (
            f"{analysis_prompt}\n{CAREER_SENIORITY_GATE_PROMPT}\n"
            f"{CAREER_LANGUAGE_GATE_PROMPT}\n{CAREER_CONS_ORDERING_PROMPT}"
        )

    user_message = f"""{analysis_prompt}

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

{(job.get('description') or 'No description available')[:4500]}
"""

    system_message = f'You are a helpful HR assistant that outputs strictly valid JSON. Write all text content in {lang_full} language.'

    # Try primary model (3 retries), then fallback (2 retries)
    models = [
        ('groq', GROQ_MODEL, 3),
        ('groq', GROQ_FALLBACK_MODEL, 2),
    ]
    if GEMINI_API_KEY:
        models.append(('gemini', GEMINI_MODEL, 2))

    for provider, model, max_retries in models:
        is_last = (provider, model) == (models[-1][0], models[-1][1])

        for attempt in range(max_retries + 1):
            try:
                if provider == 'groq':
                    response = await client.post(
                        "https://api.groq.com/openai/v1/chat/completions",
                        headers={
                            'Content-Type': 'application/json',
                            'Authorization': f'Bearer {GROQ_API_KEY}'
                        },
                        json=build_groq_payload(model, system_message, user_message),
                        timeout=60.0
                    )
                else:
                    response = await client.post(
                        f"https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent",
                        headers={'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY},
                        json={
                            'systemInstruction': {'parts': [{'text': system_message}]},
                            'contents': [{'role': 'user', 'parts': [{'text': user_message}]}],
                            'generationConfig': {
                                'temperature': 0.3,
                                'responseMimeType': 'application/json',
                            },
                        },
                        timeout=90.0
                    )

                if response.status_code in (503, 429) and attempt < max_retries:
                    wait = min(2 ** attempt * 5, 60)
                    print(f"   ⏳ {model} {response.status_code}, retry {attempt + 1}/{max_retries} in {wait}s...")
                    await asyncio.sleep(wait)
                    continue

                if response.status_code in (503, 429) and attempt >= max_retries:
                    if not is_last:
                        print(f"   🔄 {model} unavailable after {max_retries + 1} attempts, falling back...")
                    break

                if response.status_code != 200:
                    raise Exception(f"Groq API error: {response.status_code} - {response.text}")

                data = response.json()

                if provider == 'groq':
                    text_content = data['choices'][0]['message']['content']
                    usage = data.get('usage', {})
                    tokens_in = usage.get('prompt_tokens', 0)
                    tokens_out = usage.get('completion_tokens', 0)
                else:
                    text_content = data['candidates'][0]['content']['parts'][0]['text']
                    usage = data.get('usageMetadata', {})
                    tokens_in = usage.get('promptTokenCount', 0)
                    tokens_out = usage.get('candidatesTokenCount', 0)
                content = json.loads(text_content)

                price_in, price_out = MODEL_PRICES.get(model, (PRICE_INPUT, PRICE_OUTPUT))
                cost = (tokens_in * price_in) + (tokens_out * price_out)

                aura = validate_aura(content.get('aura'))
                radar = validate_radar(content.get('radar'))

                used_model = model
                if model != GROQ_MODEL:
                    used_model = f"{model} (fallback)"

                gated_score = apply_hard_requirement_gate(
                    score_from_counts(content), job.get('title', ''), content.get('requirements', '')
                )
                gated_score = apply_seniority_gate(
                    gated_score, track, job.get('title', ''), content.get('analysis', '')
                )
                gated_score = apply_language_gate(
                    gated_score, track, job.get('title', ''), job.get('description', ''), content.get('analysis', '')
                )

                return {
                    'success': True,
                    'score': gated_score,
                    'position_uk': content.get('position_uk', ''),
                    'analysis': content.get('analysis', ''),
                    'tasks': content.get('tasks', ''),
                    'requirements': content.get('requirements', ''),
                    'offers': content.get('offers', ''),
                    'aura': aura,
                    'radar': radar,
                    'cost': cost,
                    'tokens_in': tokens_in,
                    'tokens_out': tokens_out,
                    'model': used_model
                }

            except asyncio.TimeoutError:
                if attempt < max_retries:
                    wait = min(2 ** attempt * 5, 60)
                    print(f"   ⏳ {model} timeout, retry {attempt + 1}/{max_retries} in {wait}s...")
                    await asyncio.sleep(wait)
                    continue
                if not is_last:
                    print(f"   🔄 {model} timeout after {max_retries + 1} attempts, falling back...")
                break
            except json.JSONDecodeError as e:
                return {'success': False, 'error': f'JSON parse error: {e}'}
            except Exception as e:
                return {'success': False, 'error': str(e)}

    return {'success': False, 'error': 'All models unavailable after retries'}


async def send_job_card(
    client: httpx.AsyncClient,
    chat_id: str,
    job: dict,
    result: dict,
    auto_app: dict = None,
    lang: str = 'uk',
    track_min_score: int = 50
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
    track_badge = "🟢 NAV-квота" if job.get('track', 'nav_quota') == 'nav_quota' else "🎯 Кар'єра"
    msg = f"📊 <b>{job['title']}</b>\n"
    msg += f"{track_badge}\n"
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

    # Append auto-søknad cover letter if one was already written (rare: generate_application
    # only queues 'pending_manual' now, letters are written later by the agent, so this is
    # normally empty at send time -- only show it if non-empty).
    if auto_app:
        if lang == 'uk':
            cover = (auto_app.get('cover_letter_uk') or auto_app.get('cover_letter_no') or '')[:1500]
        else:
            cover = (auto_app.get('cover_letter_no') or auto_app.get('cover_letter_uk') or '')[:1500]
        if cover:
            msg += f"\n\n{'─' * 20}\n"
            msg += f"✨ <b>Авто-Søknad:</b>\n"
            msg += f"<blockquote expandable>{cover}</blockquote>"

    # Button logic -- single "✅ Підтвердити" entry point everywhere (2026-07-20), no separate
    # write/approve step. If auto_app already exists it's already queued (submission_method='agent'
    # set at creation by generate_application), so no button is needed at all.
    payload = {
        'chat_id': chat_id,
        'text': msg,
        'parse_mode': 'HTML',
        'disable_web_page_preview': True,
    }
    if auto_app:
        msg += "\n\n🚀 <i>Вже в черзі на обробку.</i>"
        payload['text'] = msg
    elif score >= track_min_score:
        # Not queued yet but relevant (per this job's track threshold) → single confirm button
        payload['reply_markup'] = {
            "inline_keyboard": [[
                {"text": "✅ Підтвердити", "callback_data": f"confirm_job_{job['id']}"}
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
    max_retries = 4
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
            # Retry on 503/429 with exponential backoff (capped at 60s)
            if response.status_code in (503, 429) and attempt < max_retries:
                wait = min(2 ** attempt * 5, 60)  # 5s, 10s, 20s, 40s
                print(f"   ⏳ Søknad API {response.status_code}, retry {attempt + 1}/{max_retries} in {wait}s...")
                await asyncio.sleep(wait)
                continue
            return {'success': False, 'message': f'Edge Function error: {response.status_code} - {response.text}'}
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

    # Track policies (global config, table: track_policies) — falls back to the
    # starting values from the migration if the table is empty/unreachable.
    track_policies = {
        'nav_quota': {'min_score': 60, 'auto_submit_allowed': False, 'letter_style': 'standard', 'daily_limit': 10},
        'career': {'min_score': 70, 'auto_submit_allowed': False, 'letter_style': 'wide_individual', 'daily_limit': None},
    }
    try:
        policies_resp = supabase.table('track_policies').select('*').execute()
        for row in (policies_resp.data or []):
            track_policies[row['track']] = row
    except Exception as e:
        print(f"⚠️ Could not load track_policies, using defaults: {e}")

    print(f"🚀 Analyze Worker started at {datetime.now().isoformat()}")
    print(f"   Limit: {limit}, User: {user_id or 'all'}")

    # 1. Get unanalyzed jobs (includes previously failed ones for re-analysis)
    # ARCHIVED is a deliberate "forget this one" marker, set by the owner on the
    # pre-2026-07-29 backlog. Without excluding it here the archive would be
    # re-analyzed on the next run, since the query takes everything that is not
    # ANALYZED.
    query = (
        supabase.table('jobs')
        .select('*')
        .neq('status', 'ANALYZED')
        .neq('status', 'ARCHIVED')
        .not_.is_('description', 'null')
    )

    if user_id:
        query = query.eq('user_id', user_id)

    response = query.order('created_at').limit(limit).execute()
    jobs = response.data

    if not jobs:
        print("✅ Нет вакансий для анализа")
        return

    # Split into retry vs new jobs (retry = created before today)
    today_str = datetime.utcnow().strftime('%Y-%m-%d')
    retry_jobs = [j for j in jobs if j.get('created_at', '')[:10] < today_str]
    new_jobs = [j for j in jobs if j.get('created_at', '')[:10] >= today_str]

    print(f"📋 Найдено {len(jobs)} вакансий для анализа")
    if retry_jobs:
        print(f"   🔄 Re-analyze (failed earlier): {len(retry_jobs)}")
    if new_jobs:
        print(f"   🆕 New jobs: {len(new_jobs)}")

    # 2. Group by user_id
    jobs_by_user: dict = {}
    for job in jobs:
        uid = job.get('user_id')
        if uid not in jobs_by_user:
            jobs_by_user[uid] = []
        jobs_by_user[uid].append(job)

    # 3. Process each user's jobs
    total_analyzed = 0
    total_failed = 0
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
            settings_resp = supabase.table('user_settings').select('preferred_analysis_language, telegram_chat_id, job_analysis_prompt, auto_soknad_enabled, auto_soknad_min_score, card_notify_min_score').eq('user_id', uid).limit(1).execute()

            lang = 'uk'
            chat_id = None
            custom_prompt = None
            auto_soknad = False
            min_score = 50
            card_notify_min_score = 40

            if settings_resp.data:
                settings = settings_resp.data[0]
                lang = settings.get('preferred_analysis_language') or 'uk'
                raw_chat_id = settings.get('telegram_chat_id')
                chat_id = str(raw_chat_id) if raw_chat_id else None
                custom_prompt = settings.get('job_analysis_prompt')
                auto_soknad = settings.get('auto_soknad_enabled', False) or False
                min_score = settings.get('auto_soknad_min_score', 50) or 50
                card_notify_min_score = settings.get('card_notify_min_score', 40) or 40

            lang_full_name = LANG_MAP.get(lang, 'Ukrainian')
            auto_label = f" | auto-søknad≥{min_score}%" if auto_soknad else ""
            print(f"\n👤 User {uid[:8]}... | {len(user_jobs)} jobs | lang={lang} ({lang_full_name}) | tg={'SET: ' + chat_id[:6] + '...' if chat_id else 'NOT SET'}{auto_label}")

            auto_soknad_count = 0
            user_analyzed = 0
            user_cost = 0.0
            user_tokens_used = 0
            track_counts = {'nav_quota': 0, 'career': 0}
            filtered_count = 0

            for job in user_jobs:
                track = classify_track(job)
                result = await analyze_job(client, job, profile, lang, custom_prompt, track=track)

                if result['success']:
                    policy = track_policies.get(track, track_policies['nav_quota'])
                    track_counts[track] = track_counts.get(track, 0) + 1

                    # Update database
                    supabase.table('jobs').update({
                        'relevance_score': result['score'],
                        'ai_recommendation': result['analysis'],
                        'tasks_summary': result['tasks'],
                        'track': track,
                        'analysis_metadata': {
                            'aura': result['aura'],
                            'radar': result['radar'],
                            'requirements': result.get('requirements', ''),
                            'offers': result.get('offers', ''),
                            'position_uk': result.get('position_uk', '')
                        },
                        'status': 'ANALYZED',
                        'analyzed_at': datetime.utcnow().isoformat(),
                        'cost_usd': result['cost'],
                        'tokens_input': result['tokens_in'],
                        'tokens_output': result['tokens_out']
                    }).eq('id', job['id']).execute()

                    score = result['score']
                    track_badge = "🟢 NAV" if track == 'nav_quota' else "🎯 Кар'єра"
                    emoji = "🟢" if score >= policy['min_score'] else "🟡" if score >= 50 else "⚪"
                    title = job['title'][:40]
                    model_tag = f" [{result['model']}]" if 'model' in result and 'fallback' in result.get('model', '') else ""
                    print(f"   {emoji} {track_badge} {title} | {score}% | ${result['cost']:.4f}{model_tag}")

                    job['track'] = track

                    # Auto-søknad generation (before sending card, so it's included).
                    # Every job above the threshold gets a letter — the owner's rule
                    # (2026-07-29): "there can be ten relevant jobs in a day and all of
                    # them should be processed". max_applications_per_day caps what is
                    # actually SUBMITTED, not what is prepared, and it is enforced in
                    # the agent's fill gate (scripts/patch-agent-pollers.cjs), because
                    # that is where the cost and the irreversible step live.
                    auto_app = None
                    source = (job.get('source') or '').upper()
                    auto_min = AUTO_SOKNAD_MIN_BY_SOURCE.get(source, min_score)
                    if auto_soknad and result['score'] < auto_min and result['score'] >= min_score:
                        print(
                            f"   ⏭ {source or '?'} needs ≥{auto_min}: {job['title'][:30]} "
                            f"scored {result['score']} — card only, confirm by hand if wanted"
                        )
                    elif auto_soknad and result['score'] >= auto_min:
                        print(f"   ✍️ Auto-søknad for: {job['title'][:30]} (score={result['score']}, {source or '?'} ≥{auto_min})")
                        soknad_result = await generate_soknad_via_api(client, job['id'], uid)
                        if soknad_result.get('success') and soknad_result.get('application'):
                            auto_app = soknad_result['application']
                            auto_soknad_count += 1
                        else:
                            err = soknad_result.get('message', 'Unknown error')
                            print(f"   ⚠️ Auto-søknad failed: {err}")

                    # Send unified job card to Telegram (analysis + søknad in one message) --
                    # gated by card_notify_min_score, except an auto-generated søknad always
                    # gets a card since it needs the approve button regardless of threshold.
                    if auto_app is not None or result['score'] >= card_notify_min_score:
                        await send_job_card(
                            client, chat_id, job, result, auto_app=auto_app, lang=lang,
                            track_min_score=policy['min_score']
                        )
                    else:
                        filtered_count += 1

                    if auto_app:
                        await asyncio.sleep(0.5)

                    total_analyzed += 1
                    total_cost += result['cost']
                    user_analyzed += 1
                    user_cost += result['cost']
                    user_tokens_used += result.get('tokens_in', 0) + result.get('tokens_out', 0)
                else:
                    total_failed += 1
                    print(f"   ❌ {job['title'][:40]} | Error: {result['error']}")

                # Rate limiting for Groq API. The gpt-oss pools allow 8000 tokens
                # per minute and one of our requests weighs 6200-7400, so the pool
                # fits ~one job a minute. A 5s pause meant 11 of every 12 requests
                # hit 429 and drained the fallbacks too (30.07: 2 analyzed, 41 failed).
                await asyncio.sleep(60.0)

            if filtered_count > 0:
                print(f"   🔕 Filtered (no card, score < {card_notify_min_score}): {filtered_count} jobs — see evening digest")

            # Auto-søknad summary for this user (sent to tech bot only, never the main bot)
            if auto_soknad and auto_soknad_count > 0 and chat_id:
                if not TELEGRAM_TECH_TOKEN:
                    print("   ⚠️ TELEGRAM_TECH_BOT_TOKEN not set — skipping auto-søknad summary (not sending to main bot)")
                else:
                    summary = f"📋 <b>Авто-søknader:</b>\n"
                    summary += f"✅ Створено: {auto_soknad_count}\n"
                    summary += f"📊 Поріг: ≥{min_score}%"
                    try:
                        await client.post(
                            f"https://api.telegram.org/bot{TELEGRAM_TECH_TOKEN}/sendMessage",
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
    if total_failed > 0:
        print(f"❌ Failed: {total_failed} jobs (will retry next run)")
    print(f"💰 Total cost: ${total_cost:.4f}")
    print(f"⏱️ Finished at {datetime.now().isoformat()}")

    # 5. Write summary system_log (no user_id, cost_usd=0 to avoid double-counting)
    try:
        supabase.table('system_logs').insert({
            'event_type': 'ANALYSIS',
            'status': 'SUCCESS',
            'message': f'Analyze worker completed: {total_analyzed} analyzed, {total_failed} failed for {len(jobs_by_user)} users',
            'details': {
                'jobs_analyzed': total_analyzed,
                'jobs_failed': total_failed,
                'jobs_retried': len(retry_jobs),
                'total_cost': total_cost,
                'users_processed': len(jobs_by_user)
            },
            'tokens_used': 0,
            'cost_usd': 0,
            'source': 'GITHUB_ACTIONS'
        }).execute()
    except Exception as e:
        print(f"⚠️ Failed to write system log: {e}")

    # 6. Send analysis summary to tech bot only (never falls back to the main bot)
    if not TELEGRAM_TECH_TOKEN:
        print("⚠️ TELEGRAM_TECH_BOT_TOKEN not set — skipping analysis summary (not sending to main bot)")
    elif total_analyzed > 0:
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
                        f"https://api.telegram.org/bot{TELEGRAM_TECH_TOKEN}/sendMessage",
                        json={'chat_id': str(admin_chat), 'text': summary_msg, 'parse_mode': 'HTML'}
                    )
        except Exception as e:
            print(f"⚠️ Failed to send tech summary: {e}")


async def send_evening_digest():
    """Daily digest of today's analyzed jobs, broken down by track. Sent to the tech
    bot (this is a summary report, not a per-job action item — see Part A bot rules)."""
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
    today_str = datetime.utcnow().strftime('%Y-%m-%d')

    users_resp = supabase.table('user_settings').select('user_id, telegram_chat_id, card_notify_min_score').execute()

    async with httpx.AsyncClient() as client:
        for u in (users_resp.data or []):
            uid = u.get('user_id')
            chat_id = u.get('telegram_chat_id')
            if not uid or not chat_id:
                continue
            card_notify_min_score = u.get('card_notify_min_score', 40) or 40

            jobs_today = supabase.table('jobs').select('track, relevance_score') \
                .eq('user_id', uid).gte('analyzed_at', today_str).execute()
            apps_today = supabase.table('applications').select('id') \
                .eq('user_id', uid).eq('status', 'sent').gte('sent_at', today_str).execute()

            rows = jobs_today.data or []
            if not rows:
                continue

            by_track = {'nav_quota': [], 'career': []}
            for r in rows:
                by_track.setdefault(r.get('track') or 'nav_quota', []).append(r.get('relevance_score') or 0)

            nav_scores = by_track.get('nav_quota', [])
            career_scores = by_track.get('career', [])
            sent_count = len(apps_today.data or [])
            filtered_count = sum(1 for r in rows if (r.get('relevance_score') or 0) < card_notify_min_score)

            msg = f"🌙 <b>Вечірній дайджест — {today_str}</b>\n\n"
            msg += f"🟢 <b>NAV-квота:</b> {len(nav_scores)} проаналізовано"
            if nav_scores:
                msg += f", середній бал {sum(nav_scores)//len(nav_scores)}%"
            msg += f"\n🎯 <b>Кар'єра:</b> {len(career_scores)} проаналізовано"
            if career_scores:
                msg += f", середній бал {sum(career_scores)//len(career_scores)}%"
            msg += f"\n\n📤 Відправлено заявок сьогодні: {sent_count}"
            if filtered_count > 0:
                msg += f"\n🔕 Відсіяно {filtered_count} нерелевантних (score < {card_notify_min_score}%)"

            if not TELEGRAM_TECH_TOKEN:
                print(f"⚠️ TELEGRAM_TECH_BOT_TOKEN not set — skipping evening digest for user {uid[:8]} (not sending to main bot)")
                continue
            try:
                await client.post(
                    f"https://api.telegram.org/bot{TELEGRAM_TECH_TOKEN}/sendMessage",
                    json={'chat_id': str(chat_id), 'text': msg, 'parse_mode': 'HTML'}
                )
            except Exception as e:
                print(f"⚠️ Evening digest send failed for user {uid[:8]}: {e}")


async def reanalyze_career_recent(days: int = 3, user_id: Optional[str] = None):
    """Re-run already-ANALYZED career-track jobs from the last N days through analyze_job with
    the new seniority/language honesty gates (2026-07-19), so historical scores reflect the
    current calibration. Updates jobs.relevance_score/ai_recommendation/analysis_metadata in
    place — does not resend Telegram cards or touch application status."""
    validate_config()
    supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)
    since = (datetime.utcnow() - timedelta(days=days)).isoformat()

    query = supabase.table('jobs').select('*').eq('track', 'career').eq('status', 'ANALYZED').gte('analyzed_at', since)
    if user_id:
        query = query.eq('user_id', user_id)
    jobs = query.execute().data or []

    if not jobs:
        print("✅ No career jobs to re-analyze")
        return

    jobs_by_user: dict = {}
    for job in jobs:
        jobs_by_user.setdefault(job.get('user_id'), []).append(job)

    print(f"🔁 Re-analyzing {len(jobs)} career jobs from last {days} days for {len(jobs_by_user)} users")

    async with httpx.AsyncClient() as client:
        for uid, user_jobs in jobs_by_user.items():
            if not uid:
                continue
            profile_resp = supabase.table('cv_profiles').select('content').eq('user_id', uid).eq('is_active', True).limit(1).execute()
            if not profile_resp.data or not profile_resp.data[0].get('content'):
                print(f"⚠️ No profile for user {uid[:8]}..., skipping {len(user_jobs)} jobs")
                continue
            profile = profile_resp.data[0]['content']

            settings_resp = supabase.table('user_settings').select('preferred_analysis_language, job_analysis_prompt').eq('user_id', uid).limit(1).execute()
            lang = 'uk'
            custom_prompt = None
            if settings_resp.data:
                lang = settings_resp.data[0].get('preferred_analysis_language') or 'uk'
                custom_prompt = settings_resp.data[0].get('job_analysis_prompt')

            print(f"\n👤 User {uid[:8]}... | {len(user_jobs)} career jobs")

            for job in user_jobs:
                result = await analyze_job(client, job, profile, lang, custom_prompt, track='career')
                if result['success']:
                    old_score = job.get('relevance_score')
                    supabase.table('jobs').update({
                        'relevance_score': result['score'],
                        'ai_recommendation': result['analysis'],
                        'tasks_summary': result['tasks'],
                        'analysis_metadata': {
                            'aura': result['aura'],
                            'radar': result['radar'],
                            'requirements': result.get('requirements', ''),
                            'offers': result.get('offers', ''),
                            'position_uk': result.get('position_uk', '')
                        },
                        'cost_usd': (job.get('cost_usd') or 0) + result['cost'],
                    }).eq('id', job['id']).execute()
                    delta = result['score'] - (old_score or 0)
                    arrow = "↓" if delta < 0 else "↑" if delta > 0 else "="
                    print(f"   {arrow} {job['title'][:40]}: {old_score}% -> {result['score']}%")
                else:
                    print(f"   ❌ {job['title'][:40]} | Error: {result['error']}")
                await asyncio.sleep(5.0)

    print("✅ Re-analysis complete")


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Analyze jobs worker')
    parser.add_argument('--limit', type=int, default=100, help='Max jobs to analyze')
    parser.add_argument('--user', type=str, help='Specific user ID to process')
    parser.add_argument('--users', type=str, help='Comma-separated user IDs to process')
    parser.add_argument('--digest', action='store_true', help='Send evening digest broken down by track instead of analyzing')
    parser.add_argument('--reanalyze-career-days', type=int, help='Re-analyze already-ANALYZED career jobs from the last N days with current calibration')

    args = parser.parse_args()

    if args.reanalyze_career_days is not None:
        asyncio.run(reanalyze_career_recent(days=args.reanalyze_career_days, user_id=args.user))
    elif args.digest:
        asyncio.run(send_evening_digest())
    elif args.users:
        # Run for each user separately
        for uid in args.users.split(','):
            uid = uid.strip()
            if uid:
                asyncio.run(main(limit=args.limit, user_id=uid))
    else:
        asyncio.run(main(limit=args.limit, user_id=args.user))

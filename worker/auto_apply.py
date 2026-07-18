import asyncio
import os
import json
import re
import logging
from logging.handlers import RotatingFileHandler
import httpx
import socket
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse
from dotenv import load_dotenv
from supabase import create_client, Client
from typing import Optional, Dict, Any

# Import site-specific navigation goals
from navigation_goals import (
    get_navigation_goal,
    detect_site_type,
    get_registration_goal,
    get_application_goal,
    is_site_supported,
    build_memory_section
)

# Import registration processing from register_site module
from register_site import process_registration as _rs_process_registration

# Load environment variables
load_dotenv()

# --- CONFIGURATION ---
SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_KEY")
# Skyvern failover: primary (HF Spaces) → fallback (home PC via Cloudflare)
SKYVERN_PRIMARY_URL = os.getenv("SKYVERN_PRIMARY_URL", os.getenv("SKYVERN_API_URL", "http://localhost:8000"))
SKYVERN_FALLBACK_URL = os.getenv("SKYVERN_FALLBACK_URL", "")
SKYVERN_URL = SKYVERN_PRIMARY_URL  # Active URL, updated by health checks
SKYVERN_API_KEY = os.getenv("SKYVERN_API_KEY", "")
HF_TOKEN = os.getenv("HF_TOKEN", "")  # For HF Spaces private auth


def skyvern_headers() -> dict:
    """Build headers for Skyvern API requests (includes HF auth if needed)."""
    headers = {}
    if SKYVERN_API_KEY:
        headers["x-api-key"] = SKYVERN_API_KEY
    if HF_TOKEN and "hf.space" in SKYVERN_URL:
        headers["Authorization"] = f"Bearer {HF_TOKEN}"
    return headers


FINN_EMAIL = os.getenv("FINN_EMAIL", "")
FINN_PASSWORD = os.getenv("FINN_PASSWORD", "")
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_TECH_BOT_TOKEN = os.getenv("TELEGRAM_TECH_BOT_TOKEN", "")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")

# Variant 4: Hybrid Flow (Extract → Match → Confirm → Fill)
# Set to True to use new smart form extraction for external forms
USE_HYBRID_FLOW = os.getenv("USE_HYBRID_FLOW", "true").lower() == "true"

if not SUPABASE_URL or not SUPABASE_KEY:
    print("❌ Missing SUPABASE_URL or SUPABASE_SERVICE_KEY in .env file")
    exit(1)

# Validate FINN credentials at startup
if not FINN_EMAIL or not FINN_PASSWORD:
    print("⚠️  WARNING: FINN_EMAIL and/or FINN_PASSWORD not set in .env")
    print("   FINN Enkel Søknad will NOT work without these credentials!")
    print("   Add to worker/.env:")
    print("   FINN_EMAIL=your-email@example.com")
    print("   FINN_PASSWORD=your-password")
    print("")
else:
    print(f"✅ FINN credentials configured for: {FINN_EMAIL}")

if USE_HYBRID_FLOW:
    print("🔬 Hybrid Flow ENABLED (Variant 4: Extract → Match → Confirm → Fill)")

# Initialize Supabase Client
supabase: Client = create_client(SUPABASE_URL, SUPABASE_KEY)

# --- WORKER IDENTITY (for multi-worker locking) ---
WORKER_ID = os.getenv("WORKER_ID", f"{socket.gethostname()}-{uuid.uuid4().hex[:8]}")
WORKER_LOCATION = os.getenv("WORKER_LOCATION", "unknown")
print(f"🆔 Worker ID: {WORKER_ID} ({WORKER_LOCATION})")

# --- CONSTANTS ---
POLL_INTERVAL = 10  # seconds between DB polls
STUCK_TIMEOUT_MINUTES = 30  # mark 'sending' applications as failed after this
CLEANUP_EVERY_N_CYCLES = 30  # run cleanup every N poll cycles (~5 min at 10s interval)
MAX_CONCURRENT_USERS = int(os.getenv("MAX_CONCURRENT_USERS", "3"))
RETRY_ATTEMPTS = 3
RETRY_BACKOFF = [5, 10]  # seconds between retries

FINN_CREDENTIALS_OK = bool(FINN_EMAIL and FINN_PASSWORD)

# Platforms too heavy for local Skyvern Docker (heavy JS DOM, 3-5 min per step)
# Applications on these platforms get instant "manual_review" with notification
BLOCKED_PLATFORMS = ['workday']

# Skyvern error_code_mapping - structured error detection via LLM evaluation
SKYVERN_ERROR_CODES = {
    "magic_link": "The site uses magic link/passwordless login. It sent a login link to the user's email instead of accepting a password. Look for: 'Check your email', 'Kontroller e-posten din', 'Login link sent', 'We sent you a link'.",
    "position_closed": "The job position is closed or the deadline expired. Look for: 'Stillingen er ikke lenger tilgjengelig', 'Fristen har gått ut', 'Annonsen er utløpt', 'Position closed', 'Deadline expired'.",
    "login_failed": "Login failed - wrong credentials, account locked, or login form not accessible.",
    "registration_required": "The site requires account registration before applying. Look for: 'Registrer deg', 'Opprett konto', 'Create account', registration form.",
    "file_upload_required": "A mandatory file upload field (CV, resume, cover letter PDF) blocks the application and cannot be skipped or bypassed.",
    "captcha_blocked": "A CAPTCHA appeared that cannot be solved automatically.",
}

FINN_ERROR_CODES = {
    k: v for k, v in SKYVERN_ERROR_CODES.items() if k != "magic_link"  # FINN uses passwordless login — not an error
}
FINN_ERROR_CODES["2fa_timeout"] = "The verification code was not provided or was rejected."

# --- FILE LOGGING ---
_file_logger = logging.getLogger("worker")
_file_logger.setLevel(logging.INFO)
_log_file = os.path.join(os.path.dirname(os.path.abspath(__file__)), "worker.log")
_file_handler = RotatingFileHandler(_log_file, maxBytes=5*1024*1024, backupCount=2, encoding="utf-8")
_file_handler.setFormatter(logging.Formatter("%(asctime)s %(message)s", datefmt="%Y-%m-%d %H:%M:%S"))
_file_logger.addHandler(_file_handler)

async def log(msg):
    timestamp = datetime.now().strftime("%H:%M:%S")
    print(f"[{timestamp}] {msg}")
    _file_logger.info(msg)


async def _check_url_health(url: str) -> bool:
    """Check if a single Skyvern URL is healthy."""
    try:
        headers = skyvern_headers()
        if HF_TOKEN and "hf.space" in url:
            headers["Authorization"] = f"Bearer {HF_TOKEN}"
        async with httpx.AsyncClient() as client:
            response = await client.get(f"{url}/openapi.json", headers=headers, timeout=10.0)
            return response.status_code == 200
    except Exception:
        return False


async def check_skyvern_health() -> bool:
    """Check Skyvern health with failover: primary → fallback.
    Updates global SKYVERN_URL to the working endpoint."""
    global SKYVERN_URL

    # Try primary first
    if await _check_url_health(SKYVERN_PRIMARY_URL):
        if SKYVERN_URL != SKYVERN_PRIMARY_URL:
            await log(f"✅ Skyvern primary restored: {SKYVERN_PRIMARY_URL}")
        SKYVERN_URL = SKYVERN_PRIMARY_URL
        return True

    # Try fallback
    if SKYVERN_FALLBACK_URL and await _check_url_health(SKYVERN_FALLBACK_URL):
        if SKYVERN_URL != SKYVERN_FALLBACK_URL:
            await log(f"⚠️ Skyvern failover → fallback: {SKYVERN_FALLBACK_URL}")
        SKYVERN_URL = SKYVERN_FALLBACK_URL
        return True

    return False


# ============================================
# SITE FORM MEMORY SYSTEM
# ============================================

def normalize_domain_for_memory(domain: str) -> str:
    """Normalize domain for memory lookup. Strips company-specific subdomains.
    E.g. 'company.webcruiter.no' -> 'webcruiter.no'
    """
    domain = domain.lower().strip()
    known_platforms = [
        'webcruiter.no', 'webcruiter.com', 'easycruit.com', 'teamtailor.com',
        'lever.co', 'jobylon.com', 'recman.no', 'reachmee.com', 'varbi.com',
        'hrmanager.no', 'finn.no', 'nav.no'
    ]
    for platform in known_platforms:
        if domain.endswith(platform) or platform in domain:
            return platform
    return domain


async def extract_memory_from_task(
    task_id: str, domain: str, outcome: str,
    failure_reason: str = None, app_id: str = None,
    job_url: str = None, max_steps_configured: int = None
) -> dict:
    """Extract form interaction memory from a completed Skyvern task."""
    headers = skyvern_headers()
    norm_domain = normalize_domain_for_memory(domain)

    async with httpx.AsyncClient() as client:
        steps = await fetch_task_steps(client, task_id, headers)
        if not steps:
            return None

        # Extract navigation flow
        navigation_flow = []
        seen_urls = set()
        for step in steps:
            step_url = (step.get("output") or {}).get("url", "")
            if step_url and step_url not in seen_urls:
                navigation_flow.append(step_url)
                seen_urls.add(step_url)

        # Extract form fields and patterns
        form_fields = []
        has_file_upload = False
        file_upload_method = None
        file_upload_element = None
        has_rich_text = False
        rich_text_method = None

        for step in steps:
            action_results = (step.get("output") or {}).get("action_results", []) or []
            for ar in action_results:
                action = ar.get("action", {}) if isinstance(ar.get("action"), dict) else {}
                action_type = action.get("action_type", "")
                element_id = action.get("element_id", "")
                success = ar.get("success", True)
                text = action.get("text", "")
                reasoning = action.get("reasoning", "")

                if action_type in ("input_text",):
                    form_fields.append({
                        "label": reasoning[:50] if reasoning else "",
                        "field_name": element_id,
                        "field_type": "text",
                        "action_type": action_type,
                        "was_filled": bool(text and success)
                    })
                    if "contenteditable" in str(ar).lower():
                        has_rich_text = True
                        rich_text_method = "contenteditable" if success else "failed"
                    elif "iframe" in str(ar).lower() or "tinymce" in str(ar).lower():
                        has_rich_text = True
                        rich_text_method = "iframe" if success else "failed"

                elif action_type == "upload_file":
                    has_file_upload = True
                    if success:
                        file_upload_method = "input_type_file"
                        file_upload_element = element_id
                    else:
                        file_upload_method = "failed"

                elif action_type in ("click", "select_option", "checkbox"):
                    form_fields.append({
                        "label": reasoning[:50] if reasoning else element_id,
                        "field_name": element_id,
                        "field_type": action_type,
                        "action_type": action_type,
                        "was_filled": bool(success)
                    })

        return {
            "site_domain": norm_domain,
            "site_type": detect_site_type(norm_domain),
            "outcome": outcome,
            "failure_reason": failure_reason,
            "form_fields": form_fields,
            "navigation_flow": navigation_flow,
            "total_steps": len(steps),
            "has_file_upload": has_file_upload,
            "file_upload_method": file_upload_method,
            "file_upload_element": file_upload_element,
            "has_rich_text_editor": has_rich_text,
            "rich_text_method": rich_text_method,
            "max_steps_used": max_steps_configured,
            "job_url": job_url,
            "application_id": app_id,
            "skyvern_task_id": task_id
        }


async def save_form_memory(memory: dict):
    """Save form interaction memory to site_form_memory table."""
    if not memory:
        return
    domain = memory.get("site_domain", "")
    outcome = memory.get("outcome", "failure")
    try:
        existing = supabase.table("site_form_memory") \
            .select("success_count, failure_count") \
            .eq("site_domain", domain) \
            .order("created_at", desc=True).limit(1).execute()
        prev_s = existing.data[0].get("success_count", 0) if existing.data else 0
        prev_f = existing.data[0].get("failure_count", 0) if existing.data else 0
        memory["success_count"] = prev_s + (1 if outcome == "success" else 0)
        memory["failure_count"] = prev_f + (1 if outcome == "failure" else 0)
        supabase.table("site_form_memory").insert(memory).execute()
        await log(f"📝 Memory saved: {domain} ({outcome}, {memory['success_count']}S/{memory['failure_count']}F)")
    except Exception as e:
        await log(f"⚠️ Failed to save form memory: {e}")


async def generate_skill_from_memory(memory: dict, task_id: str) -> str | None:
    """Use Gemini AI to analyze Skyvern step log and generate a reusable skill description.

    MetaClaw-inspired: converts raw task steps into a concise, actionable guide
    that can be injected into future navigation goals for the same site type.

    Key learning principles:
    - Successful attempts are the primary learning source
    - Failed attempts teach what to AVOID, but don't override what works
    - Previous skill text is preserved and evolved, not regenerated from scratch
    """
    if not GEMINI_API_KEY:
        return None

    domain = memory.get("site_domain", "unknown")
    site_type = memory.get("site_type", "generic")
    outcome = memory.get("outcome", "unknown")
    form_fields = memory.get("form_fields", [])
    nav_flow = memory.get("navigation_flow", [])
    total_steps = memory.get("total_steps", 0)
    has_file_upload = memory.get("has_file_upload", False)
    file_upload_method = memory.get("file_upload_method")
    has_rich_text = memory.get("has_rich_text_editor", False)
    rich_text_method = memory.get("rich_text_method")
    failure_reason = memory.get("failure_reason")

    # Fetch previous best skill for this domain (from successful attempts first)
    previous_skill = None
    try:
        prev_resp = supabase.table("site_form_memory") \
            .select("skill_text, outcome") \
            .eq("site_domain", domain) \
            .not_.is_("skill_text", "null") \
            .order("created_at", desc=True).limit(5).execute()
        if prev_resp.data:
            # Prefer skill from successful attempt
            for row in prev_resp.data:
                if row.get("outcome") == "success" and row.get("skill_text"):
                    previous_skill = row["skill_text"]
                    break
            # Fallback to any skill if no successful one exists
            if not previous_skill:
                previous_skill = prev_resp.data[0].get("skill_text")
    except Exception:
        pass

    # Build context for AI
    fields_summary = []
    for f in form_fields[:20]:
        label = f.get("label", "?")
        ftype = f.get("action_type", f.get("field_type", "?"))
        filled = "✓" if f.get("was_filled") else "✗"
        fields_summary.append(f"  {filled} {label} ({ftype})")

    nav_summary = " → ".join([u[:80] for u in nav_flow[:8]]) if nav_flow else "No navigation data"

    # Different prompts for success vs failure
    if outcome == "success":
        task_instruction = """This attempt SUCCEEDED. Generate an UPDATED SKILL GUIDE that:
1. Preserves everything that worked from the previous skill (if any)
2. Adds new learnings from this successful attempt
3. Provides a clear step-by-step guide for future automation on this site
4. Notes specific field types, navigation flow, and any tricky elements"""
    else:
        task_instruction = f"""This attempt FAILED (reason: {failure_reason or 'unknown'}).
Generate an UPDATED SKILL GUIDE that:
1. PRESERVES all successful patterns from the previous skill (these are proven to work!)
2. ADDS a "PITFALLS TO AVOID" section describing what went wrong this time
3. Suggests alternative approaches for the failure point
4. Does NOT discard working knowledge just because this attempt failed"""

    previous_skill_section = ""
    if previous_skill:
        previous_skill_section = f"""
EXISTING SKILL (from previous attempts - EVOLVE this, don't replace it):
---
{previous_skill[:1500]}
---
"""

    prompt = f"""You are a web automation expert. Analyze this form automation attempt and EVOLVE the skill guide for this site.

SITE: {domain} (type: {site_type})
OUTCOME: {outcome}
{f'FAILURE REASON: {failure_reason}' if failure_reason else ''}
TOTAL STEPS: {total_steps}
NAVIGATION FLOW: {nav_summary}
FILE UPLOAD: {'Yes, method: ' + str(file_upload_method) if has_file_upload else 'No'}
RICH TEXT EDITOR: {'Yes, method: ' + str(rich_text_method) if has_rich_text else 'No'}

FORM FIELDS (✓=filled, ✗=failed):
{chr(10).join(fields_summary) if fields_summary else 'No field data'}
{previous_skill_section}
{task_instruction}

Write the skill guide (max 400 words) in plain English. Structure it as:
- NAVIGATION FLOW: step-by-step what pages/buttons to expect
- FORM FIELDS: what sections/fields exist, types, which are tricky
- WHAT WORKS: proven successful patterns (from this or previous attempts)
- PITFALLS TO AVOID: what failed and how to work around it
- SITE-SPECIFIC TIPS: cookie handling, login flow, special UI elements

Be specific and actionable. No markdown headers, just numbered steps and bullet points."""

    try:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={GEMINI_API_KEY}"
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                url,
                headers={"Content-Type": "application/json"},
                json={
                    "contents": [{"parts": [{"text": prompt}]}],
                    "generationConfig": {
                        "maxOutputTokens": 2048,
                        "temperature": 0.3,
                        "thinkingConfig": {"thinkingBudget": 0}
                    }
                },
                timeout=30.0
            )
            if resp.status_code == 200:
                data = resp.json()
                # Gemini may return multiple parts (thinking + response), take the last text part
                parts = data["candidates"][0]["content"]["parts"]
                skill_text = ""
                for part in parts:
                    if "text" in part:
                        skill_text = part["text"].strip()  # Last text part is the response
                await log(f"🧠 Skill generated for {domain} ({len(skill_text)} chars)")
                return skill_text
            else:
                await log(f"⚠️ Skill generation failed: HTTP {resp.status_code}")
                return None
    except Exception as e:
        await log(f"⚠️ Skill generation error: {e}")
        return None


async def save_form_memory_with_skill(memory: dict, task_id: str):
    """Save form memory AND generate AI skill (MetaClaw-style learning)."""
    if not memory:
        return
    # Save basic memory first (always works, even without AI)
    await save_form_memory(memory)

    # Then generate and save skill (async, non-blocking on failure)
    try:
        skill_text = await generate_skill_from_memory(memory, task_id)
        if skill_text:
            domain = memory.get("site_domain", "")
            # Update the latest record with skill
            supabase.table("site_form_memory") \
                .update({"skill_text": skill_text}) \
                .eq("site_domain", domain) \
                .eq("skyvern_task_id", task_id) \
                .execute()
            await log(f"🧠 Skill saved for {domain}")

            # Update master skill with cross-domain learnings
            await update_master_skill(memory, skill_text)
    except Exception as e:
        await log(f"⚠️ Skill save error: {e}")


async def update_master_skill(memory: dict, latest_skill: str):
    """Aggregate cross-domain learnings into a master skill stored in site_form_memory.

    The master skill captures patterns that apply across ALL recruitment platforms,
    updated after each successful task to accumulate universal knowledge.
    """
    if not GEMINI_API_KEY:
        return
    outcome = memory.get("outcome", "unknown")
    # Only update master skill from successful attempts (proven knowledge)
    if outcome != "success":
        return

    domain = memory.get("site_domain", "unknown")

    try:
        # Fetch current master skill
        master_resp = supabase.table("site_form_memory") \
            .select("skill_text") \
            .eq("site_domain", "__master__") \
            .order("created_at", desc=True).limit(1).execute()
        current_master = master_resp.data[0]["skill_text"] if master_resp.data else None

        # Fetch recent successful skills across all domains (for cross-domain patterns)
        recent_resp = supabase.table("site_form_memory") \
            .select("site_domain, skill_text, outcome") \
            .eq("outcome", "success") \
            .not_.is_("skill_text", "null") \
            .order("created_at", desc=True).limit(10).execute()
        recent_skills = recent_resp.data if recent_resp.data else []

        # Build summary of what works across domains
        domain_summaries = []
        seen_domains = set()
        for row in recent_skills:
            d = row.get("site_domain", "")
            if d and d not in seen_domains and d != "__master__":
                seen_domains.add(d)
                skill_snippet = (row.get("skill_text") or "")[:200]
                domain_summaries.append(f"  - {d}: {skill_snippet}")
        if len(domain_summaries) < 2:
            return  # Not enough data to build useful cross-domain patterns

        current_master_section = ""
        if current_master:
            current_master_section = f"""
CURRENT MASTER SKILL (evolve this, preserve proven patterns):
---
{current_master[:1500]}
---
"""

        prompt = f"""You are a web automation expert. Update the MASTER SKILL — a universal guide for Norwegian recruitment form automation.

A new successful submission just happened on: {domain}
Latest skill from this domain:
{latest_skill[:500]}

Recent successful domain skills:
{chr(10).join(domain_summaries[:8])}
{current_master_section}
Generate an updated MASTER SKILL (max 500 words) that captures UNIVERSAL patterns across all platforms:
1. Common navigation patterns (cookie consent, login vs register, multi-step forms)
2. Common field types and how to handle them (dropdowns, autocomplete, rich text, file upload)
3. Common pitfalls and how to avoid them (validated from multiple domains)
4. Norwegian-specific patterns (field labels, button text, form structure)

Only include patterns that are confirmed across 2+ platforms. Be specific and actionable.
No markdown headers, just numbered steps and bullet points."""

        url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={GEMINI_API_KEY}"
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                url,
                headers={"Content-Type": "application/json"},
                json={
                    "contents": [{"parts": [{"text": prompt}]}],
                    "generationConfig": {
                        "maxOutputTokens": 2048,
                        "temperature": 0.3,
                        "thinkingConfig": {"thinkingBudget": 0}
                    }
                },
                timeout=30.0
            )
            if resp.status_code == 200:
                data = resp.json()
                parts = data["candidates"][0]["content"]["parts"]
                master_text = ""
                for part in parts:
                    if "text" in part:
                        master_text = part["text"].strip()
                if master_text:
                    # Upsert master skill as a special __master__ domain entry
                    supabase.table("site_form_memory").insert({
                        "site_domain": "__master__",
                        "site_type": "master",
                        "outcome": "success",
                        "skill_text": master_text,
                        "success_count": len([s for s in recent_skills if s.get("outcome") == "success"]),
                        "failure_count": 0,
                        "total_steps": 0
                    }).execute()
                    await log(f"🧠 Master skill updated ({len(master_text)} chars, {len(seen_domains)} domains)")
            else:
                await log(f"⚠️ Master skill generation failed: HTTP {resp.status_code}")
    except Exception as e:
        await log(f"⚠️ Master skill update error: {e}")


async def get_form_memory(domain: str) -> dict:
    """Retrieve latest successful form memory for a domain, enriched with master skill."""
    norm = normalize_domain_for_memory(domain)
    try:
        memory = None
        # Prefer successful memory with skill
        resp = supabase.table("site_form_memory") \
            .select("*").eq("site_domain", norm).eq("outcome", "success") \
            .order("created_at", desc=True).limit(1).execute()
        if resp.data:
            memory = resp.data[0]
            await log(f"📝 Memory found: {norm} (success, {memory.get('total_steps', '?')} steps)")
        else:
            # Fallback to any memory
            resp = supabase.table("site_form_memory") \
                .select("*").eq("site_domain", norm) \
                .order("created_at", desc=True).limit(1).execute()
            if resp.data:
                memory = resp.data[0]
                await log(f"📝 Memory found: {norm} (failure only)")

        # Fetch AI-generated master skill (cross-domain patterns)
        try:
            master_resp = supabase.table("site_form_memory") \
                .select("skill_text") \
                .eq("site_domain", "__master__") \
                .order("created_at", desc=True).limit(1).execute()
            if master_resp.data and master_resp.data[0].get("skill_text"):
                master_skill = master_resp.data[0]["skill_text"]
                if memory:
                    memory["_master_skill"] = master_skill
                else:
                    # No domain memory, but we have master skill — return a minimal dict
                    memory = {"_master_skill": master_skill}
                await log(f"🧠 Master skill loaded ({len(master_skill)} chars)")
        except Exception:
            pass

        return memory
    except Exception as e:
        await log(f"⚠️ Failed to get form memory: {e}")
        return None


async def get_domain_stats(domain: str) -> dict:
    """Get aggregated success/failure stats for a domain."""
    norm = normalize_domain_for_memory(domain)
    try:
        resp = supabase.table("site_form_memory") \
            .select("outcome, failure_reason, total_steps, created_at") \
            .eq("site_domain", norm).order("created_at", desc=True).limit(20).execute()
        if not resp.data:
            return {"success_count": 0, "failure_count": 0, "success_rate": 0.0,
                    "common_failures": [], "avg_steps_success": 0, "confidence": "none"}
        successes = [r for r in resp.data if r["outcome"] == "success"]
        failures = [r for r in resp.data if r["outcome"] == "failure"]
        total = len(resp.data)
        sc, fc = len(successes), len(failures)
        reasons = {}
        for f in failures:
            r = f.get("failure_reason", "unknown") or "unknown"
            reasons[r] = reasons.get(r, 0) + 1
        common = sorted([{"reason": r, "count": c} for r, c in reasons.items()],
                        key=lambda x: x["count"], reverse=True)
        steps = [s.get("total_steps", 0) for s in successes if s.get("total_steps")]
        avg = sum(steps) / len(steps) if steps else 0
        confidence = "high" if sc >= 3 else ("medium" if sc >= 1 else ("low" if fc > 0 else "none"))
        return {"success_count": sc, "failure_count": fc,
                "success_rate": sc / total if total else 0.0,
                "common_failures": common, "avg_steps_success": avg, "confidence": confidence}
    except Exception as e:
        await log(f"⚠️ Failed to get domain stats: {e}")
        return {"success_count": 0, "failure_count": 0, "success_rate": 0.0,
                "common_failures": [], "confidence": "none"}


async def _calc_max_steps(domain: str, default: int, memory: dict = None, stats: dict = None) -> int:
    """Calculate max_steps_per_run based on form memory and confidence."""
    if not memory or not stats:
        return default
    confidence = stats.get("confidence", "none")
    historical = memory.get("total_steps", 0)
    if not historical:
        return default
    if confidence == "high":
        result = min(int(historical * 1.3), 45)
    elif confidence == "medium":
        result = min(int(historical * 1.5), 50)
    elif confidence == "low":
        result = min(default + 10, 55)
    else:
        return default
    result = max(result, default)  # never go below default
    if result != default:
        await log(f"📝 Adjusted max_steps: {result} ({confidence} confidence, historical: {historical})")
    return result


def build_task_prompt(navigation_goal: str, data_extraction_goal: str = None,
                       complete_criterion: str = None, terminate_criterion: str = None,
                       navigation_payload: dict = None) -> str:
    """Merge the old Skyvern v1 task fields (navigation_goal, data_extraction_goal,
    complete_criterion, terminate_criterion, navigation_payload) into the single
    free-text `prompt` field required by the new Skyvern Task Run API
    (POST /v1/run/tasks — see TaskRunRequest, whose only required field is `prompt`).

    No instruction content is dropped or summarized — every old field that had text
    is appended as its own clearly labeled paragraph so the agent still receives the
    exact same instructions, just consolidated into one string. `navigation_payload`
    (candidate/profile data referenced by name inside several site-specific
    navigation_goal templates, e.g. "Use 'cover_letter' from navigation_payload") is
    serialized as JSON and appended last, under a heading that still says
    "navigation_payload" so those in-text references keep resolving correctly.
    """
    parts = [navigation_goal.strip()]
    if data_extraction_goal:
        parts.append(f"DATA TO EXTRACT / DETERMINE:\n{data_extraction_goal}")
    if complete_criterion:
        parts.append(f"TASK IS COMPLETE WHEN:\n{complete_criterion}")
    if terminate_criterion:
        parts.append(f"TERMINATE THE TASK IF:\n{terminate_criterion}")
    if navigation_payload:
        parts.append(
            "navigation_payload (reference data for the fields above — use these "
            "exact values whenever the instructions above refer to \"navigation_payload\" "
            "or \"payload\"):\n" + json.dumps(navigation_payload, ensure_ascii=False, default=str)
        )
    return "\n\n".join(parts)


async def submit_skyvern_task_with_retry(payload: dict, description: str = "task") -> Optional[str]:
    """Submit a task to Skyvern with retry and exponential backoff.

    Returns run_id on success, None on failure.
    """
    headers = skyvern_headers()

    for attempt in range(RETRY_ATTEMPTS):
        try:
            if attempt == 0:
                # Quick health check before first attempt
                healthy = await check_skyvern_health()
                if not healthy:
                    await log(f"⚠️ Skyvern health check failed before submitting {description}")

            async with httpx.AsyncClient() as client:
                await log(f"🚀 Sending {description} to Skyvern (attempt {attempt + 1}/{RETRY_ATTEMPTS})...")
                response = await client.post(
                    f"{SKYVERN_URL}/v1/run/tasks",
                    json=payload,
                    headers=headers,
                    timeout=30.0
                )

                if response.status_code == 200:
                    task_data = response.json()
                    run_id = task_data.get('run_id')
                    await log(f"✅ Skyvern Task Started! ID: {run_id}")
                    return run_id
                else:
                    await log(f"❌ Skyvern API Error (attempt {attempt + 1}): {response.text}")

        except httpx.ConnectError as e:
            await log(f"❌ Skyvern not reachable (attempt {attempt + 1}): {e}")
        except Exception as e:
            await log(f"❌ Skyvern request failed (attempt {attempt + 1}): {e}")

        # Backoff before next retry (skip after last attempt)
        if attempt < RETRY_ATTEMPTS - 1:
            wait = RETRY_BACKOFF[min(attempt, len(RETRY_BACKOFF) - 1)]
            await log(f"⏳ Retrying in {wait}s...")
            await asyncio.sleep(wait)

    await log(f"❌ All {RETRY_ATTEMPTS} attempts failed for {description}")
    return None


async def cleanup_stuck_applications():
    """Find and fail applications stuck in 'sending' status for too long."""
    try:
        # Release stale claims from any crashed workers
        try:
            result = supabase.rpc("release_stale_claims", {
                "p_timeout_minutes": STUCK_TIMEOUT_MINUTES
            }).execute()
            if result.data and result.data > 0:
                await log(f"🔓 Released {result.data} stale claim(s) from crashed workers")
        except Exception:
            pass  # Function may not exist yet (pre-migration)

        cutoff = (datetime.now(timezone.utc) - timedelta(minutes=STUCK_TIMEOUT_MINUTES)).isoformat()
        response = supabase.table("applications") \
            .select("id, job_id, updated_at") \
            .eq("status", "sending") \
            .lt("updated_at", cutoff) \
            .execute()

        if not response.data:
            return

        count = len(response.data)
        await log(f"🧹 Found {count} stuck application(s) (>{STUCK_TIMEOUT_MINUTES}min in 'sending')")

        for app in response.data:
            supabase.table("applications").update({
                "status": "failed",
                "worker_id": None,
                "claimed_at": None,
                "skyvern_metadata": {
                    "error_message": f"Timed out: stuck in 'sending' for >{STUCK_TIMEOUT_MINUTES} minutes. Worker may have restarted or Skyvern was unavailable.",
                    "failed_at": datetime.now().isoformat(),
                    "failure_reason": "stuck_timeout"
                }
            }).eq("id", app["id"]).execute()
            await log(f"   ❌ App {app['id'][:8]}... → failed (stuck timeout)")

        # Cleanup expired application confirmations and FINN auth requests
        try:
            conf_result = supabase.rpc("cleanup_expired_confirmations").execute()
            finn_result = supabase.rpc("cleanup_expired_finn_auth_requests").execute()
            cleaned_conf = conf_result.data or 0
            cleaned_finn = finn_result.data or 0
            if cleaned_conf > 0 or cleaned_finn > 0:
                await log(f"🗑️ Cleaned up {cleaned_conf} expired confirmation(s), {cleaned_finn} expired FINN auth request(s)")
        except Exception:
            pass  # Functions may not exist yet (pre-migration)

    except Exception as e:
        await log(f"⚠️ Cleanup error: {e}")


def clear_claim(app_id: str, extra_fields: dict = None):
    """Clear worker claim after processing (success or failure)."""
    update = {"worker_id": None, "claimed_at": None}
    if extra_fields:
        update.update(extra_fields)
    try:
        supabase.table("applications").update(update).eq("id", app_id).execute()
    except Exception as e:
        _file_logger.error(f"⚠️ clear_claim failed for {app_id}: {e}")


def normalize_phone_for_norway(phone: str) -> str:
    """
    Normalize phone number for Norwegian forms.
    - Remove +47 country code
    - Remove spaces and dashes
    - Keep just 8 digits for Norwegian mobile numbers

    Examples:
    - "+47 925 64 334" -> "92564334"
    - "925 64 334" -> "92564334"
    - "+47-925-64-334" -> "92564334"
    """
    if not phone:
        return ""

    # Remove all non-digit characters
    digits = re.sub(r'\D', '', phone)

    # If starts with 47 and has 10+ digits, remove country code
    if digits.startswith('47') and len(digits) >= 10:
        digits = digits[2:]

    # Norwegian mobile numbers are 8 digits
    return digits


# ============================================
# FLOW ROUTER - Routes to appropriate handler
# based on application_form_type
# ============================================

class FlowRouter:
    """
    Routes job applications to the appropriate flow handler
    based on application_form_type.

    Form Types:
    - finn_easy: FINN Enkel Søknad with 2FA login
    - external_form: Simple one-page external form
    - external_registration: Requires registration first
    - email: Email-based application
    - unknown: Needs classification first
    """

    @staticmethod
    async def route(
        form_type: str,
        app_id: str,
        job_data: dict,
        app_data: dict,
        chat_id: str
    ) -> dict:
        """
        Route to appropriate flow based on form type.

        Returns:
            {"success": bool, "status": str, "message": str, "flow": str}
        """
        await log(f"🔀 FlowRouter: form_type={form_type}")

        # Determine which flow to use
        if form_type == 'finn_easy':
            return await FlowRouter._handle_finn_easy(app_id, job_data, app_data, chat_id)

        elif form_type == 'external_form':
            return await FlowRouter._handle_external_form(app_id, job_data, app_data, chat_id)

        elif form_type == 'external_registration':
            return await FlowRouter._handle_external_registration(app_id, job_data, app_data, chat_id)

        elif form_type == 'email':
            return await FlowRouter._handle_email_application(app_id, job_data, app_data, chat_id)

        else:  # unknown or unrecognized
            return await FlowRouter._handle_unknown(app_id, job_data, app_data, chat_id)

    @staticmethod
    async def _handle_finn_easy(app_id: str, job_data: dict, app_data: dict, chat_id: str) -> dict:
        """Handle FINN Enkel Søknad - uses 2FA login flow."""
        await log("📋 Flow: FINN Enkel Søknad (2FA)")

        # This flow is handled by the existing FINN logic in process_application
        # Return special marker to use existing flow
        return {
            "success": True,
            "status": "use_finn_flow",
            "message": "Routing to FINN Enkel Søknad flow",
            "flow": "finn_easy"
        }

    @staticmethod
    async def _handle_external_form(app_id: str, job_data: dict, app_data: dict, chat_id: str) -> dict:
        """
        Handle simple external form - one page, no registration required.
        Uses Hybrid Flow: Extract → Match → Confirm → Fill
        """
        await log("📋 Flow: External Form (Hybrid)")

        external_url = job_data.get('external_apply_url') or job_data.get('job_url')
        domain = extract_domain(external_url)
        site_type = detect_site_type(domain)
        user_id = job_data.get('user_id')

        await log(f"   Site: {domain} (type: {site_type})")
        await log(f"   Supported: {is_site_supported(domain)}")

        # Check if we have credentials for this site
        credentials = await get_site_credentials(domain, user_id)
        if credentials:
            await log(f"   ✅ Credentials found for {domain}")

        # Use hybrid flow for extraction and matching
        return {
            "success": True,
            "status": "use_hybrid_flow",
            "message": f"Routing to Hybrid Flow for {site_type}",
            "flow": "external_form",
            "site_type": site_type,
            "credentials": credentials
        }

    @staticmethod
    async def _handle_external_registration(app_id: str, job_data: dict, app_data: dict, chat_id: str) -> dict:
        """
        Handle registration-required forms.
        Flow: Check credentials → Register if needed → Login → Fill form
        """
        await log("📋 Flow: External Registration Required")

        external_url = job_data.get('external_apply_url') or job_data.get('job_url')
        domain = extract_domain(external_url)
        site_type = detect_site_type(domain)
        user_id = job_data.get('user_id')

        await log(f"   Site: {domain} (type: {site_type})")

        # Step 1: Check if we have credentials
        credentials = await get_site_credentials(domain, user_id)

        if credentials:
            await log(f"   ✅ Credentials found - will login and apply")
            return {
                "success": True,
                "status": "has_credentials",
                "message": f"Will login to {domain} and apply",
                "flow": "external_registration",
                "site_type": site_type,
                "credentials": credentials,
                "needs_registration": False
            }
        else:
            # No credentials — trigger registration for this site
            # Trust the application_form_type from DB: if it says external_registration, register
            await log(f"   ⚠️ No credentials for {domain} (type: {site_type}) - need to register first")
            return {
                "success": True,
                "status": "needs_registration",
                "message": f"Need to register on {domain} first",
                "flow": "external_registration",
                "site_type": site_type,
                "credentials": None,
                "needs_registration": True
            }

    @staticmethod
    async def _handle_email_application(app_id: str, job_data: dict, app_data: dict, chat_id: str) -> dict:
        """
        Handle email-based applications.
        Flow: Generate email draft → Notify user → User sends manually
        """
        await log("📋 Flow: Email Application")

        job_title = job_data.get('title', 'Unknown')
        company = job_data.get('company', 'Unknown')
        cover_letter = app_data.get('cover_letter_no', '')

        # Get email address from job description if available
        # For now, notify user to send manually
        await log("   📧 Email applications require manual sending")

        # Send notification to Telegram
        if chat_id and TELEGRAM_BOT_TOKEN:
            message = (
                f"📧 *Заявка через email*\n\n"
                f"🏢 *{company}*\n"
                f"💼 {job_title}\n\n"
                f"Ця вакансія вимагає подачі через email.\n"
                f"Будь ласка, надішли заявку вручну.\n\n"
                f"📝 Søknadsbrev готовий в системі."
            )
            await send_telegram(chat_id, message)

        return {
            "success": True,
            "status": "email_required",
            "message": "Email application - manual sending required",
            "flow": "email"
        }

    @staticmethod
    async def _handle_unknown(app_id: str, job_data: dict, app_data: dict, chat_id: str) -> dict:
        """
        Handle unknown form type - try to classify first.
        """
        await log("📋 Flow: Unknown - will try to classify")

        external_url = job_data.get('external_apply_url') or job_data.get('job_url')

        if not external_url:
            await log("   ❌ No URL available to classify")
            return {
                "success": False,
                "status": "no_url",
                "message": "No application URL available",
                "flow": "unknown"
            }

        domain = extract_domain(external_url)
        site_type = detect_site_type(domain)
        user_id = job_data.get('user_id')

        await log(f"   Site detected: {site_type}")

        # Block platforms too heavy for local Skyvern
        if site_type in BLOCKED_PLATFORMS:
            await log(f"   ⛔ Platform {site_type} is BLOCKED (too heavy for local Skyvern)")
            if chat_id:
                await send_telegram(str(chat_id),
                    f"⛔ <b>Платформа не підтримується!</b>\n\n"
                    f"📋 {job_data.get('title', 'Job')}\n"
                    f"🏢 {job_data.get('company', '')}\n"
                    f"🌐 {domain}\n\n"
                    f"Платформа <b>{site_type.capitalize()}</b> занадто важка для автоматичного заповнення.\n\n"
                    f"<b>Що робити:</b>\n"
                    f"Відкрийте сайт та заповніть форму вручну.\n"
                    f"Супровідний лист збережений в системі.",
                    {"inline_keyboard": [[
                        {"text": "🔗 Відкрити сайт", "url": external_url}
                    ]]}
                )
            return {
                "success": False,
                "status": "blocked_platform",
                "message": f"Platform {site_type} is blocked (too heavy for local Skyvern)",
                "flow": "blocked"
            }

        # Check for known registration-required platforms
        registration_platforms = ['recman', 'cvpartner', 'hrmanager', 'successfactors', 'csod', 'jobbnorge']
        if site_type in registration_platforms:
            await log(f"   → Classifying as external_registration (known platform)")
            return await FlowRouter._handle_external_registration(app_id, job_data, app_data, chat_id)

        # Check if we have credentials (suggests we've registered before)
        credentials = await get_site_credentials(domain, user_id)
        if credentials:
            await log(f"   → Has credentials, treating as external_form")
            return {
                "success": True,
                "status": "use_hybrid_flow",
                "message": f"Unknown form type but has credentials for {domain}",
                "flow": "external_form",
                "site_type": site_type,
                "credentials": credentials
            }

        # Skip hybrid flow for platforms with heavy JS DOM (extraction hangs)
        skip_hybrid_platforms = ['workday', 'successfactors']
        if site_type in skip_hybrid_platforms:
            await log(f"   → Skipping hybrid flow for {site_type} (heavy JS DOM)")
            return {
                "success": True,
                "status": "direct_fill",
                "message": f"{site_type} — direct form filling (no extraction)",
                "flow": "external_form",
                "site_type": site_type,
                "credentials": credentials
            }

        # Default: try hybrid flow
        await log(f"   → Defaulting to hybrid flow")
        return {
            "success": True,
            "status": "use_hybrid_flow",
            "message": f"Unknown form type, using hybrid flow",
            "flow": "external_form",
            "site_type": site_type,
            "credentials": None
        }


# ============================================
# SITE CREDENTIALS MANAGEMENT
# ============================================

def extract_domain(url: str) -> str:
    """Extract domain from URL (e.g., 'webcruiter.no' from 'https://www.webcruiter.no/...')."""
    try:
        parsed = urlparse(url)
        domain = parsed.netloc.lower()
        if domain.startswith('www.'):
            domain = domain[4:]
        return domain
    except Exception:
        return url


async def get_site_credentials(domain: str, user_id: str = None) -> dict | None:
    """Check if credentials exist for a site domain, scoped to user_id.

    Returns credentials for active sites or magic_link status for sites
    that require manual login.
    """
    try:
        query = supabase.table("site_credentials") \
            .select("*") \
            .eq("site_domain", domain) \
            .in_("status", ["active", "inactive"])
        if user_id:
            query = query.eq("user_id", user_id)
        response = query.limit(1).execute()

        if response.data and len(response.data) > 0:
            creds = response.data[0]
            reg_data = creds.get('registration_data', {}) or {}
            if reg_data.get('auth_type') == 'magic_link':
                creds['auth_type'] = 'magic_link'  # For backward compat with caller checks
                await log(f"🔗 Found magic_link record for {domain}")
            else:
                await log(f"✅ Found credentials for {domain}")
            return creds
        return None
    except Exception as e:
        await log(f"⚠️ Failed to check credentials for {domain}: {e}")
        return None


async def check_credentials_for_url(url: str, user_id: str = None) -> tuple:
    """Check if we have credentials for the URL's domain.

    Returns: (has_credentials: bool, credentials: dict | None, domain: str)

    Note: has_credentials is True only for active credentials, not magic_link.
    The credentials dict is still returned for magic_link sites so caller
    can check auth_type and handle accordingly.
    """
    domain = extract_domain(url)
    creds = await get_site_credentials(domain, user_id)
    # Only consider as "has credentials" if status is active (not magic_link)
    has_active_creds = creds is not None and creds.get('status') == 'active'
    return (has_active_creds, creds, domain)


async def mark_site_as_magic_link(domain: str):
    """Mark a site as using magic link authentication in site_credentials."""
    try:
        # Check if record exists
        response = supabase.table("site_credentials") \
            .select("id, status") \
            .eq("site_domain", domain) \
            .limit(1) \
            .execute()

        if response.data and len(response.data) > 0:
            # SAFEGUARD: Never overwrite active credentials with magic_link
            # This prevents poisoning valid credentials from false positives
            existing_status = response.data[0].get('status', '')
            if existing_status == 'active':
                await log(f"⚠️ SKIPPING magic_link marking for {domain} — active credentials exist!")
                return
            # Update existing inactive record
            supabase.table("site_credentials").update({
                "status": "inactive",
                "registration_data": {"auth_type": "magic_link", "note": "Uses magic link - manual login required"}
            }).eq("site_domain", domain).execute()
            await log(f"📝 Updated {domain} as magic_link site")
        else:
            # Create new record
            supabase.table("site_credentials").insert({
                "site_domain": domain,
                "email": "magic_link@placeholder",
                "password": "",
                "status": "inactive",
                "registration_data": {"auth_type": "magic_link", "note": "Uses magic link - manual login required"}
            }).execute()
            await log(f"📝 Created magic_link record for {domain}")
    except Exception as e:
        await log(f"⚠️ Failed to mark {domain} as magic_link: {e}")


async def trigger_registration(domain: str, registration_url: str, job_id: str = None, application_id: str = None, user_id: str = None) -> str | None:
    """Trigger registration flow for a site. Returns flow_id or None."""
    try:
        chat_id = await get_telegram_chat_id_for_user(user_id)
        profile = await get_active_profile_full(user_id)

        # Get email for registration
        email = os.getenv("DEFAULT_REGISTRATION_EMAIL", "")
        if not email:
            structured = profile.get('structured_content', {}) or {}
            personal_info = structured.get('personalInfo', {})
            email = personal_info.get('email', '')

        if not email:
            await log(f"❌ No email available for registration on {domain}")
            return None

        # Generate password
        import secrets
        import string
        password_chars = string.ascii_letters + string.digits + "!@#$%^&*"
        password = ''.join(secrets.choice(password_chars) for _ in range(16))

        from datetime import timedelta
        data = {
            "site_domain": domain,
            "site_name": domain.split('.')[0].capitalize(),
            "registration_url": registration_url,
            "job_id": job_id,
            "application_id": application_id,
            "status": "pending",
            "registration_email": email,
            "generated_password": password,
            "telegram_chat_id": chat_id,
            "expires_at": (datetime.now() + timedelta(minutes=30)).isoformat()
        }

        response = supabase.table("registration_flows").insert(data).execute()

        if response.data and len(response.data) > 0:
            flow_id = response.data[0]['id']
            await log(f"📝 Registration flow created: {flow_id}")
            return flow_id
        return None
    except Exception as e:
        await log(f"❌ Failed to create registration flow: {e}")
        return None


async def trigger_registration_flow(
    domain: str,
    job_id: str,
    app_id: str,
    chat_id: str,
    job_title: str,
    external_url: str,
    user_id: str = None
) -> str | None:
    """
    Credentials check and registration flow:
    1. Check if login/password exists in DB for this domain
    2. If YES → log "Found credentials", return None (caller proceeds with login)
    3. If NO → ask user in Telegram: "No credentials found for X. Do you have an account?"
       - User sends password → save credentials, return None (caller logs in)
       - User says "No / Register" → start registration flow, return flow_id
       - User says "Skip" → return None (proceed without creds)

    Returns flow_id (registration started) or None (use existing creds or skip)
    """
    await log(f"🔍 Перевіряю логін/пароль для {domain}...")

    # Step 1: Check if credentials exist in DB
    try:
        query = supabase.table("site_credentials") \
            .select("email, password, status") \
            .eq("site_domain", domain).eq("status", "active")
        if user_id:
            query = query.eq("user_id", user_id)
        creds_resp = query.limit(1).execute()

        # Also check without user_id filter (legacy records)
        if not creds_resp.data:
            creds_resp = supabase.table("site_credentials") \
                .select("email, password, status") \
                .eq("site_domain", domain).eq("status", "active") \
                .limit(1).execute()

        if creds_resp.data:
            cred = creds_resp.data[0]
            await log(f"✅ Знайдено логін/пароль для {domain}: {cred['email']}")
            if chat_id:
                await send_tech_telegram(chat_id,
                    f"🔐 <b>Знайдено логін/пароль для {domain}</b>\n"
                    f"📧 {cred['email']}\n"
                    f"⏳ Починаю авторизацію..."
                )
            return None  # Caller will use credentials for login
    except Exception as e:
        await log(f"⚠️ Failed to check credentials: {e}")

    # Step 2: No credentials — ask user in Telegram
    reg_email = None
    try:
        profile = await get_active_profile_full(user_id)
        if profile and profile.get('structured_content'):
            reg_email = profile['structured_content'].get('personalInfo', {}).get('email', '')
    except Exception:
        pass
    reg_email = reg_email or "stuardbmw@gmail.com"

    if chat_id:
        password_answer = await ask_skyvern_question(
            user_id=user_id,
            field_name=f"password_for_{domain}",
            question_text=(
                f"🔍 <b>В базі не знайдено логін та пароль для:</b>\n"
                f"🌐 <code>{domain}</code>\n\n"
                f"📧 Email: <code>{reg_email}</code>\n\n"
                f"Якщо у вас є акаунт — надішліть пароль текстом.\n"
                f"Якщо немає — оберіть дію нижче:"
            ),
            job_title=job_title,
            company=domain,
            options=["Немає акаунту — зареєструвати", "Пропустити"],
            timeout_seconds=300,
            job_id=job_id
        )

        if not password_answer:
            await log(f"⏰ Timeout — немає відповіді для {domain}")
            return None

        if 'пропустити' in password_answer.lower():
            await log(f"⏭️ Користувач пропустив {domain}")
            return None

        # User says "no account" or "register" → start registration
        if 'немає' in password_answer.lower() or 'зареєструвати' in password_answer.lower():
            await log(f"📝 Користувач підтвердив: немає акаунту. Починаю реєстрацію на {domain}")
            if chat_id:
                await send_tech_telegram(chat_id,
                    f"📝 <b>Починаю реєстрацію на {domain}</b>\n"
                    f"📧 {reg_email}\n"
                    f"⏳ Створюю акаунт з вашими даними..."
                )
            # Fall through to registration below

        else:
            # User provided a password — save and return
            try:
                upsert_data = {
                    "site_domain": domain,
                    "email": reg_email,
                    "password": password_answer.strip(),
                    "status": "active",
                }
                if user_id:
                    upsert_data["user_id"] = user_id
                supabase.table("site_credentials").upsert(
                    upsert_data, on_conflict="site_domain,email"
                ).execute()
                await log(f"💾 Пароль збережено для {domain}")
                await send_tech_telegram(chat_id,
                    f"✅ <b>Пароль збережено для {domain}!</b>\n"
                    f"📧 {reg_email}\n"
                    f"⏳ Починаю авторизацію..."
                )
            except Exception as e:
                await log(f"⚠️ Failed to save credentials: {e}")
            return None  # Caller will re-check credentials and proceed with login

    # User chose registration or timeout — proceed
    await log(f"📝 Starting registration for {domain}")

    flow_id = await trigger_registration(
        domain=domain,
        registration_url=external_url,
        job_id=job_id,
        application_id=app_id,
        user_id=user_id
    )

    if flow_id:
        if chat_id and TELEGRAM_BOT_TOKEN:
            await send_tech_telegram(chat_id,
                f"📝 <b>Реєстрація на {domain}</b>\n"
                f"💼 {job_title}\n\n"
                f"⏳ Створюю акаунт..."
            )

        supabase.table("applications").update({
            "status": "manual_review",
            "skyvern_metadata": {
                "domain": domain,
                "registration_flow_id": flow_id,
                "waiting_for_registration": True
            }
        }).eq("id", app_id).execute()

        return flow_id
    else:
        # Registration failed to start
        supabase.table("applications").update({
            "status": "failed",
            "error_message": f"Failed to start registration on {domain}"
        }).eq("id", app_id).execute()

        if chat_id and TELEGRAM_BOT_TOKEN:
            await send_tech_telegram(
                chat_id,
                f"❌ Не вдалося почати реєстрацію на {domain}"
            )

        return None


async def handle_login_failure(
    domain: str, user_id: str, chat_id: str,
    job_title: str = "", job_id: str = None,
    app_id: str = None, external_url: str = None
) -> str:
    """Handle login failure: ask user if they have account, get password or register.

    Returns: 'retry' (password updated), 'register' (registration started),
             'skip' (user skipped), 'failed' (error/timeout)
    """
    old_creds = await get_site_credentials(domain, user_id)
    old_email = old_creds.get('email', '') if old_creds else ''

    # Step 1: Ask if user has an account
    answer = await ask_skyvern_question(
        user_id=user_id,
        field_name=f"account_check_{domain}",
        question_text=(
            f"🔒 <b>Логін не вдався на {domain}</b>\n\n"
            f"Пароль в базі не підходить для:\n"
            f"📧 <code>{old_email}</code>\n\n"
            f"Чи є у вас акаунт на цьому сайті?"
        ),
        job_title=job_title,
        company=domain,
        options=["Так, надішлю пароль", "Ні, зареєструвати", "Пропустити"],
        timeout_seconds=300,
        job_id=job_id
    )

    if not answer:
        await log(f"⏰ Login recovery timeout for {domain}")
        return 'failed'

    answer_lower = answer.lower()

    # User wants to skip
    if 'пропустити' in answer_lower:
        return 'skip'

    # User wants to register new account
    if 'зареєструвати' in answer_lower:
        await log(f"📝 User chose registration for {domain}")
        if app_id and external_url:
            flow_id = await trigger_registration(
                domain=domain,
                registration_url=external_url,
                job_id=job_id,
                application_id=app_id,
                user_id=user_id
            )
            if flow_id and chat_id:
                await send_tech_telegram(chat_id,
                    f"📝 <b>Реєстрація на {domain}</b>\n⏳ Створюю акаунт..."
                )
            return 'register'
        return 'failed'

    # User chose "yes, I'll send password" — now wait for the actual password
    if 'надішлю пароль' in answer_lower:
        password = await ask_skyvern_question(
            user_id=user_id,
            field_name=f"new_password_{domain}",
            question_text=(
                f"🔑 Надішліть пароль для {domain}\n"
                f"📧 <code>{old_email}</code>"
            ),
            job_title=job_title,
            company=domain,
            timeout_seconds=300,
            job_id=job_id
        )
        if password:
            answer = password  # Fall through to save
        else:
            return 'failed'

    # User sent password directly (text answer, not button)
    try:
        supabase.table("site_credentials").update({
            "password": answer.strip()
        }).eq("site_domain", domain).eq("user_id", user_id).execute()
        await log(f"💾 Password updated for {domain}")
        await send_tech_telegram(chat_id,
            f"✅ Пароль оновлено для {domain}!\n⏳ Спробую подати заявку знову..."
        )
        return 'retry'
    except Exception as e:
        await log(f"⚠️ Failed to save password: {e}")
        return 'failed'


async def get_telegram_chat_id() -> str | None:
    """Get Telegram chat ID from user settings."""
    try:
        response = supabase.table("user_settings") \
            .select("telegram_chat_id") \
            .limit(1) \
            .execute()

        if response.data and len(response.data) > 0:
            return response.data[0].get('telegram_chat_id')
        return None
    except Exception:
        return None


async def get_active_profile_full(user_id: str = None) -> dict:
    """Get full active CV profile including structured_content for a specific user."""
    try:
        query = supabase.table("cv_profiles") \
            .select("*") \
            .eq("is_active", True)
        if user_id:
            query = query.eq("user_id", user_id)
        response = query.limit(1).execute()

        if response.data and len(response.data) > 0:
            return response.data[0]
        return {}
    except Exception:
        return {}


# NOTE: Browser Sessions removed - Skyvern API returns 404 (not supported)


def extract_finnkode(url: str) -> str | None:
    """Extract finnkode from FINN URL using multiple patterns."""
    if not url or 'finn.no' not in url:
        return None

    # Pattern 0: Query parameter adId format - ?adId=123456789 (used in /job/apply URLs)
    match = re.search(r'[?&]adId=(\d+)', url)
    if match:
        return match.group(1)

    # Pattern 1: Query parameter format - ?finnkode=123456789 or &finnkode=123456789
    match = re.search(r'[?&]finnkode=(\d+)', url)
    if match:
        return match.group(1)

    # Pattern 2: Path-based format - /job/123456789 or /job/123456789.html
    match = re.search(r'/job/(\d{8,})(?:\.html|\?|$)', url)
    if match:
        return match.group(1)

    # Pattern 3: Old format - /ad/123456789 or /ad.html?finnkode=...
    match = re.search(r'/ad[/.](\d{8,})(?:\?|$)', url)
    if match:
        return match.group(1)

    # Pattern 4: Just a number at the end of URL path (8+ digits)
    match = re.search(r'/(\d{8,})(?:\?|$)', url)
    if match:
        return match.group(1)

    # Pattern 5: In path like /job/fulltime/123456789 or /job/parttime/123456789
    match = re.search(r'/job/[^/]+/(\d{8,})(?:\?|$)', url)
    if match:
        return match.group(1)

    return None

async def get_knowledge_base_dict(user_id: str = None) -> dict:
    """Fetches user knowledge base as a clean dictionary, filtered by user_id."""
    try:
        query = supabase.table("user_knowledge_base").select("*")
        if user_id:
            query = query.eq("user_id", user_id)
        response = query.execute()
        kb_data = {}
        for item in response.data:
            kb_data[item['question']] = item['answer']
        return kb_data
    except Exception as e:
        await log(f"⚠️ Failed to fetch KB: {e}")
        return {}

async def get_active_profile(user_id: str = None) -> str:
    """Fetches the full text of the currently active CV Profile for a specific user."""
    try:
        query = supabase.table("cv_profiles").select("content").eq("is_active", True)
        if user_id:
            query = query.eq("user_id", user_id)
        response = query.limit(1).execute()
        if response.data and len(response.data) > 0:
            return response.data[0]['content']
        return "No active profile found."
    except Exception as e:
        await log(f"⚠️ Failed to fetch Active Profile: {e}")
        return ""

async def get_latest_resume_url(user_id: str = None) -> str:
    """Get resume URL for a specific user from their active CV profile.

    Priority:
    1. User's active profile source_files (filtered by user_id)
    2. Fallback: latest file in storage bucket (legacy, single-user)

    Note: source_files stores names WITHOUT timestamp prefix, but Storage
    has files WITH prefix (e.g. "1765215379249_filename.pdf").
    Must search storage to find the actual filename.
    """
    try:
        # 1. Get resume from user's active profile (multi-user safe)
        if user_id:
            profile = await get_active_profile_full(user_id)
            source_files = profile.get('source_files', []) or []
            if source_files:
                structured = profile.get('structured_content', {}) or {}
                user_name = (structured.get('personalInfo', {}) or {}).get('fullName', '')
                first_name = user_name.lower().split()[0] if user_name else ''

                # Pick best source file
                target_file = None
                for sf in source_files:
                    if sf and first_name and first_name in sf.lower():
                        target_file = sf
                        break
                if not target_file:
                    for sf in source_files:
                        if sf and 'cv' in sf.lower():
                            target_file = sf
                            break
                if not target_file and source_files[0]:
                    target_file = source_files[0]

                if target_file:
                    # Search storage for actual filename with timestamp prefix
                    from urllib.parse import quote
                    try:
                        storage_files = supabase.storage.from_('resumes').list()
                        for obj in (storage_files or []):
                            obj_name = obj.get('name', '') if isinstance(obj, dict) else str(obj)
                            if target_file in obj_name:
                                cv_url = f"{SUPABASE_URL}/storage/v1/object/public/resumes/{quote(obj_name)}"
                                await log(f"📄 Resume (storage match): {obj_name}")
                                return cv_url
                    except Exception as e:
                        await log(f"⚠️ Storage list error: {e}")

                    # Fallback: URL-encoded name without prefix
                    cv_url = f"{SUPABASE_URL}/storage/v1/object/public/resumes/{quote(target_file)}"
                    await log(f"📄 Resume (fallback): {target_file}")
                    return cv_url

        # 2. Legacy fallback: find file matching user's name in storage bucket
        await log(f"⚠️ No resume in profile, falling back to storage bucket")

        # Get user's name to filter files
        user_name_for_filter = ""
        if user_id:
            try:
                profile = await get_active_profile_full(user_id)
                if profile:
                    structured = profile.get('structured_content', {}) or {}
                    user_name_for_filter = (structured.get('personalInfo', {}) or {}).get('fullName', '')
            except Exception:
                pass

        storage_bucket = getattr(supabase.storage, "from_")('resumes')
        if not storage_bucket:
             storage_bucket = getattr(supabase.storage, "from")('resumes')

        files = storage_bucket.list()
        if not files:
            return "No resume file found."

        files.sort(key=lambda x: x.get('created_at', '') or '', reverse=True)

        # Filter by user's name to prevent using another person's CV
        if user_name_for_filter:
            first_name = user_name_for_filter.lower().split()[0] if user_name_for_filter else ""
            last_name = user_name_for_filter.lower().split()[-1] if user_name_for_filter else ""
            # Use AND to avoid matching other family members (e.g. "Natalia Berbeha" when user is "Vitalii Berbeha")
            user_files = [f for f in files if first_name in f['name'].lower() and last_name in f['name'].lower()]
            if not user_files:
                # Fallback: at least first name must match
                user_files = [f for f in files if first_name in f['name'].lower()]
            if user_files:
                files = user_files
                await log(f"📄 Filtered storage files by name '{user_name_for_filter}': {len(files)} matches")
            else:
                await log(f"⚠️ No files matching '{user_name_for_filter}' in storage — using latest")

        latest_file = files[0]['name']
        await log(f"📄 Using resume: {latest_file}")

        res = storage_bucket.create_signed_url(latest_file, 3600)
        if res and 'signedUrl' in res:
             return res['signedUrl']
        elif res and isinstance(res, str):
             return res

        return "Error generating resume URL"
    except Exception as e:
        await log(f"⚠️ Failed to get resume URL: {e}")
        return "Resume URL generation failed"


# ============================================
# PHASE 1: FORM FIELD EXTRACTION (Variant 4)
# ============================================

async def extract_form_fields(url: str) -> dict:
    """
    PHASE 1 of Variant 4: Extract all form fields from a page using Skyvern.

    Uses data_extraction_schema to discover what fields the form has
    BEFORE attempting to fill it.

    Returns:
        {
            "success": bool,
            "fields": [...],
            "form_url": str,
            "error": str or None
        }
    """
    await log(f"🔍 PHASE 1: Extracting form fields from {url[:50]}...")

    # Schema to extract form field information
    data_extraction_schema = {
        "type": "object",
        "properties": {
            "form_fields": {
                "type": "array",
                "description": "List of ALL form fields visible on the page",
                "items": {
                    "type": "object",
                    "properties": {
                        "label": {
                            "type": "string",
                            "description": "The label text of the field (e.g., 'Fornavn', 'E-post', 'Kjønn')"
                        },
                        "field_type": {
                            "type": "string",
                            "enum": ["text", "email", "tel", "date", "select", "radio", "checkbox", "textarea", "file", "password", "number"],
                            "description": "The type of input field"
                        },
                        "required": {
                            "type": "boolean",
                            "description": "True if field is marked as required (has *, required attribute, or 'Påkrevd')"
                        },
                        "options": {
                            "type": "array",
                            "items": {"type": "string"},
                            "description": "For select/radio fields: list of available options"
                        },
                        "placeholder": {
                            "type": "string",
                            "description": "Placeholder text if any"
                        },
                        "field_name": {
                            "type": "string",
                            "description": "The HTML name or id attribute of the field"
                        }
                    }
                }
            },
            "form_title": {
                "type": "string",
                "description": "Title of the form or page"
            },
            "current_url": {
                "type": "string",
                "description": "The current URL after navigation"
            },
            "requires_login": {
                "type": "boolean",
                "description": "True if page shows login form instead of application form"
            },
            "has_file_upload": {
                "type": "boolean",
                "description": "True if form has CV/resume file upload field"
            }
        }
    }

    navigation_goal = """
GOAL: Navigate to the job application form and EXTRACT all form field information. DO NOT fill any fields.

CRITICAL: This URL was provided as the application link for a job posting. It may lead to:
- A direct application form page
- A company website where you need to find the careers/jobs section first
- A recruitment platform
Do NOT terminate just because the landing page is not a form. Explore the site first.

PHASE 1: COOKIE HANDLING
1. If Cookie Popup appears, click 'Godta alle', 'Accept all', 'Aksepter'.

PHASE 2: FIND APPLICATION FORM
2. First, look for direct apply buttons: "Søk her", "Søk på stillingen", "Apply", "Send søknad", "Søk nå".
3. If no apply button found, look for career/jobs links:
   - "Karriere", "Ledige stillinger", "Jobs", "Jobb hos oss", "Work with us", "Stillinger"
   - Check header menu, footer, and sidebar navigation
4. Navigate through career pages to find the application form.
5. If redirected to external site (Webcruiter, Easycruit, HR-Manager), stay on that page.

PHASE 3: EXTRACT FORM FIELDS
5. Once on the form page, ANALYZE all visible form fields.
6. For EACH field, identify:
   - Label text (Norwegian or English)
   - Field type (text, email, select, date, file upload, etc.)
   - Whether it's required (marked with *, "Påkrevd", or required attribute)
   - For select/dropdown fields: list all available options
7. DO NOT fill any fields. Only extract information.

IMPORTANT: Extract ALL fields you can see, including:
- Personal info (Navn, E-post, Telefon, Adresse, Postnummer)
- Demographics (Kjønn, Fødselsdato, Alder)
- Education (Utdanningsnivå, Skole)
- Experience (Arbeidserfaring, Stilling)
- Documents (CV, Søknadsbrev, Vedlegg)
- Custom questions (Hvor fikk du høre om stillingen, etc.)
"""

    prompt = build_task_prompt(
        navigation_goal,
        data_extraction_goal="Extract ALL form fields with their labels, types, required status, and options. This is for analysis - do not fill anything.",
        complete_criterion="All visible form fields on the page have been identified and extracted. The page is fully loaded.",
        terminate_criterion="The page requires login that cannot be completed, or shows a 404/error page. Do NOT terminate because the landing page is not a form - explore the site first via career/jobs links.",
    )

    payload = {
        "url": url,
        "prompt": prompt,
        "data_extraction_schema": data_extraction_schema,
        "max_steps": 10,  # Navigation + extraction only (keep low to save resources)
        "proxy_location": "RESIDENTIAL_DE",
    }

    headers = skyvern_headers()

    async with httpx.AsyncClient() as client:
        try:
            await log("🚀 Sending extraction task to Skyvern...")
            response = await client.post(
                f"{SKYVERN_URL}/v1/run/tasks",
                json=payload,
                headers=headers,
                timeout=30.0
            )

            if response.status_code != 200:
                await log(f"❌ Skyvern extraction task failed: {response.status_code}")
                return {"success": False, "error": f"HTTP {response.status_code}", "fields": []}

            task_data = response.json()
            run_id = task_data.get('run_id')
            await log(f"📋 Extraction task created: {run_id}")

            # Wait for task completion
            result = await wait_for_extraction_task(run_id, max_wait=120)
            return result

        except Exception as e:
            await log(f"❌ Extraction error: {e}")
            return {"success": False, "error": str(e), "fields": []}


async def wait_for_extraction_task(run_id: str, max_wait: int = 300) -> dict:
    """Wait for extraction task to complete and return results."""
    headers = skyvern_headers()

    start_time = datetime.now()

    async with httpx.AsyncClient() as client:
        while True:
            elapsed = (datetime.now() - start_time).total_seconds()
            if elapsed > max_wait:
                await log(f"⏰ Extraction task timeout after {max_wait}s")
                await cancel_skyvern_task(run_id)
                return {"success": False, "error": "timeout", "fields": []}

            try:
                response = await client.get(
                    f"{SKYVERN_URL}/v1/runs/{run_id}",
                    headers=headers,
                    timeout=10.0
                )

                if response.status_code == 200:
                    data = response.json()
                    if not isinstance(data, dict):
                        data = {}

                    status = data.get('status', '')

                    if status == 'completed':
                        extracted = data.get('output') or {}
                        if isinstance(extracted, list):
                            extracted = extracted[0] if extracted else {}
                        await log(f"✅ Extraction completed!")

                        fields = extracted.get('form_fields', []) if isinstance(extracted, dict) else []
                        await log(f"   Found {len(fields)} form fields")

                        return {
                            "success": True,
                            "fields": fields,
                            "form_title": extracted.get('form_title', '') if isinstance(extracted, dict) else '',
                            "form_url": extracted.get('current_url', '') if isinstance(extracted, dict) else '',
                            "requires_login": extracted.get('requires_login', False) if isinstance(extracted, dict) else False,
                            "has_file_upload": extracted.get('has_file_upload', False) if isinstance(extracted, dict) else False,
                            "error": None
                        }

                    elif status in ['failed', 'terminated', 'timed_out']:
                        error_msg = data.get('failure_reason', status)
                        await log(f"❌ Extraction failed: {error_msg}")
                        return {"success": False, "error": error_msg, "fields": []}

                    elif not status:
                        # Unknown response format — don't loop forever
                        await log(f"⚠️ Unexpected extraction response format, retrying...")
                        extraction_errors = getattr(wait_for_extraction_task, '_errors', 0) + 1
                        wait_for_extraction_task._errors = extraction_errors
                        if extraction_errors > 5:
                            await log(f"❌ Too many extraction parse errors, aborting")
                            return {"success": False, "error": "parse_error", "fields": []}
                        await asyncio.sleep(3)

                    else:
                        # Still running
                        await asyncio.sleep(3)
                else:
                    await asyncio.sleep(3)

            except Exception as e:
                await log(f"⚠️ Error checking extraction status: {e}")
                extraction_errors = getattr(wait_for_extraction_task, '_errors', 0) + 1
                wait_for_extraction_task._errors = extraction_errors
                if extraction_errors > 5:
                    await log(f"❌ Too many extraction errors, aborting")
                    return {"success": False, "error": str(e), "fields": []}
                await asyncio.sleep(3)


# ============================================
# PHASE 2: SMART FIELD MATCHING (Variant 4)
# ============================================

# Mapping of common Norwegian form field labels to profile/KB keys
FIELD_MAPPING = {
    # Personal info - Norwegian
    'fornavn': ['first_name', 'First Name'],
    'etternavn': ['last_name', 'Last Name'],
    'navn': ['full_name', 'name', 'Name'],
    'fullt navn': ['full_name', 'name'],
    'e-post': ['email', 'Email'],
    'e-postadresse': ['email', 'Email'],
    'bekreft e-post': ['email', 'Email'],
    'telefon': ['phone', 'Phone'],
    'mobil': ['phone', 'Phone'],
    'mobilnummer': ['phone', 'Phone'],

    # Personal info - English
    'first name': ['first_name', 'First Name'],
    'given name': ['first_name', 'First Name'],
    'last name': ['last_name', 'Last Name'],
    'family name': ['last_name', 'Last Name'],
    'surname': ['last_name', 'Last Name'],
    'full name': ['full_name', 'name', 'Name'],
    'preferred name': ['first_name', 'First Name'],
    'email': ['email', 'Email'],
    'e-mail': ['email', 'Email'],
    'email address': ['email', 'Email'],
    'phone': ['phone', 'Phone'],
    'phone number': ['phone', 'Phone'],
    'phone device': ['phone', 'Phone'],
    'country phone code': ['country_phone_code'],
    'phone extension': [],
    'mobile': ['phone', 'Phone'],
    'cell phone': ['phone', 'Phone'],

    # Address - Norwegian
    'adresse': ['address', 'Address'],
    'gateadresse': ['address', 'Address'],
    'postnummer': ['postal_code', 'Postal Code', 'postalCode'],
    'postnr': ['postal_code', 'Postal Code'],
    'postnr./sted': ['postal_code', 'Postal Code'],
    'poststed': ['city', 'City'],
    'by': ['city', 'City'],
    'sted': ['city', 'City'],
    'land': ['country', 'Country'],

    # Address - English
    'address': ['address', 'Address'],
    'street': ['address', 'Address'],
    'street name': ['address', 'Address'],
    'additional address': [],
    'city': ['city', 'City'],
    'postal code': ['postal_code', 'Postal Code'],
    'zip code': ['postal_code', 'Postal Code'],
    'zip': ['postal_code', 'Postal Code'],
    'country': ['country', 'Country'],

    # Workday-specific
    'how did you hear': [],
    'previously worked': [],
    'source': [],

    # Demographics - Norwegian
    'kjønn': ['gender', 'Gender', 'Kjønn'],
    'fødselsdato': ['birth_date', 'Birth Date', 'Fødselsdato', 'birthDate'],
    'fødselsår': ['birth_year', 'Fødselsår'],
    'alder': ['age', 'Age'],

    # Demographics - English
    'gender': ['gender', 'Gender'],
    'date of birth': ['birth_date', 'Birth Date'],
    'birth date': ['birth_date', 'Birth Date'],
    'birth year': ['birth_year'],
    'age': ['age', 'Age'],
    'over 18': ['over_18'],
    'er du over 18': ['over_18'],
    'behersker du norsk': ['behersker_norsk'],
    'norsk, svensk eller dansk': ['behersker_norsk'],

    # Education - Norwegian
    'utdanning': ['education_level', 'Education'],
    'utdanningsnivå': ['education_level', 'Education Level'],
    'skole': ['education_school', 'School'],
    'universitet': ['education_school', 'University'],
    'studieretning': ['education_field', 'Field of Study'],

    # Education - English
    'education': ['education_level', 'Education'],
    'degree': ['education_level', 'Education Level'],
    'school': ['education_school', 'School'],
    'university': ['education_school', 'University'],
    'field of study': ['education_field', 'Field of Study'],
    'major': ['education_field', 'Field of Study'],

    # Work - Norwegian
    'stilling': ['current_position', 'Position'],
    'nåværende stilling': ['current_position', 'Current Position'],
    'arbeidsgiver': ['current_company', 'Company'],
    'firma': ['current_company', 'Company'],

    # Work - English
    'position': ['current_position', 'Position'],
    'job title': ['current_position', 'Position'],
    'current position': ['current_position', 'Current Position'],
    'company': ['current_company', 'Company'],
    'employer': ['current_company', 'Company'],

    # Application
    'søknad': ['cover_letter', 'Cover Letter'],
    'søknadstekst': ['cover_letter', 'Cover Letter'],
    'motivasjonsbrev': ['cover_letter', 'Cover Letter'],
    'fortell om deg selv': ['cover_letter', 'Cover Letter'],

    # Documents
    'cv': ['resume_url', 'CV'],
    'legg ved cv': ['resume_url', 'cv_file_path', 'CV'],
    'cv': ['resume_url', 'cv_file_path', 'CV'],
    'last opp cv': ['resume_url', 'cv_file_path', 'CV'],
    'vedlegg': ['resume_url', 'cv_file_path'],

    # Cover letter / Søknadsbrev (from application!)
    'søknadsbrev': ['cover_letter', 'cover_letter_no', 'søknadsbrev'],
    'søknadstekst': ['cover_letter', 'cover_letter_no'],
    'motivasjonsbrev': ['cover_letter', 'cover_letter_no'],
    'cover letter': ['cover_letter', 'cover_letter_no'],
    'message': ['cover_letter', 'cover_letter_no'],
    'melding': ['cover_letter', 'cover_letter_no'],

    # Source
    'hvor fikk du vite': ['job_source', 'Job Source', 'Hvor hørte du om oss'],
    'hvordan hørte': ['job_source', 'Job Source'],
}


async def fill_missing_with_llm(missing_fields: list, profile: dict, app_data: dict, available_data: dict) -> dict:
    """Use Gemini to answer form questions that couldn't be matched from profile directly.

    Returns dict of {label: answer} for fields the AI could answer.
    """
    if not missing_fields:
        return {}

    # Build context from profile
    structured = profile.get('structured_content', {}) or {}
    profile_text = profile.get('content', '')[:3000]
    job_title = app_data.get('job_title', '') if app_data else ''

    # Build questions list
    questions = []
    for field in missing_fields:
        label = field['label']
        options = field.get('options', [])
        if options:
            questions.append(f"- {label} (варіанти: {', '.join(options[:10])})")
        else:
            questions.append(f"- {label}")

    prompt = f"""You are filling out a Norwegian job application form for the candidate.
Based on the candidate's profile, answer these form questions with short, direct values.

CANDIDATE PROFILE:
{profile_text[:2000]}

ADDITIONAL DATA:
- Birth date: {available_data.get('birth_date', 'unknown')}
- Age: {available_data.get('age', 'unknown')}
- Languages: {available_data.get('languages', 'unknown')}
- Gender: {available_data.get('gender', 'unknown')}
- Job applying for: {job_title}

UNANSWERED FORM QUESTIONS:
{chr(10).join(questions)}

RULES:
- Answer in Norwegian if the question is in Norwegian
- For yes/no questions: answer "Ja" or "Nei"
- For dropdown with options: pick the BEST matching option exactly as written
- For "over 18" type questions: calculate from birth date
- For experience questions: answer honestly based on the profile
- For availability/hours questions: answer positively but realistically (e.g. "Fleksibel", "10-20")
- For questions you truly cannot answer from the profile, respond with "SKIP"
- Keep answers SHORT (1-3 words for simple fields)

OUTPUT FORMAT (JSON):
{{"field_label": "answer", "field_label2": "answer2"}}
Only output valid JSON, nothing else."""

    try:
        url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key={GEMINI_API_KEY}"
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                url,
                headers={"Content-Type": "application/json"},
                json={
                    "contents": [{"parts": [{"text": prompt}]}],
                    "generationConfig": {
                        "temperature": 0.2,
                        "responseMimeType": "application/json",
                        "thinkingConfig": {"thinkingBudget": 0}
                    }
                },
                timeout=30.0
            )
            if resp.status_code == 200:
                data = resp.json()
                text = data["candidates"][0]["content"]["parts"][-1]["text"]
                answers = json.loads(text)
                # Filter out SKIP answers
                return {k: v for k, v in answers.items() if v and str(v).upper() != "SKIP"}
            else:
                await log(f"⚠️ LLM fill error: HTTP {resp.status_code}")
                return {}
    except Exception as e:
        await log(f"⚠️ LLM fill error: {e}")
        return {}


async def smart_match_fields(extracted_fields: list, profile: dict, kb_data: dict, app_data: dict = None) -> dict:
    """
    PHASE 2 of Variant 4: Match extracted form fields with available data.

    Args:
        extracted_fields: List of fields from form extraction
        profile: User's CV profile
        kb_data: Knowledge base data
        app_data: Application data (contains cover_letter_no!)

    Returns:
        {
            "matched": [
                {"label": "Fornavn", "value": "Vitalii", "source": "profile"},
                ...
            ],
            "missing": [
                {"label": "Kjønn", "field_type": "select", "options": ["Mann", "Kvinne"]},
                ...
            ],
            "auto_filled": int,  # count of auto-matched fields
            "needs_input": int   # count of fields needing user input
        }
    """
    await log("🔄 PHASE 2: Smart matching fields with profile & KB...")

    structured = profile.get('structured_content', {}) or {}
    personal_info = structured.get('personalInfo', {}) or {}
    address_info = personal_info.get('address', {}) if isinstance(personal_info.get('address'), dict) else {}
    work_exp = structured.get('workExperience', []) or []
    education = structured.get('education', []) or []

    # Build available data dictionary
    available_data = {}

    # From profile - personal info
    full_name = personal_info.get('fullName', '') or personal_info.get('name', '')
    available_data['full_name'] = full_name
    available_data['name'] = full_name
    available_data['first_name'] = full_name.split()[0] if full_name else ''
    available_data['last_name'] = ' '.join(full_name.split()[1:]) if full_name and len(full_name.split()) > 1 else ''
    available_data['email'] = personal_info.get('email', '')
    raw_phone = personal_info.get('phone', '')
    available_data['phone'] = raw_phone
    available_data['country_phone_code'] = '+47'

    # Address
    available_data['city'] = address_info.get('city', '') or personal_info.get('city', '')
    available_data['postal_code'] = address_info.get('postalCode', '') or personal_info.get('postalCode', '')
    available_data['country'] = address_info.get('country', '') or personal_info.get('country', '') or 'Norge'
    available_data['address'] = address_info.get('street', '') or (personal_info.get('address', '') if isinstance(personal_info.get('address'), str) else '')

    # Birth date components
    birth_date = personal_info.get('birthDate', '')
    available_data['birth_date'] = birth_date
    if birth_date and '-' in birth_date:
        parts = birth_date.split('-')
        if len(parts) == 3:
            available_data['birth_year'] = parts[0]
            available_data['Fødselsår'] = parts[0]
            available_data['birth_month'] = str(int(parts[1]))
            available_data['birth_day'] = str(int(parts[2]))
            # Calculate age-related flags
            try:
                birth_yr = int(parts[0])
                available_data['over_18'] = 'Ja' if (datetime.now().year - birth_yr) >= 18 else 'Nei'
                available_data['age'] = str(datetime.now().year - birth_yr)
            except ValueError:
                pass

    # Nationality, gender, driver license
    available_data['nationality'] = personal_info.get('nationality', '')
    available_data['gender'] = personal_info.get('gender', '')
    available_data['driver_license'] = personal_info.get('driverLicense', '')

    # Languages from profile
    languages = structured.get('languages', []) or []
    lang_names = [l.get('language', '') for l in languages]
    available_data['languages'] = ', '.join(lang_names)
    for lang in languages:
        lang_name = lang.get('language', '').lower()
        available_data[f'language_{lang_name}'] = lang.get('proficiencyLevel', '')
    # Common language questions
    if any('norsk' in l.lower() or 'norwe' in l.lower() for l in lang_names):
        available_data['behersker_norsk'] = 'Ja'

    # Work experience
    if work_exp:
        current_job = work_exp[0]
        available_data['current_position'] = current_job.get('position', '') or current_job.get('title', '')
        available_data['current_company'] = current_job.get('company', '')

    # Education
    if education:
        latest_edu = education[0]
        available_data['education_level'] = latest_edu.get('degree', '')
        available_data['education_field'] = latest_edu.get('field', '')
        available_data['education_school'] = latest_edu.get('institution', '')

    # From knowledge base
    for key, value in kb_data.items():
        # Normalize key
        norm_key = key.lower().replace(' ', '_')
        available_data[norm_key] = value
        available_data[key] = value  # Keep original too

    # From application data (søknadsbrev/cover letter!)
    if app_data:
        cover_letter = app_data.get('cover_letter_no', '')
        if cover_letter:
            available_data['cover_letter'] = cover_letter
            available_data['cover_letter_no'] = cover_letter
            available_data['søknadsbrev'] = cover_letter
            await log(f"   📝 Cover letter available ({len(cover_letter)} chars)")

    # CV file - check multiple sources
    cv_url = None

    # 1. Check CV_FILE_URL from environment (direct URL)
    cv_url = os.getenv('CV_FILE_URL', '')

    # 2. Check CV_FILE_PATH from environment (local file)
    if not cv_url:
        cv_file_path = os.getenv('CV_FILE_PATH', '')
        if cv_file_path and os.path.exists(cv_file_path):
            cv_url = cv_file_path

    # 3. Get from profile's source_files (Supabase Storage)
    # Note: source_files stores names WITHOUT timestamp prefix,
    # but storage has files WITH prefix (e.g. "1765215379249_filename.pdf")
    if not cv_url:
        source_files = profile.get('source_files', []) or []
        if source_files:
            user_name = (structured.get('personalInfo', {}) or {}).get('fullName', '')
            first_name = user_name.split()[0].lower() if user_name else ''

            # Find best matching file from source_files
            target_file = None
            if first_name:
                for sf in source_files:
                    if sf and first_name in sf.lower():
                        target_file = sf
                        break
            if not target_file:
                for sf in source_files:
                    if sf and 'cv' in sf.lower():
                        target_file = sf
                        break
            if not target_file and source_files[0]:
                target_file = source_files[0]

            if target_file:
                # Search storage for the actual filename (with timestamp prefix)
                try:
                    from urllib.parse import quote
                    storage_resp = supabase.storage.from_('resumes').list()
                    for obj in (storage_resp or []):
                        obj_name = obj.get('name', '') if isinstance(obj, dict) else str(obj)
                        if target_file in obj_name:
                            cv_url = f"{SUPABASE_URL}/storage/v1/object/public/resumes/{quote(obj_name)}"
                            break
                except Exception as e:
                    await log(f"   ⚠️ Storage list error: {e}")

                # Fallback: try URL-encoded name directly
                if not cv_url:
                    from urllib.parse import quote
                    cv_url = f"{SUPABASE_URL}/storage/v1/object/public/resumes/{quote(target_file)}"

    if cv_url:
        available_data['cv_file_path'] = cv_url
        available_data['resume_url'] = cv_url
        await log(f"   📄 CV available: {cv_url[:60]}...")

    # Match fields
    matched = []
    missing = []

    # Keywords for auto-consent checkboxes (privacy, GDPR, etc.)
    consent_keywords = ['personvern', 'samtykker', 'gdpr', 'privacy', 'consent',
                        'retningslinjer', 'vilkår', 'terms', 'aksepterer', 'godtar']

    # Keywords for optional marketing checkboxes (skip these)
    marketing_keywords = ['kontakte meg', 'fremtidige', 'future', 'newsletter',
                          'nyhetsbrev', 'marketing', 'markedsføring', 'jobbmuligheter']

    for field in extracted_fields:
        label = field.get('label', '').strip()
        label_lower = label.lower()
        field_type = field.get('field_type', field.get('type', 'text'))
        required = field.get('required', False)
        options = field.get('options', [])

        # Try to find a match
        found_value = None
        source = None

        # AUTO-CONSENT: Privacy/GDPR checkboxes - always agree
        if field_type == 'checkbox' and any(kw in label_lower for kw in consent_keywords):
            found_value = 'true'
            source = 'auto'
            await log(f"   ✅ Auto-consent: {label[:40]}...")

        # Check direct mapping (longest match first to avoid "name" matching "street name")
        if not found_value:
            sorted_keys = sorted(FIELD_MAPPING.keys(), key=len, reverse=True)
            for map_key in sorted_keys:
                if map_key in label_lower:
                    data_keys = FIELD_MAPPING[map_key]
                    if not data_keys:  # Empty list = explicitly skip this field
                        found_value = None
                        break
                    for dk in data_keys:
                        if dk in available_data and available_data[dk]:
                            found_value = available_data[dk]
                            # Determine source
                            if dk in ['cover_letter', 'cover_letter_no', 'søknadsbrev']:
                                source = 'application'
                            elif dk in ['full_name', 'email', 'phone', 'city', 'postal_code',
                                         'current_position', 'education_level', 'first_name',
                                         'last_name', 'address', 'country']:
                                source = 'profile'
                            elif dk in ['cv_file_path', 'resume_url']:
                                source = 'file'
                            else:
                                source = 'kb'
                            break
                    if found_value:
                        break

        # Check KB directly by label
        if not found_value:
            if label in kb_data:
                found_value = kb_data[label]
                source = 'kb'
            elif label_lower in kb_data:
                found_value = kb_data[label_lower]
                source = 'kb'

        if found_value:
            matched.append({
                "label": label,
                "value": found_value if len(str(found_value)) < 100 else f"{str(found_value)[:100]}...",
                "source": source,
                "field_type": field_type
            })
        else:
            # Skip file uploads if no CV configured (can't upload via API anyway)
            if field_type == 'file':
                await log(f"   ⏭️ Skipping file field (no CV configured): {label}")
                continue

            # Skip optional marketing checkboxes (newsletters, future opportunities)
            if field_type == 'checkbox' and not required and any(kw in label_lower for kw in marketing_keywords):
                await log(f"   ⏭️ Skipping optional marketing: {label[:40]}...")
                continue

            # Field is missing - needs user input
            missing.append({
                "label": label,
                "field_type": field_type,
                "required": required,
                "options": options
            })

    await log(f"   ✅ Matched: {len(matched)} fields")
    await log(f"   ❓ Missing: {len(missing)} fields")

    # LLM FALLBACK: Try to answer remaining questions using AI + profile context
    if missing and GEMINI_API_KEY:
        llm_answered = await fill_missing_with_llm(missing, profile, app_data, available_data)
        if llm_answered:
            # Move LLM-answered fields from missing to matched
            still_missing = []
            for field in missing:
                label = field['label']
                if label in llm_answered and llm_answered[label]:
                    matched.append({
                        "label": label,
                        "value": llm_answered[label],
                        "source": "ai",
                        "field_type": field['field_type']
                    })
                else:
                    still_missing.append(field)
            missing = still_missing
            await log(f"   🤖 AI filled: {len(llm_answered)} fields, still missing: {len(missing)}")

    return {
        "matched": matched,
        "missing": missing,
        "auto_filled": len(matched),
        "needs_input": len(missing)
    }


# ============================================
# PHASE 3: TELEGRAM CONFIRMATION (Variant 4)
# ============================================

async def send_smart_confirmation(
    app_id: str,
    job_id: str,
    job_title: str,
    company: str,
    form_url: str,
    match_result: dict,
    chat_id: str
) -> str | None:
    """
    PHASE 3 of Variant 4: Send smart confirmation to Telegram with REAL form fields.

    Shows user:
    - ✅ Fields that will be auto-filled (from profile/KB)
    - ❓ Fields that need user input (with options for select fields)

    Returns: confirmation_id or None
    """
    await log("📱 PHASE 3: Sending smart confirmation to Telegram...")

    matched = match_result.get('matched', [])
    missing = match_result.get('missing', [])

    # Build message
    domain = extract_domain(form_url) if form_url else "форма"

    message_parts = [
        f"📋 <b>Заявка на {company}</b>",
        f"💼 {job_title[:50]}..." if len(job_title) > 50 else f"💼 {job_title}",
        f"🌐 Форма: <code>{domain}</code>",
        "",
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
        "<b>📝 ПОЛЯ ФОРМИ:</b>",
        "",
    ]

    # Combine all fields in one list - matched first, then missing
    all_fields = []

    # Add matched fields with their values
    for field in matched:
        all_fields.append({
            'label': field.get('label', 'Unknown'),
            'value': field.get('value', ''),
            'field_type': field.get('field_type', 'text'),
            'has_value': True,
            'options': field.get('options', [])
        })

    # Add missing fields without values
    for field in missing:
        all_fields.append({
            'label': field.get('label', 'Unknown'),
            'value': None,
            'field_type': field.get('field_type', 'text'),
            'has_value': False,
            'required': field.get('required', False),
            'options': field.get('options', [])
        })

    # Show ALL fields in Q&A format
    for field in all_fields:
        label = field['label']
        value = field['value']
        field_type = field['field_type']
        has_value = field['has_value']

        # Question
        message_parts.append(f"<b>❓ {label}:</b>")

        if has_value and value:
            value_str = str(value)

            # For cover letter - show first 200 chars
            if field_type == 'textarea' or 'cover' in label.lower() or 'søknad' in label.lower() or 'letter' in label.lower() or 'melding' in label.lower() or 'message' in label.lower():
                if len(value_str) > 200:
                    value_str = value_str[:200] + f"... ({len(value_str)} символів)"
            # For other fields - show full value (up to 100 chars)
            elif len(value_str) > 100:
                value_str = value_str[:100] + "..."

            message_parts.append(f"✅ <code>{value_str}</code>")
        else:
            # No value - show what's missing
            if field_type == 'select' and field.get('options'):
                options_str = ", ".join(field['options'][:5])
                if len(field['options']) > 5:
                    options_str += "..."
                message_parts.append(f"⚠️ <i>Не заповнено</i> [{options_str}]")
            elif field_type == 'date':
                message_parts.append(f"⚠️ <i>Не заповнено</i> (дата)")
            elif field_type == 'file':
                message_parts.append(f"⚠️ <i>Не заповнено</i> (файл)")
            else:
                message_parts.append(f"⚠️ <i>Не заповнено</i>")

        message_parts.append("")

    message_parts.append("━━━━━━━━━━━━━━━━━━━━━━━━━━━━")
    message_parts.append(f"📊 Заповнено: {len(matched)} | Пусто: {len(missing)}")

    message = "\n".join(message_parts)

    # Create confirmation record with extraction data
    try:
        from datetime import timedelta
        expires_at = (datetime.now() + timedelta(seconds=CONFIRMATION_TIMEOUT_SECONDS)).isoformat()

        confirmation_data = {
            "application_id": app_id,
            "job_id": job_id,
            "telegram_chat_id": chat_id,
            "payload": {
                "matched_fields": matched,
                "missing_fields": missing,
                "form_url": form_url,
                "is_smart_confirmation": True
            },
            "status": "pending",
            "expires_at": expires_at
        }

        response = supabase.table("application_confirmations").insert(confirmation_data).execute()

        if not response.data or len(response.data) == 0:
            await log("❌ Failed to create smart confirmation record")
            return None

        confirmation_id = response.data[0]['id']

        # Build inline keyboard
        keyboard = {
            "inline_keyboard": []
        }

        # If there are missing fields, add buttons for each
        if missing:
            # Add "Answer questions" button
            keyboard["inline_keyboard"].append([
                {"text": "📝 Відповісти на питання", "callback_data": f"smart_answer_{confirmation_id}"}
            ])

        # Confirm/Cancel buttons
        keyboard["inline_keyboard"].append([
            {"text": "✅ Підтвердити", "callback_data": f"smart_confirm_{confirmation_id}"},
            {"text": "❌ Скасувати", "callback_data": f"smart_cancel_{confirmation_id}"}
        ])

        # Send to Telegram
        async with httpx.AsyncClient() as client:
            tg_response = await client.post(
                f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
                json={
                    "chat_id": chat_id,
                    "text": message,
                    "parse_mode": "HTML",
                    "reply_markup": keyboard
                },
                timeout=10.0
            )

            if tg_response.status_code == 200:
                tg_data = tg_response.json()
                msg_id = tg_data.get('result', {}).get('message_id')

                # Update confirmation with message_id
                supabase.table("application_confirmations").update({
                    "telegram_message_id": str(msg_id)
                }).eq("id", confirmation_id).execute()

                await log(f"📤 Smart confirmation sent: {confirmation_id}")
                return confirmation_id
            else:
                await log(f"❌ Telegram send failed: {tg_response.status_code}")
                return None

    except Exception as e:
        await log(f"❌ Smart confirmation error: {e}")
        return None


async def ask_missing_fields_telegram(
    confirmation_id: str,
    missing_fields: list,
    chat_id: str,
    current_index: int = 0
) -> None:
    """
    Ask user for missing field values one by one via Telegram.

    Sends a message for the current field, waits for response,
    saves to KB, and moves to next field.
    """
    if current_index >= len(missing_fields):
        await log("✅ All missing fields answered")
        return

    field = missing_fields[current_index]
    label = field.get('label', 'Unknown')
    field_type = field.get('field_type', 'text')
    options = field.get('options', [])
    required = field.get('required', False)

    # Build question message
    req_text = " (обов'язкове)" if required else ""
    message = f"❓ <b>{label}</b>{req_text}\n\n"

    keyboard = {"inline_keyboard": []}

    if field_type == 'select' and options:
        message += "Обери варіант:"
        # Add option buttons (max 4 per row)
        row = []
        for i, opt in enumerate(options[:12]):  # Max 12 options
            row.append({
                "text": opt,
                "callback_data": f"field_ans_{confirmation_id}_{current_index}_{i}"
            })
            if len(row) == 2:
                keyboard["inline_keyboard"].append(row)
                row = []
        if row:
            keyboard["inline_keyboard"].append(row)

    elif field_type == 'date':
        message += "Напиши дату у форматі DD.MM.YYYY:"

    elif field_type == 'radio' and options:
        message += "Обери варіант:"
        for i, opt in enumerate(options[:8]):
            keyboard["inline_keyboard"].append([{
                "text": opt,
                "callback_data": f"field_ans_{confirmation_id}_{current_index}_{i}"
            }])

    else:
        message += "Напиши відповідь:"

    # Add skip button if not required
    if not required:
        keyboard["inline_keyboard"].append([{
            "text": "⏭️ Пропустити",
            "callback_data": f"field_skip_{confirmation_id}_{current_index}"
        }])

    # Update confirmation with pending question
    supabase.table("application_confirmations").update({
        "payload": supabase.table("application_confirmations")
            .select("payload")
            .eq("id", confirmation_id)
            .single()
            .execute()
            .data.get('payload', {}) | {
                "pending_field_index": current_index,
                "pending_field_label": label
            }
    }).eq("id", confirmation_id).execute()

    # Send question
    async with httpx.AsyncClient() as client:
        await client.post(
            f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
            json={
                "chat_id": chat_id,
                "text": message,
                "parse_mode": "HTML",
                "reply_markup": keyboard if keyboard["inline_keyboard"] else None
            },
            timeout=10.0
        )


async def save_field_to_kb(label: str, value: str, user_id: str = None) -> bool:
    """Save a field answer to knowledge base, scoped to user_id."""
    try:
        if not user_id:
            await log(f"⚠️ save_field_to_kb called without user_id for '{label}' — skipping")
            return False

        # Check if already exists for this user
        existing = supabase.table("user_knowledge_base") \
            .select("id") \
            .eq("question", label) \
            .eq("user_id", user_id) \
            .execute()

        if existing.data:
            # Update existing
            supabase.table("user_knowledge_base").update({
                "answer": value
            }).eq("question", label).eq("user_id", user_id).execute()
        else:
            # Insert new
            supabase.table("user_knowledge_base").insert({
                "question": label,
                "answer": value,
                "category": "form_field",
                "user_id": user_id
            }).execute()

        await log(f"💾 Saved to KB: {label} = {value[:20]}...")
        return True
    except Exception as e:
        await log(f"⚠️ Failed to save to KB: {e}")
        return False


# ============================================
# HYBRID FLOW ORCHESTRATION (Variant 4)
# ============================================

async def process_application_hybrid(
    app_id: str,
    job_data: dict,
    app_data: dict,
    chat_id: str
) -> dict:
    """
    Main orchestrator for Variant 4 hybrid flow.

    Flow:
    1. Extract form fields from URL
    2. Smart match with profile & KB
    3. Send to Telegram for confirmation
    4. Wait for user to fill missing fields
    5. Fill form with complete data

    Returns:
        {"success": bool, "status": str, "message": str}
    """
    job_title = job_data.get('title', 'Unknown')
    company = job_data.get('company', 'Unknown')
    external_url = job_data.get('external_apply_url') or job_data.get('job_url')
    user_id = job_data.get('user_id')

    await log(f"🚀 Starting HYBRID FLOW for: {job_title[:40]}...")

    # Get profile and KB data (filtered by user_id for multi-user isolation)
    profile = await get_active_profile_full(user_id)
    kb_data = await get_knowledge_base_dict(user_id)

    # PHASE 1: Extract form fields
    await log("━" * 40)
    extraction_result = await extract_form_fields(external_url)

    if not extraction_result.get('success'):
        error = extraction_result.get('error', 'Unknown error')
        await log(f"❌ Extraction failed: {error}")

        # Fall back to old flow
        await log("⚠️ Falling back to standard flow...")
        return {"success": False, "status": "extraction_failed", "message": error}

    fields = extraction_result.get('fields', [])
    form_url = extraction_result.get('form_url', external_url)

    if not fields:
        await log("⚠️ No fields extracted, falling back to standard flow")
        return {"success": False, "status": "no_fields", "message": "No form fields found"}

    await log(f"📋 Extracted {len(fields)} form fields")

    # PHASE 2: Smart matching
    await log("━" * 40)
    match_result = await smart_match_fields(fields, profile, kb_data, app_data)

    # PHASE 3: Send to Telegram
    await log("━" * 40)
    confirmation_id = await send_smart_confirmation(
        app_id=app_id,
        job_id=job_data.get('id'),
        job_title=job_title,
        company=company,
        form_url=form_url,
        match_result=match_result,
        chat_id=chat_id
    )

    if not confirmation_id:
        return {"success": False, "status": "telegram_failed", "message": "Failed to send confirmation"}

    return {
        "success": True,
        "status": "waiting_confirmation",
        "message": "Smart confirmation sent",
        "confirmation_id": confirmation_id,
        "matched_count": match_result.get('auto_filled', 0),
        "missing_count": match_result.get('needs_input', 0)
    }


async def get_telegram_chat_id_for_user(user_id: str) -> str | None:
    """Get Telegram chat ID for a specific user."""
    if not user_id:
        return await get_telegram_chat_id()
    try:
        res = supabase.table("user_settings").select("telegram_chat_id").eq("user_id", user_id).single().execute()
        return res.data.get('telegram_chat_id') if res.data else None
    except Exception:
        return None


async def ask_skyvern_question(
    user_id: str,
    field_name: str,
    question_text: str,
    job_title: str = "",
    company: str = "",
    options: list = None,
    timeout_seconds: int = 300,
    job_id: str = None
) -> str | None:
    """Ask user a question via Telegram during Skyvern form filling.

    Creates a record in registration_questions (with flow_id=NULL, field_context='skyvern_form')
    and polls for the answer.
    """
    chat_id = await get_telegram_chat_id_for_user(user_id)
    if not chat_id:
        await log(f"⚠️ No telegram_chat_id for user {user_id}, skipping Q&A for {field_name}")
        return None

    timeout_at = (datetime.now(timezone.utc) + timedelta(seconds=timeout_seconds)).isoformat()

    question_data = {
        "flow_id": None,
        "field_name": field_name,
        "field_context": "skyvern_form",
        "question_text": question_text,
        "options": options,
        "status": "pending",
        "timeout_at": timeout_at,
        "user_id": user_id,
        "job_id": job_id
    }

    try:
        q_res = supabase.table("registration_questions").insert(question_data).execute()
        question_id = q_res.data[0]['id']
    except Exception as e:
        await log(f"⚠️ Failed to create Q&A question: {e}")
        return None

    # Build Telegram message
    msg = f"❓ <b>Skyvern потребує дані</b>\n"
    msg += f"📋 {job_title} — {company}\n\n"
    msg += f"📝 {question_text}\n\n"

    reply_markup = None
    if options:
        buttons = [[{"text": opt[:30], "callback_data": f"skyq_{question_id}_{i}"}]
                   for i, opt in enumerate(options[:4])]
        reply_markup = json.dumps({"inline_keyboard": buttons})
    else:
        msg += "Введіть відповідь текстом:"

    await send_telegram(chat_id, msg, json.loads(reply_markup) if reply_markup else None)
    await log(f"❓ Asked user: {field_name} (Q: {question_id[:8]}...)")

    # Poll for answer
    start = datetime.now(timezone.utc)
    while (datetime.now(timezone.utc) - start).total_seconds() < timeout_seconds:
        await asyncio.sleep(3)
        try:
            q = supabase.table("registration_questions") \
                .select("status, answer").eq("id", question_id).single().execute()
            if q.data and q.data.get('status') == 'answered':
                answer = q.data.get('answer', '')
                await log(f"✅ Got answer for {field_name}: {answer[:30]}...")
                return answer
        except Exception:
            pass

    # Timeout
    await log(f"⏰ Q&A timeout for {field_name}")
    try:
        supabase.table("registration_questions") \
            .update({"status": "timeout"}).eq("id", question_id).execute()
    except Exception:
        pass
    return None


async def save_answer_to_profile(user_id: str, field_name: str, value: str):
    """Save Q&A answer back to user's structured profile for future use."""
    try:
        profile_res = supabase.table("cv_profiles") \
            .select("id, structured_content") \
            .eq("user_id", user_id).eq("is_active", True).limit(1).single().execute()

        if not profile_res.data:
            return

        profile_id = profile_res.data['id']
        structured = profile_res.data.get('structured_content', {}) or {}
        personal = structured.get('personalInfo', {}) or {}
        address = personal.get('address', {}) if isinstance(personal.get('address'), dict) else {}

        # Map field_name to profile path
        FIELD_MAP = {
            'birthDate': ('personalInfo', 'birthDate'),
            'birth_date': ('personalInfo', 'birthDate'),
            'nationality': ('personalInfo', 'nationality'),
            'gender': ('personalInfo', 'gender'),
            'street': ('personalInfo.address', 'street'),
            'postalCode': ('personalInfo.address', 'postalCode'),
            'postal_code': ('personalInfo.address', 'postalCode'),
        }

        mapping = FIELD_MAP.get(field_name)
        if not mapping:
            await save_field_to_kb(field_name, value, user_id)
            return

        parent_path, key = mapping
        if parent_path == 'personalInfo':
            personal[key] = value
        elif parent_path == 'personalInfo.address':
            address[key] = value
            personal['address'] = address

        structured['personalInfo'] = personal

        supabase.table("cv_profiles") \
            .update({"structured_content": structured}) \
            .eq("id", profile_id).execute()

        await log(f"💾 Saved {field_name}={value[:20]}... to profile")
    except Exception as e:
        await log(f"⚠️ Failed to save {field_name} to profile: {e}")


# ============================================
# PAYLOAD PREVIEW BEFORE SKYVERN SUBMISSION
# ============================================

PAYLOAD_PREVIEW_TIMEOUT_SECONDS = 600  # 10 minutes

EDITABLE_FIELDS = {
    'full_name': '👤 Ім\'я',
    'email': '📧 Email',
    'phone': '📱 Телефон',
    'birth_date': '🎂 Дата народження',
    'street': '🏠 Вулиця',
    'postal_code': '📮 Індекс',
    'city': '🏙 Місто',
    'nationality': '🌍 Громадянство',
    'gender': '⚧ Стать',
}


def format_payload_preview_message(
    candidate_payload: dict,
    job_title: str,
    company: str,
) -> str:
    """Format payload fields into a Telegram preview message."""
    lines = [
        f"📋 <b>ДАНІ ДЛЯ ФОРМИ</b>",
        f"💼 {job_title} — {company}",
        "━━━━━━━━━━━━━━━━━━",
    ]

    field_display = [
        ('full_name', '👤'),
        ('email', '📧'),
        ('phone', '📱'),
        ('birth_date', '🎂'),
        ('street', '🏠'),
        ('postal_code', '📮'),
        ('city', '🏙'),
        ('country', '🌍'),
        ('nationality', '🏳'),
        ('gender', '⚧'),
        ('current_position', '🏢'),
        ('education_level', '🎓'),
    ]

    for key, emoji in field_display:
        value = candidate_payload.get(key, '')
        if value:
            display = str(value)[:60]
            lines.append(f"{emoji} {display}")

    # Cover letter preview
    cover = candidate_payload.get('cover_letter', '')
    if cover:
        preview = cover[:200] + "..." if len(cover) > 200 else cover
        lines.append(f"📝 Søknad: {preview}")

    lines.append("━━━━━━━━━━━━━━━━━━")
    return "\n".join(lines)


async def send_payload_preview(
    chat_id: str,
    candidate_payload: dict,
    job_title: str,
    company: str,
    app_id: str,
    user_id: str,
    job_id: str = None
) -> str:
    """Send payload preview to Telegram with confirm/edit/cancel buttons.

    Returns: 'confirmed', 'cancelled', 'timeout'
    Updates candidate_payload in-place if user edits fields.
    """
    await log("📋 Sending payload preview to Telegram...")

    # Build preview fields dict for DB storage
    preview_fields = {}
    for key in EDITABLE_FIELDS:
        preview_fields[key] = candidate_payload.get(key, '')
    # Also store cover letter preview
    cover = candidate_payload.get('cover_letter', '')
    preview_fields['cover_letter_preview'] = cover[:200] if cover else ''

    # Create confirmation record
    expires_at = (datetime.now(timezone.utc) + timedelta(seconds=PAYLOAD_PREVIEW_TIMEOUT_SECONDS)).isoformat()

    try:
        confirmation_data = {
            "application_id": app_id,
            "job_id": job_id,
            "telegram_chat_id": chat_id,
            "payload": {
                "type": "payload_preview",
                "fields": preview_fields,
                "pending_edit_field": None
            },
            "status": "pending",
            "expires_at": expires_at
        }

        response = supabase.table("application_confirmations").insert(confirmation_data).execute()

        if not response.data or len(response.data) == 0:
            await log("❌ Failed to create payload preview record")
            return 'timeout'

        confirmation_id = response.data[0]['id']
    except Exception as e:
        await log(f"❌ Payload preview DB error: {e}")
        return 'timeout'

    # Format and send preview message
    preview_text = format_payload_preview_message(candidate_payload, job_title, company)

    keyboard = {
        "inline_keyboard": [
            [
                {"text": "✅ Відправити", "callback_data": f"payconfirm_{confirmation_id}"},
                {"text": "✏️ Редагувати", "callback_data": f"payedit_{confirmation_id}"},
            ],
            [
                {"text": "❌ Скасувати", "callback_data": f"paycancel_{confirmation_id}"},
            ]
        ]
    }

    msg_id = await send_telegram(chat_id, preview_text, keyboard)
    if not msg_id:
        await log("❌ Failed to send payload preview to Telegram")
        return 'timeout'

    await log(f"📤 Payload preview sent: {confirmation_id[:8]}...")

    # Poll for status changes
    start = datetime.now(timezone.utc)
    last_fields_hash = json.dumps(preview_fields, sort_keys=True)

    while (datetime.now(timezone.utc) - start).total_seconds() < PAYLOAD_PREVIEW_TIMEOUT_SECONDS:
        await asyncio.sleep(3)

        try:
            conf = supabase.table("application_confirmations") \
                .select("status, payload") \
                .eq("id", confirmation_id).single().execute()

            if not conf.data:
                continue

            status = conf.data.get('status')
            payload = conf.data.get('payload', {})

            if status == 'confirmed':
                # Check if fields were edited and update candidate_payload
                db_fields = payload.get('fields', {})
                for key in EDITABLE_FIELDS:
                    db_val = db_fields.get(key, '')
                    if db_val and db_val != candidate_payload.get(key, ''):
                        old_val = candidate_payload.get(key, '')
                        candidate_payload[key] = db_val
                        # Also update capitalized variants
                        cap_key = key.replace('_', ' ').title()
                        candidate_payload[cap_key] = db_val
                        await log(f"✏️ Field updated: {key}: {old_val[:20]} → {db_val[:20]}")
                await log("✅ Payload preview confirmed by user")
                return 'confirmed'

            if status == 'cancelled':
                await log("❌ Payload preview cancelled by user")
                return 'cancelled'

            # Check if fields were edited (user edited but hasn't confirmed yet)
            db_fields = payload.get('fields', {})
            current_hash = json.dumps(db_fields, sort_keys=True)
            if current_hash != last_fields_hash:
                last_fields_hash = current_hash
                # Update candidate_payload in-place with edited values
                for key in EDITABLE_FIELDS:
                    db_val = db_fields.get(key, '')
                    if db_val:
                        candidate_payload[key] = db_val
                        cap_key = key.replace('_', ' ').title()
                        candidate_payload[cap_key] = db_val
                await log("✏️ Payload fields updated from user edit")

        except Exception as e:
            await log(f"⚠️ Payload preview poll error: {e}")

    # Timeout
    await log("⏰ Payload preview timeout (10 min)")
    try:
        supabase.table("application_confirmations") \
            .update({"status": "timeout"}).eq("id", confirmation_id).execute()
    except Exception:
        pass
    return 'timeout'


async def trigger_skyvern_task_with_credentials(
    job_url: str,
    app_data: dict,
    kb_data: dict,
    profile_text: str,
    resume_url: str,
    credentials: dict = None,
    user_id: str = None
):
    """Sends a task to Skyvern with optional site credentials for login.

    If credentials are provided, includes login step in navigation goal.
    """
    cover_letter = app_data.get('cover_letter_no', 'No cover letter generated.')

    # Get full profile for structured data (filtered by user_id for multi-user isolation)
    profile = await get_active_profile_full(user_id)
    structured = profile.get('structured_content', {}) or {}
    personal_info = structured.get('personalInfo', {})

    # Extract work experience
    work_experience = structured.get('workExperience', [])
    current_job = work_experience[0] if work_experience else {}

    # Extract education
    education = structured.get('education', [])
    latest_education = education[0] if education else {}

    # 1. BUILD PAYLOAD - Start fresh, don't use kb_data for personal info
    # Filter out personal info keys from kb_data to avoid fake data
    fake_keys = {
        'First Name', 'Last Name', 'Email', 'Phone', 'Name',
        'first_name', 'last_name', 'email', 'phone', 'name',
        'LinkedIn URL', 'Notice Period', 'Salary Expectation',
        'Address', 'City', 'Postal Code', 'Country'
    }
    filtered_kb_data = {k: v for k, v in kb_data.items() if k not in fake_keys}

    # Start with filtered kb_data (only non-personal fields)
    candidate_payload = filtered_kb_data.copy()

    # Add REAL profile data
    full_name = personal_info.get('fullName', '') or personal_info.get('name', '')
    first_name = full_name.split()[0] if full_name else ''
    last_name = ' '.join(full_name.split()[1:]) if full_name and len(full_name.split()) > 1 else ''

    candidate_payload["full_name"] = full_name
    candidate_payload["First Name"] = first_name
    candidate_payload["Last Name"] = last_name
    candidate_payload["first_name"] = first_name
    candidate_payload["last_name"] = last_name
    candidate_payload["name"] = full_name
    candidate_payload["email"] = personal_info.get('email', '')
    candidate_payload["Email"] = personal_info.get('email', '')
    raw_phone = personal_info.get('phone', '')
    contact_phone = normalize_phone_for_norway(raw_phone)
    candidate_payload["phone"] = contact_phone
    candidate_payload["Phone"] = contact_phone

    # Add address info from profile (handle nested address object)
    address_info = personal_info.get('address', {}) if isinstance(personal_info.get('address'), dict) else {}
    candidate_payload["street"] = address_info.get('street', '')
    candidate_payload["Street"] = address_info.get('street', '')
    candidate_payload["city"] = address_info.get('city', '') or personal_info.get('city', '')
    candidate_payload["City"] = address_info.get('city', '') or personal_info.get('city', '')
    candidate_payload["postal_code"] = address_info.get('postalCode', '') or personal_info.get('postalCode', '')
    candidate_payload["Postal Code"] = address_info.get('postalCode', '') or personal_info.get('postalCode', '')
    candidate_payload["country"] = address_info.get('country', 'Norge') or personal_info.get('country', 'Norge')
    candidate_payload["Country"] = address_info.get('country', 'Norge') or personal_info.get('country', 'Norge')
    # Full address string for forms that have a single address field
    street = address_info.get('street', '')
    postal = address_info.get('postalCode', '')
    city = address_info.get('city', '') or personal_info.get('city', '')
    full_address = f"{street}, {postal} {city}".strip(', ') if street else city
    candidate_payload["address"] = full_address
    candidate_payload["Address"] = full_address

    # Add new personal fields (birthDate, nationality, gender, driverLicense)
    candidate_payload["birth_date"] = personal_info.get('birthDate', '')
    candidate_payload["Birth Date"] = personal_info.get('birthDate', '')
    candidate_payload["nationality"] = personal_info.get('nationality', '')
    candidate_payload["Nationality"] = personal_info.get('nationality', '')
    candidate_payload["gender"] = personal_info.get('gender', '')
    candidate_payload["Gender"] = personal_info.get('gender', '')
    candidate_payload["driver_license"] = personal_info.get('driverLicense', '')
    candidate_payload["Driver License"] = personal_info.get('driverLicense', '')

    # Normalize "Nåværende" dates in work experience — Webcruiter/ATS expect
    # actual dates or empty, not text like "Nåværende" / "Present" / "Pågående"
    current_date_terms = {'nåværende', 'present', 'current', 'pågående', 'nå', 'now', 'ongoing', 'dd'}
    for exp in work_experience:
        end_date = str(exp.get('endDate', '') or '').strip().lower()
        if end_date in current_date_terms:
            exp['endDate'] = ''  # Empty = current position, ATS will use checkbox
            exp['isCurrentPosition'] = True

    # Add work experience (current + full history)
    candidate_payload["current_position"] = current_job.get('position', '')
    candidate_payload["current_company"] = current_job.get('company', '')
    candidate_payload["work_experience"] = json.dumps(work_experience[:5]) if work_experience else '[]'

    # Add education (current + full history)
    candidate_payload["education_level"] = latest_education.get('degree', '')
    candidate_payload["education_field"] = latest_education.get('field', '')
    candidate_payload["education_school"] = latest_education.get('institution', '')
    candidate_payload["education"] = json.dumps(education) if education else '[]'

    # Add languages
    languages = structured.get('languages', [])
    candidate_payload["languages"] = json.dumps(languages) if languages else '[]'
    for lang_item in languages:
        lang_name = lang_item.get('language', '').lower()
        lang_level = lang_item.get('proficiencyLevel', '')
        if lang_name:
            candidate_payload[f"language_{lang_name}"] = lang_level

    # Add technical skills
    skills = structured.get('technicalSkills', {})
    candidate_payload["technical_skills"] = json.dumps(skills) if skills else '{}'

    # Add cover letter and resume
    candidate_payload["cover_letter"] = cover_letter
    candidate_payload["resume_url"] = resume_url
    candidate_payload["professional_summary"] = profile_text[:2000]

    await log(f"📋 Payload: {full_name} | {personal_info.get('email', '')} | {contact_phone}")

    # Check critical fields and ask user via Telegram if missing
    if user_id:
        job_id_for_qa = app_data.get('job_id', '')
        job_title_for_qa = app_data.get('title', '') or ''
        company_for_qa = app_data.get('company', '') or ''

        CRITICAL_FIELDS = [
            ('birthDate', 'birth_date', 'Яка ваша дата народження? (формат: ДД.ММ.РРРР)'),
            ('street', 'street', 'Яка ваша адреса (вулиця та номер будинку)?'),
            ('postalCode', 'postal_code', 'Який ваш поштовий індекс?'),
        ]

        for profile_key, payload_key, question in CRITICAL_FIELDS:
            if not candidate_payload.get(payload_key):
                answer = await ask_skyvern_question(
                    user_id=user_id,
                    field_name=profile_key,
                    question_text=question,
                    job_title=job_title_for_qa,
                    company=company_for_qa,
                    job_id=job_id_for_qa
                )
                if answer:
                    candidate_payload[payload_key] = answer
                    candidate_payload[payload_key.replace('_', ' ').title()] = answer
                    await save_answer_to_profile(user_id, profile_key, answer)

    # Payload preview removed — smart confirmation (PHASE 3) already handles
    # field review with the user. No need for double confirmation.

    # Add credentials if available
    if credentials:
        candidate_payload["login_email"] = credentials.get('email', '')
        candidate_payload["login_password"] = credentials.get('password', '')

    # 2. BUILD NAVIGATION GOAL - Use site-specific templates
    # Extract domain for site detection
    try:
        parsed_url = urlparse(job_url)
        domain = parsed_url.netloc.lower()
    except Exception:
        domain = "unknown"

    site_type = detect_site_type(domain)
    await log(f"🌐 Site detection: {domain} → {site_type}")

    # Build profile_data for navigation_goals.py
    profile_data = {
        'full_name': full_name,
        'first_name': first_name,
        'last_name': last_name,
        'email': personal_info.get('email', ''),
        'phone': contact_phone,
        'birth_date': personal_info.get('birthDate', ''),
        'nationality': personal_info.get('nationality', ''),
        'gender': personal_info.get('gender', ''),
        'street': address_info.get('street', ''),
        'postal_code': address_info.get('postalCode', ''),
        'city': city,
        'country': address_info.get('country', 'Norge'),
        'driver_license': personal_info.get('driverLicense', ''),
        'current_title': current_job.get('title', ''),
        'current_company': current_job.get('company', ''),
        'education_level': latest_education.get('degree', ''),
        'education_field': latest_education.get('field', ''),
        'education_school': latest_education.get('institution', '')
    }

    # Use site-specific navigation goal from navigation_goals.py
    navigation_goal = get_application_goal(
        domain=domain,
        profile_data=profile_data,
        cover_letter=cover_letter,
        credentials=credentials,
        resume_url=resume_url
    )

    # Phase 2: Inject form memory into navigation goal
    form_memory = await get_form_memory(domain)
    domain_stats = await get_domain_stats(domain) if form_memory else None
    memory_section = build_memory_section(form_memory, domain_stats)
    if memory_section:
        navigation_goal += memory_section
        await log(f"📝 Injected form memory into navigation goal")

    await log(f"📋 Using {site_type} navigation template (credentials: {'yes' if credentials else 'no'})")

    # Data extraction schema - includes magic link detection
    data_extraction_schema = {
        "type": "object",
        "properties": {
            "application_submitted": {"type": "boolean", "description": "True if application was submitted successfully"},
            "login_successful": {"type": "boolean", "description": "True if login was successful (if applicable)"},
            "requires_registration": {"type": "boolean", "description": "True if site requires creating an account first"},
            "magic_link_sent": {"type": "boolean", "description": "True if site uses magic link login (email verification link instead of password). Look for messages like 'check your email', 'login link sent', 'verify your email', 'Kontroller e-posten din'"},
            "magic_link_email": {"type": "string", "description": "The email address where magic link was sent (if magic_link_sent is true)"},
            "error_message": {"type": "string", "description": "Any error message encountered"}
        }
    }

    data_extraction_goal = "Determine: 1) Was application submitted? 2) Was login successful? 3) Does site use MAGIC LINK login (sends email link instead of password)? Look for messages like 'check your email', 'Kontroller e-posten', 'login link sent'."
    complete_criterion = "The page shows a confirmation that the application was submitted successfully. Look for text like: 'Søknaden er sendt', 'Takk for din søknad', 'Application submitted', 'Din søknad er mottatt', 'Your application has been received', or a clear success/confirmation page after clicking submit."
    terminate_criterion = "STOP if: (1) The position is closed or expired ('Stillingen er ikke lenger tilgjengelig', 'Fristen har gått ut', 'Deadline expired'), OR (2) A CAPTCHA appears that cannot be solved, OR (3) The page shows a 404/500 error or error message with no form/buttons to continue, OR (4) Login has failed (wrong password, error page, no form visible after login attempt), OR (5) The page is stuck on an error state with no actionable elements."

    prompt = build_task_prompt(
        navigation_goal,
        data_extraction_goal=data_extraction_goal,
        complete_criterion=complete_criterion,
        terminate_criterion=terminate_criterion,
        navigation_payload=candidate_payload,
    )

    # NOTE: wait_before_action_ms and max_retries_per_step (old Skyvern v1 per-step
    # tuning knobs) have no equivalent field in the new TaskRunRequest schema — the
    # skyvern-2.0 engine no longer exposes this granularity via the API, so they are
    # dropped rather than silently ignored.
    payload = {
        "url": job_url,
        "webhook_url": None,
        "prompt": prompt,
        "data_extraction_schema": data_extraction_schema,
        "max_steps": await _calc_max_steps(domain, 40 if credentials else 30, form_memory, domain_stats),
        "error_code_mapping": SKYVERN_ERROR_CODES,
        "proxy_location": "RESIDENTIAL_DE",
        "extra_http_headers": {"Accept-Language": "nb-NO,nb;q=0.9,no;q=0.8,en;q=0.5"}
    }

    if SKYVERN_API_KEY:
        await log(f"🔑 Using API Key: {SKYVERN_API_KEY[:5]}...")

    mode = "WITH credentials" if credentials else "WITHOUT credentials"
    return await submit_skyvern_task_with_retry(payload, f"task ({mode})")


async def trigger_skyvern_task(job_url: str, app_data: dict, kb_data: dict, profile_text: str, resume_url: str, user_id: str = None):
    """Legacy wrapper - sends task without credentials."""
    return await trigger_skyvern_task_with_credentials(
        job_url, app_data, kb_data, profile_text, resume_url, credentials=None, user_id=user_id
    )


async def send_telegram(chat_id: str, text: str, reply_markup: dict = None):
    """Send a Telegram notification."""
    if not TELEGRAM_BOT_TOKEN or not chat_id:
        return None
    try:
        async with httpx.AsyncClient() as client:
            payload = {"chat_id": chat_id, "text": text, "parse_mode": "HTML"}
            if reply_markup:
                payload["reply_markup"] = reply_markup
            response = await client.post(
                f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage",
                json=payload,
                timeout=10.0
            )
            if response.status_code == 200:
                data = response.json()
                return data.get('result', {}).get('message_id')
            return None
    except Exception as e:
        await log(f"⚠️ Telegram error: {e}")
        return None


async def send_telegram_photo(chat_id: str, photo_url: str, caption: str = None):
    """Send a photo via Telegram Bot API (by URL)."""
    if not TELEGRAM_BOT_TOKEN or not chat_id:
        return None
    try:
        async with httpx.AsyncClient() as client:
            payload = {
                "chat_id": chat_id,
                "photo": photo_url,
                "parse_mode": "HTML"
            }
            if caption:
                payload["caption"] = caption[:1024]  # Telegram caption limit
            response = await client.post(
                f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendPhoto",
                json=payload,
                timeout=15.0
            )
            if response.status_code == 200:
                return response.json().get('result', {}).get('message_id')
            return None
    except Exception as e:
        await log(f"⚠️ Telegram photo error: {e}")
        return None


async def send_telegram_photo_file(chat_id: str, file_path: str, caption: str = None):
    """Send a local photo file via Telegram Bot API (multipart upload)."""
    if not TELEGRAM_BOT_TOKEN or not chat_id:
        return None
    if not os.path.exists(file_path):
        await log(f"⚠️ Screenshot file not found: {file_path}")
        return None
    try:
        async with httpx.AsyncClient() as client:
            data = {"chat_id": chat_id, "parse_mode": "HTML"}
            if caption:
                data["caption"] = caption[:1024]
            with open(file_path, "rb") as f:
                files = {"photo": ("screenshot.png", f, "image/png")}
                response = await client.post(
                    f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendPhoto",
                    data=data,
                    files=files,
                    timeout=30.0
                )
            if response.status_code == 200:
                return response.json().get('result', {}).get('message_id')
            else:
                await log(f"⚠️ Telegram photo upload failed: {response.status_code} {response.text[:200]}")
            return None
    except Exception as e:
        await log(f"⚠️ Telegram photo file error: {e}")
        return None


async def fetch_task_screenshot(client, task_id: str, headers: dict, prefer_type: str = "screenshot_final") -> Optional[str]:
    """Fetch the latest screenshot for a Skyvern run.

    The new Task Run API returns `screenshot_urls` directly on the run object
    (reverse chronological — index 0 is the latest/final screenshot), so no
    separate steps/artifacts walk is needed anymore. Downloads it to a temp
    file since callers (send_tech_telegram_photo_file) expect a local path.
    """
    try:
        response = await client.get(
            f"{SKYVERN_URL}/v1/runs/{task_id}",
            headers=headers,
            timeout=10.0
        )
        if response.status_code != 200:
            return None

        data = response.json()
        screenshot_urls = data.get("screenshot_urls") or []
        if not screenshot_urls:
            return None

        uri = screenshot_urls[0]
        dl_resp = await client.get(uri, timeout=15.0)
        if dl_resp.status_code == 200 and len(dl_resp.content) > 1000:
            tmp_path = f"/tmp/skyvern_screenshot_{task_id}.png"
            with open(tmp_path, 'wb') as f:
                f.write(dl_resp.content)
            return tmp_path
        return None
    except Exception as e:
        await log(f"⚠️ Could not fetch screenshot: {e}")
        return None


async def edit_telegram_message(chat_id: str, message_id: int, text: str):
    """Edit an existing Telegram message."""
    if not TELEGRAM_BOT_TOKEN or not chat_id or not message_id:
        return

    try:
        async with httpx.AsyncClient() as client:
            payload = {
                "chat_id": chat_id,
                "message_id": message_id,
                "text": text,
                "parse_mode": "HTML"
            }
            await client.post(
                f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/editMessageText",
                json=payload,
                timeout=10.0
            )
    except Exception as e:
        await log(f"⚠️ Telegram edit error: {e}")


# ============================================
# TECH BOT HELPERS (@vitalljobtechbot)
# ============================================

async def send_tech_telegram(chat_id: str, text: str):
    """Send a technical notification via @vitalljobtechbot."""
    token = TELEGRAM_TECH_BOT_TOKEN or TELEGRAM_BOT_TOKEN
    if not token or not chat_id:
        return None
    try:
        async with httpx.AsyncClient() as client:
            payload = {"chat_id": chat_id, "text": text, "parse_mode": "HTML"}
            response = await client.post(
                f"https://api.telegram.org/bot{token}/sendMessage",
                json=payload,
                timeout=10.0
            )
            if response.status_code == 200:
                data = response.json()
                return data.get('result', {}).get('message_id')
            return None
    except Exception as e:
        await log(f"⚠️ Tech telegram error: {e}")
        return None


async def send_tech_telegram_photo_file(chat_id: str, file_path: str, caption: str = None):
    """Send a screenshot via @vitalljobtechbot."""
    token = TELEGRAM_TECH_BOT_TOKEN or TELEGRAM_BOT_TOKEN
    if not token or not chat_id:
        return None
    if not os.path.exists(file_path):
        return None
    try:
        async with httpx.AsyncClient() as client:
            data = {"chat_id": chat_id, "parse_mode": "HTML"}
            if caption:
                data["caption"] = caption[:1024]
            with open(file_path, "rb") as f:
                files = {"photo": ("screenshot.png", f, "image/png")}
                response = await client.post(
                    f"https://api.telegram.org/bot{token}/sendPhoto",
                    data=data,
                    files=files,
                    timeout=30.0
                )
            if response.status_code == 200:
                return response.json().get('result', {}).get('message_id')
            return None
    except Exception as e:
        await log(f"⚠️ Tech telegram photo error: {e}")
        return None


async def edit_tech_telegram_message(chat_id: str, message_id: int, text: str):
    """Edit a message sent via @vitalljobtechbot."""
    token = TELEGRAM_TECH_BOT_TOKEN or TELEGRAM_BOT_TOKEN
    if not token or not chat_id or not message_id:
        return
    try:
        async with httpx.AsyncClient() as client:
            payload = {
                "chat_id": chat_id,
                "message_id": message_id,
                "text": text,
                "parse_mode": "HTML"
            }
            await client.post(
                f"https://api.telegram.org/bot{token}/editMessageText",
                json=payload,
                timeout=10.0
            )
    except Exception as e:
        await log(f"⚠️ Tech telegram edit error: {e}")


# ============================================
# CONFIRMATION FLOW BEFORE SUBMISSION
# ============================================

CONFIRMATION_TIMEOUT_SECONDS = 300  # 5 minutes

async def build_form_payload(app_data: dict, profile: dict, user_id: str = None) -> dict:
    """Build the payload that will be submitted to the form.

    Returns ALL fields that will be sent to Skyvern for form filling.
    This is shown to the user in Telegram confirmation.

    IMPORTANT: First uses profile data, then fills gaps from knowledge_base.
    """
    structured = profile.get('structured_content', {}) or {}
    personal_info = structured.get('personalInfo', {})
    address_info = personal_info.get('address', {}) if isinstance(personal_info.get('address'), dict) else {}

    # Work experience - use 'position' field (not 'title')
    work_experience = structured.get('workExperience', []) or []
    # Normalize "Nåværende" dates — ATS forms expect actual dates or empty
    current_date_terms = {'nåværende', 'present', 'current', 'pågående', 'nå', 'now', 'ongoing', 'dd'}
    for exp in work_experience:
        end_date = str(exp.get('endDate', '') or '').strip().lower()
        if end_date in current_date_terms:
            exp['endDate'] = ''
            exp['isCurrentPosition'] = True
    current_job = work_experience[0] if work_experience else {}

    # Education
    education = structured.get('education', []) or []
    latest_education = education[0] if education else {}

    cover_letter = app_data.get('cover_letter_no', '') or app_data.get('cover_letter_uk', '')

    full_name = personal_info.get('fullName', '') or personal_info.get('name', '')
    first_name = full_name.split()[0] if full_name else ''
    last_name = ' '.join(full_name.split()[1:]) if full_name and len(full_name.split()) > 1 else ''

    # Get knowledge base for filling gaps
    kb_data = await get_knowledge_base_dict(user_id)

    # Build payload from profile first
    city = str(address_info.get('city', '') or personal_info.get('city', '') or '')
    postal_code = str(address_info.get('postalCode', '') or personal_info.get('postalCode', '') or '')
    country = str(address_info.get('country', '') or personal_info.get('country', '') or 'Norge')
    address = str(address_info.get('street', '') or (personal_info.get('address', '') if isinstance(personal_info.get('address'), str) else '') or '')

    # Fill gaps from knowledge_base
    if not postal_code:
        postal_code = kb_data.get('postal_code', '') or kb_data.get('Postal Code', '') or ''
    if not city:
        city = kb_data.get('city', '') or kb_data.get('City', '') or ''
    if not address:
        address = kb_data.get('address', '') or kb_data.get('Address', '') or ''

    raw_phone = personal_info.get('phone', '')
    contact_phone = normalize_phone_for_norway(raw_phone)

    # New personal fields with KB fallback
    birth_date = personal_info.get('birthDate', '') or kb_data.get('birth_date', '') or kb_data.get('Birth Date', '') or ''
    nationality = personal_info.get('nationality', '') or kb_data.get('nationality', '') or kb_data.get('Nationality', '') or ''
    gender = personal_info.get('gender', '') or kb_data.get('gender', '') or kb_data.get('Gender', '') or ''

    # Split birth_date into components for dropdown forms (Dag/Måned/År)
    birth_day = ""
    birth_month = ""
    birth_year = ""
    if birth_date and '-' in birth_date:
        parts = birth_date.split('-')
        if len(parts) == 3:
            birth_year = parts[0]          # "1979"
            birth_month = str(int(parts[1]))  # "11" -> "11" (strip leading zero)
            birth_day = str(int(parts[2]))    # "05" -> "5"

    return {
        # Personal info
        "full_name": full_name,
        "first_name": first_name,
        "last_name": last_name,
        "email": personal_info.get('email', ''),
        "phone": contact_phone,
        "birth_date": birth_date,
        "birth_day": birth_day,
        "birth_month": birth_month,
        "birth_year": birth_year,
        "Dag": birth_day,
        "Måned": birth_month,
        "År": birth_year,
        "Fødselsår": birth_year,
        "nationality": nationality,
        "gender": gender,
        "driver_license": personal_info.get('driverLicense', ''),

        # Address - from profile + KB fallback
        "street": address,
        "city": city,
        "postal_code": postal_code,
        "country": country,
        "address": f"{address}, {postal_code} {city}".strip(', ') if address else city,

        # Work experience - note: field is 'position', not 'title'!
        "current_position": current_job.get('position', '') or current_job.get('title', ''),
        "current_company": current_job.get('company', ''),

        # Education
        "education_level": latest_education.get('degree', ''),
        "education_field": latest_education.get('field', ''),
        "education_school": latest_education.get('institution', ''),

        # Cover letter
        "cover_letter": cover_letter,
        "cover_letter_preview": cover_letter[:500] + "..." if len(cover_letter) > 500 else cover_letter
    }


async def create_confirmation_request(
    app_id: str,
    job_id: str,
    job_title: str,
    company: str,
    external_url: str,
    payload: dict,
    chat_id: str
) -> str | None:
    """Create confirmation request and send to Telegram.

    Returns: confirmation_id or None
    """
    try:
        from datetime import timedelta

        # Create confirmation record
        expires_at = (datetime.now() + timedelta(seconds=CONFIRMATION_TIMEOUT_SECONDS)).isoformat()

        confirmation_data = {
            "application_id": app_id,
            "job_id": job_id,
            "telegram_chat_id": chat_id,
            "payload": payload,
            "status": "pending",
            "expires_at": expires_at
        }

        response = supabase.table("application_confirmations").insert(confirmation_data).execute()

        if not response.data or len(response.data) == 0:
            await log("❌ Failed to create confirmation record")
            return None

        confirmation_id = response.data[0]['id']

        # Build Telegram message with FULL payload preview
        domain = extract_domain(external_url) if external_url else "невідомий сайт"

        # Build fields list dynamically - show all non-empty fields
        fields_text = ""

        # Personal info section
        fields_text += "<b>👤 Особисті дані:</b>\n"
        if payload.get('full_name'):
            fields_text += f"   Ім'я: <code>{payload['full_name']}</code>\n"
        if payload.get('email'):
            fields_text += f"   Email: <code>{payload['email']}</code>\n"
        if payload.get('phone'):
            fields_text += f"   Телефон: <code>{payload['phone']}</code>\n"

        # Address section
        address_parts = []
        addr = payload.get('address', '')
        if addr and isinstance(addr, str):
            address_parts.append(addr)
        postal = payload.get('postal_code', '')
        if postal and isinstance(postal, str):
            address_parts.append(postal)
        city = payload.get('city', '')
        if city and isinstance(city, str):
            address_parts.append(city)
        country = payload.get('country', '')
        if country and isinstance(country, str) and country != 'Norge':
            address_parts.append(country)

        if address_parts:
            fields_text += f"\n<b>📍 Адреса:</b>\n"
            fields_text += f"   <code>{', '.join(address_parts)}</code>\n"

        # Work experience section
        if payload.get('current_position') or payload.get('current_company'):
            fields_text += f"\n<b>💼 Поточна робота:</b>\n"
            if payload.get('current_position'):
                fields_text += f"   Посада: <code>{payload['current_position']}</code>\n"
            if payload.get('current_company'):
                fields_text += f"   Компанія: <code>{payload['current_company']}</code>\n"

        # Education section
        if payload.get('education_level') or payload.get('education_school'):
            fields_text += f"\n<b>🎓 Освіта:</b>\n"
            if payload.get('education_level'):
                fields_text += f"   Ступінь: <code>{payload['education_level']}</code>\n"
            if payload.get('education_field'):
                fields_text += f"   Спеціальність: <code>{payload['education_field']}</code>\n"
            if payload.get('education_school'):
                fields_text += f"   Заклад: <code>{payload['education_school']}</code>\n"

        message = (
            f"📋 <b>Підтвердження перед відправкою</b>\n\n"
            f"🏢 <b>{job_title}</b>\n"
            f"🏛 {company}\n"
            f"🌐 {domain}\n\n"
            f"{fields_text}\n"
            f"<b>📝 Супровідний лист:</b>\n"
            f"<blockquote>{payload.get('cover_letter_preview', '—')}</blockquote>\n\n"
            f"⏱ Таймаут: 5 хвилин"
        )

        # Inline keyboard with confirm/cancel buttons
        keyboard = {
            "inline_keyboard": [[
                {"text": "✅ Підтвердити", "callback_data": f"confirm_apply_{confirmation_id}"},
                {"text": "❌ Скасувати", "callback_data": f"cancel_apply_{confirmation_id}"}
            ]]
        }

        # Send message
        message_id = await send_telegram(chat_id, message, keyboard)

        if message_id:
            # Update confirmation with message_id for potential editing
            supabase.table("application_confirmations").update({
                "telegram_message_id": str(message_id)
            }).eq("id", confirmation_id).execute()

        await log(f"📤 Confirmation request sent: {confirmation_id}")
        return confirmation_id

    except Exception as e:
        await log(f"❌ Failed to create confirmation: {e}")
        return None


async def wait_for_confirmation(confirmation_id: str) -> str:
    """Wait for user to confirm or cancel, or timeout.

    Returns: 'confirmed', 'cancelled', or 'timeout'
    """
    await log(f"⏳ Waiting for confirmation: {confirmation_id}")

    start_time = datetime.now()
    poll_interval = 3  # seconds

    while True:
        try:
            response = supabase.table("application_confirmations") \
                .select("status, expires_at") \
                .eq("id", confirmation_id) \
                .single() \
                .execute()

            if response.data:
                status = response.data.get('status')
                expires_at = response.data.get('expires_at')

                # Check if user responded
                if status == 'confirmed':
                    await log(f"✅ User confirmed: {confirmation_id}")
                    return 'confirmed'
                elif status == 'cancelled':
                    await log(f"❌ User cancelled: {confirmation_id}")
                    return 'cancelled'

                # Check timeout
                if expires_at:
                    from datetime import timezone
                    expires = datetime.fromisoformat(expires_at.replace('Z', '+00:00'))
                    now = datetime.now(timezone.utc)
                    if now > expires:
                        await log(f"⏰ Confirmation timeout: {confirmation_id}")
                        # Update status to timeout
                        supabase.table("application_confirmations").update({
                            "status": "timeout"
                        }).eq("id", confirmation_id).execute()
                        return 'timeout'

            await asyncio.sleep(poll_interval)

        except Exception as e:
            await log(f"⚠️ Confirmation check error: {e}")
            await asyncio.sleep(poll_interval)


async def update_confirmation_submitted(confirmation_id: str):
    """Mark confirmation as submitted after Skyvern completes."""
    try:
        supabase.table("application_confirmations").update({
            "status": "submitted",
            "submitted_at": datetime.now().isoformat()
        }).eq("id", confirmation_id).execute()
    except Exception as e:
        await log(f"⚠️ Failed to update confirmation status: {e}")


async def wait_for_registration_completion(flow_id: str, chat_id: str = None, max_wait_seconds: int = 1800) -> bool:
    """Process registration flow inline and wait for completion.

    Instead of relying on a separate register_site.py daemon, this function
    directly invokes the registration processing from register_site module.

    Args:
        flow_id: The registration flow ID to process
        chat_id: Telegram chat ID for notifications
        max_wait_seconds: Maximum time to wait (default 30 min)

    Returns:
        True if registration completed successfully, False otherwise
    """
    await log(f"🚀 Processing registration flow inline: {flow_id}")

    # Launch registration processing directly (from register_site module)
    # This handles: confirmation → Skyvern task → monitoring → credential saving
    try:
        await asyncio.wait_for(
            _rs_process_registration(flow_id),
            timeout=max_wait_seconds
        )
    except asyncio.TimeoutError:
        await log(f"⏰ Registration timeout after {max_wait_seconds}s")
        if chat_id:
            await send_tech_telegram(chat_id,
                f"⏰ <b>Реєстрація не завершилась за {max_wait_seconds // 60} хвилин</b>\n\n"
                f"Спробуйте зареєструватись вручну."
            )
        return False
    except Exception as e:
        await log(f"❌ Registration processing error: {e}")
        if chat_id:
            await send_tech_telegram(chat_id,
                f"❌ <b>Помилка реєстрації</b>\n\n"
                f"Причина: {str(e)[:200]}"
            )
        return False

    # Check final status
    try:
        response = supabase.table("registration_flows") \
            .select("status, error_message") \
            .eq("id", flow_id) \
            .single() \
            .execute()

        if response.data:
            status = response.data.get('status')
            error = response.data.get('error_message')

            if status == 'completed':
                await log(f"✅ Registration flow completed!")
                return True

            if status == 'failed':
                await log(f"❌ Registration flow failed: {error or 'Unknown'}")
                if chat_id and error:
                    await send_tech_telegram(chat_id,
                        f"❌ <b>Помилка реєстрації</b>\n\nПричина: {error}"
                    )
                return False

            if status == 'cancelled':
                await log(f"❌ Registration flow cancelled by user")
                return False

            await log(f"⚠️ Registration flow ended with status: {status}")
            return False

    except Exception as e:
        await log(f"⚠️ Error checking registration status: {e}")
        return False


async def trigger_finn_apply_task(job_page_url: str, app_data: dict, profile_data: dict):
    """Sends a FINN Enkel Søknad task to Skyvern with 2FA webhook support.

    Args:
        job_page_url: The job page URL to apply to
        app_data: Application data including cover letter
        profile_data: User profile data
    """

    if not FINN_EMAIL or not FINN_PASSWORD:
        await log("❌ FINN_EMAIL and FINN_PASSWORD not configured in .env")
        return None

    cover_letter = app_data.get('cover_letter_no', '') or app_data.get('cover_letter_uk', '')

    # Extract contact info from profile
    structured = profile_data.get('structured_content', {}) or {}
    personal_info = structured.get('personalInfo', {}) or structured
    # Note: TypeScript interface uses 'fullName', not 'name'
    contact_name = personal_info.get('fullName', '') or personal_info.get('name', '')
    raw_phone = personal_info.get('phone', '')
    # Normalize phone for Norwegian forms: remove +47 and spaces
    contact_phone = normalize_phone_for_norway(raw_phone)
    contact_email = personal_info.get('email', '') or FINN_EMAIL

    await log(f"📝 Profile: {contact_name} | {contact_phone} | {contact_email} | letter={len(cover_letter)}ch")

    # Extract finnkode from job URL for apply URL
    finnkode = extract_finnkode(job_page_url)
    if not finnkode:
        await log(f"❌ Cannot extract finnkode from URL: {job_page_url}")
        return None

    await log(f"📋 Extracted finnkode: {finnkode}")

    # 2FA webhook URL
    totp_webhook_url = f"{SUPABASE_URL}/functions/v1/finn-2fa-webhook"

    # Direct apply URL - bypasses Shadow DOM button issue!
    apply_url = f"https://www.finn.no/job/apply?adId={finnkode}"
    await log(f"📋 Direct apply URL: {apply_url}")

    navigation_goal = f"""
GOAL: Submit job application on FINN.no Enkel Søknad.

PHASE 1: LOGIN (FINN uses passwordless login — email + verification code)
   - Accept any cookie popup (click "Godta alle")
   - The email field may already be filled with {FINN_EMAIL}. If not, enter it.
   - Check the "Husk meg" checkbox if available
   - Check the reCAPTCHA checkbox "Jeg er ikke en robot" if it appears
   - Click "Fortsett" (Continue) button
   - FINN will send a verification code to the email address
   - A verification code input field will appear — WAIT for the code to be provided automatically via TOTP
   - Enter the verification code when it appears
   - Complete login

PHASE 2: APPLICATION FORM
   After login, you should see the application form. Fill it:
   - Name/Navn: {contact_name}
   - Email/E-post: {FINN_EMAIL}
   - Phone/Telefon: {contact_phone}
   - Message/Søknadstekst/Melding:

{cover_letter}

PHASE 3: SUBMIT
   - Check any required checkboxes (GDPR, terms)
   - Click "Send søknad" or "Send" button
   - Wait for confirmation message
"""

    data_extraction_schema = {
        "type": "object",
        "properties": {
            "application_sent": {"type": "boolean", "description": "True if submitted"},
            "confirmation_message": {"type": "string"},
            "error_message": {"type": "string"}
        }
    }

    prompt = build_task_prompt(
        navigation_goal,
        data_extraction_goal="Determine if application was submitted.",
        complete_criterion="The page shows 'Søknaden er sendt', 'Takk for din søknad', or a confirmation message that the FINN application was submitted.",
        terminate_criterion="STOP if: (1) Verification code is not provided within timeout, OR (2) The page shows 'Stillingen er ikke lenger tilgjengelig' or 'Annonsen er utløpt', OR (3) A CAPTCHA blocks progress and cannot be checked.",
        navigation_payload={
            "email": FINN_EMAIL,
            "name": contact_name,
            "phone": contact_phone,
            "cover_letter": cover_letter
        },
    )

    # NOTE: totp_timeout_seconds (old API) and wait_before_action_ms have no
    # equivalent field in the new TaskRunRequest schema. totp_url replaces
    # totp_verification_url — Skyvern polls that URL for the code itself
    # (see finn-2fa-webhook, which already returns immediately with the code
    # if available or `{}` otherwise, matching this polling model), so dropping
    # the explicit timeout should be safe.
    payload = {
        "url": apply_url,  # Direct apply URL: finn.no/job/apply?adId={finnkode}
        "prompt": prompt,
        "data_extraction_schema": data_extraction_schema,
        "totp_url": totp_webhook_url,
        "totp_identifier": FINN_EMAIL,
        "max_steps": 35,
        "error_code_mapping": FINN_ERROR_CODES,
        "proxy_location": "RESIDENTIAL_NL"  # Netherlands — closest to Norway, NONE fails on HF Space (US IP → reCAPTCHA)
    }

    return await submit_skyvern_task_with_retry(payload, f"FINN task ({apply_url})")


async def cancel_skyvern_task(run_id: str) -> bool:
    """Cancel a running Skyvern task run.

    Args:
        run_id: The Skyvern run ID to cancel

    Returns:
        True if cancelled successfully, False otherwise
    """
    await log(f"🛑 Cancelling Skyvern task {run_id}...")

    headers = skyvern_headers()

    async with httpx.AsyncClient() as client:
        try:
            response = await client.post(
                f"{SKYVERN_URL}/v1/runs/{run_id}/cancel",
                headers=headers,
                timeout=10.0
            )

            if response.status_code in [200, 204]:
                await log(f"✅ Task {run_id} cancelled successfully")
                return True

            await log(f"⚠️ Failed to cancel task: {response.status_code} - {response.text}")
            return False

        except Exception as e:
            await log(f"❌ Error cancelling task: {e}")
            return False


async def fetch_task_steps(client, task_id: str, headers: dict) -> list:
    """Skyvern's new Task Run API (v1) no longer exposes structured per-step
    action data (element ids, action types, fill results) — only file artifacts
    (screenshots, HTML, logs) via /v1/runs/{run_id}/artifacts. Callers of this
    function (extract_memory_from_task, monitor_task_status detailed reporting)
    degrade gracefully on an empty list, so this is kept as a no-op stub rather
    than removed, to avoid touching every call site.
    """
    return []


def format_step_report(step: dict, step_num: int, total: int) -> str:
    """Format a single step into a Telegram message."""
    step_output = step.get("output", {}) or {}
    action_results = step_output.get("action_results", []) or []

    lines = [f"📍 <b>Step {step_num}/{total}</b>"]

    # Show current URL if available
    step_url = step.get("output", {}).get("url", "") if step.get("output") else ""
    if step_url:
        # Truncate long URLs
        display_url = step_url if len(step_url) <= 50 else step_url[:47] + "..."
        lines.append(f"  🌐 {display_url}")

    if not action_results:
        lines.append("  ⏳ Navigating...")
        return "\n".join(lines)

    for result in action_results:
        action_type = result.get("action_type", "") or result.get("type", "")
        action_type_lower = action_type.lower()

        if action_type_lower in ("input_text", "fill", "send_keys"):
            value = result.get("data", {}).get("text", "") if isinstance(result.get("data"), dict) else ""
            if not value:
                value = result.get("text", "")
            # Truncate long values (cover letters)
            display_val = value[:40] + "..." if len(value) > 40 else value
            lines.append(f"  ✅ Filled: {display_val}")
        elif action_type_lower in ("click", "select_option"):
            target = result.get("data", {}).get("element", "") if isinstance(result.get("data"), dict) else ""
            if not target:
                target = result.get("element_id", action_type)
            display_target = str(target)[:40]
            lines.append(f"  🖱 Clicked: {display_target}")
        elif action_type_lower == "upload_file":
            lines.append(f"  📎 Uploaded file")
        elif action_type_lower in ("wait", "sleep"):
            pass  # Skip wait actions
        elif action_type_lower:
            lines.append(f"  ▶️ {action_type}")

    msg = "\n".join(lines)
    return msg[:2000]


def format_progress_dashboard(job_title: str, company: str, task_id: str,
                               total_steps: int, filled_fields: list, status: str,
                               current_action: str = None) -> str:
    """Format the live-updating progress dashboard message."""
    if status == "running":
        emoji = "⏳"
        status_text = "Заповнює форму..."
    elif status == "completed":
        emoji = "✅"
        status_text = "Завершено!"
    else:
        emoji = "❌"
        status_text = "Помилка"

    lines = [
        f"{emoji} <b>Skyvern: {company}</b>",
        f"📋 {job_title}",
        "",
        f"📊 Крок: {total_steps} | {status_text}",
    ]

    if current_action:
        lines.append(f"▶️ {current_action}")

    if filled_fields:
        lines.append(f"\n📝 <b>Заповнено ({len(filled_fields)}):</b>")
        for field in filled_fields[-6:]:  # Show last 6 fields
            lines.append(f"  ✅ {field}")
        if len(filled_fields) > 6:
            lines.append(f"  ... та ще {len(filled_fields) - 6}")

    msg = "\n".join(lines)
    return msg[:2000]


async def monitor_task_status(task_id, chat_id: str = None, job_title: str = None, app_id: str = None,
                               detailed_reporting: bool = False, job_company: str = None, job_url: str = None,
                               user_id: str = None, job_id: str = None):
    """Polls Skyvern API and updates Supabase based on result.

    Args:
        task_id: The Skyvern task ID to monitor
        chat_id: Telegram chat ID for notifications (magic link detection)
        job_title: Job title for notifications
        app_id: Application ID for checking user cancellation
        detailed_reporting: If True, send step-by-step Telegram reports
        job_company: Company name for dashboard display
        job_url: URL being processed for dashboard display

    Returns:
        'sent', 'failed', 'manual_review', 'magic_link', or 'cancelled'
    """
    await log(f"⏳ Monitoring Task {task_id}...")

    headers = skyvern_headers()
    monitor_start = datetime.now()
    MAX_MONITOR_MINUTES = 15  # Hard limit — cancel task if monitoring exceeds this

    # Detailed reporting state
    seen_step_count = 0
    all_filled_fields = []
    dashboard_msg_id = None

    # Send initial dashboard if detailed reporting enabled
    if detailed_reporting and chat_id:
        dashboard_text = format_progress_dashboard(
            job_title or "Job", job_company or "Company", task_id,
            0, [], "running"
        )
        dashboard_msg_id = await send_tech_telegram(chat_id, dashboard_text)

    async with httpx.AsyncClient() as client:
        while True:
            # Hard timeout — cancel task if monitoring exceeds MAX_MONITOR_MINUTES
            elapsed_min = (datetime.now() - monitor_start).total_seconds() / 60
            if elapsed_min > MAX_MONITOR_MINUTES:
                await log(f"⏰ Monitor timeout ({MAX_MONITOR_MINUTES}min) — cancelling task {task_id}")
                await cancel_skyvern_task(task_id)
                return 'failed'

            # Check if user cancelled (status changed back to 'approved')
            if app_id:
                try:
                    app_check = supabase.table("applications").select("status").eq("id", app_id).single().execute()
                    if app_check.data and app_check.data.get("status") == "approved":
                        await log(f"🛑 User cancelled! Application status is 'approved'")
                        await cancel_skyvern_task(task_id)
                        return 'cancelled'
                except Exception as e:
                    await log(f"⚠️ Error checking app status: {e}")

            try:
                response = await client.get(
                    f"{SKYVERN_URL}/v1/runs/{task_id}",
                    headers=headers,
                    timeout=10.0
                )

                if response.status_code == 200:
                    data = response.json()
                    status = data.get('status')
                    extracted_data = data.get('output', {}) or {}
                    if not isinstance(extracted_data, dict):
                        extracted_data = {}

                    # Check for magic link detection
                    if extracted_data.get('magic_link_sent'):
                        magic_email = extracted_data.get('magic_link_email', 'your email')
                        await log(f"🔗 Magic link detected! Email sent to: {magic_email}")

                        # Notify user via Telegram
                        if chat_id:
                            await send_telegram(chat_id,
                                f"🔗 <b>Magic Link Login!</b>\n\n"
                                f"📋 {job_title or 'Job'}\n\n"
                                f"📧 Посилання для входу надіслано на:\n"
                                f"<code>{magic_email}</code>\n\n"
                                f"<b>Що робити:</b>\n"
                                f"1️⃣ Перевірте пошту\n"
                                f"2️⃣ Натисніть на посилання для входу\n"
                                f"3️⃣ Після входу подайте заявку вручну\n\n"
                                f"⚠️ Цей сайт НЕ підтримує автоматичну подачу через пароль."
                            )

                        return 'magic_link'

                    if status == 'completed':
                        await log("✅ Skyvern finished: COMPLETED")

                        # Send final detailed report
                        if detailed_reporting and chat_id and dashboard_msg_id:
                            final_text = format_progress_dashboard(
                                job_title or "Job", job_company or "Company", task_id,
                                seen_step_count, all_filled_fields, "completed"
                            )
                            await edit_tech_telegram_message(chat_id, dashboard_msg_id, final_text)

                        # Check if application was actually submitted
                        if extracted_data.get('application_submitted') == False:
                            await log("⚠️ Task completed but application was NOT submitted")
                            return 'manual_review'

                        # Send final screenshot to tech bot (from Skyvern artifacts)
                        if chat_id:
                            screenshot_path = await fetch_task_screenshot(client, task_id, headers)
                            if screenshot_path:
                                caption = f"✅ <b>Заявку відправлено!</b>\n📋 {job_title or 'Job'}\n🏢 {job_company or ''}"
                                await send_tech_telegram_photo_file(chat_id, screenshot_path, caption)
                            else:
                                await log("📸 No screenshot available from Skyvern artifacts")

                        return 'sent'

                    if status in ['failed', 'terminated']:
                        reason = data.get('failure_reason', 'Unknown')
                        await log(f"❌ Skyvern failed: {status}. Reason: {reason}")

                        # Send final detailed report on failure
                        if detailed_reporting and chat_id and dashboard_msg_id:
                            final_text = format_progress_dashboard(
                                job_title or "Job", job_company or "Company", task_id,
                                seen_step_count, all_filled_fields, "failed"
                            )
                            await edit_tech_telegram_message(chat_id, dashboard_msg_id, final_text)

                        # Send failure screenshot to tech bot (from Skyvern artifacts)
                        if chat_id:
                            screenshot_path = await fetch_task_screenshot(client, task_id, headers)
                            if screenshot_path:
                                caption = f"❌ <b>Помилка</b>\n📋 {job_title or 'Job'}\n💬 {reason[:200]}"
                                await send_tech_telegram_photo_file(chat_id, screenshot_path, caption)
                            else:
                                await log("📸 No screenshot available from Skyvern artifacts")

                        # Check structured error codes first (from error_code_mapping)
                        task_errors = data.get('errors', [])
                        error_codes = [e.get('error_code', '') for e in task_errors if isinstance(e, dict)]
                        if error_codes:
                            await log(f"   📋 Structured error codes: {error_codes}")

                        # CRITICAL: When Skyvern hits REACH_MAX_STEPS, it returns ALL
                        # error_code_mapping keys as errors (false positives).
                        # Filter out custom codes when REACH_MAX_STEPS is present.
                        skyvern_internal_codes = {'REACH_MAX_STEPS', 'REACH_MAX_RETRIES'}
                        has_max_steps = 'REACH_MAX_STEPS' in error_codes
                        if has_max_steps:
                            await log(f"   ⚠️ REACH_MAX_STEPS detected — ignoring custom error codes (false positives)")
                            # Keep only Skyvern internal codes, discard custom mapping codes
                            error_codes = [c for c in error_codes if c in skyvern_internal_codes]

                        if 'magic_link' in error_codes:
                            await log(f"🔗 Magic link detected via error_code_mapping")
                            if chat_id:
                                try:
                                    await send_telegram(str(chat_id),
                                        f"🔗 <b>Magic Link Login!</b>\n\n"
                                        f"📋 {job_title or 'Job'}\n\n"
                                        f"⚠️ Сайт використовує Magic Link автентифікацію.\n\n"
                                        f"<b>Що робити:</b>\n"
                                        f"1️⃣ Перевірте пошту (включно зі спамом)\n"
                                        f"2️⃣ Натисніть на посилання для входу\n"
                                        f"3️⃣ Після входу подайте заявку вручну\n\n"
                                        f"ℹ️ Цей сайт НЕ підтримує автоматичну подачу через пароль."
                                    )
                                    await log(f"📱 Telegram notification sent to {chat_id}")
                                except Exception as e:
                                    await log(f"⚠️ Failed to send Telegram: {e}")
                            return 'magic_link'
                        elif 'position_closed' in error_codes:
                            await log(f"⛔ Position closed/expired (error_code_mapping)")
                            return 'failed'
                        elif 'registration_required' in error_codes:
                            await log(f"📝 Registration required (error_code_mapping)")
                            return 'manual_review'
                        elif 'file_upload_required' in error_codes:
                            await log(f"📎 File upload required (error_code_mapping)")
                            return 'manual_review'
                        elif 'captcha_blocked' in error_codes:
                            await log(f"🤖 CAPTCHA blocked (error_code_mapping)")
                            return 'manual_review'
                        elif 'login_failed' in error_codes:
                            await log(f"🔒 Login failed (error_code)")
                            domain = extract_domain(job_url) if job_url else None
                            if chat_id and domain and user_id:
                                result = await handle_login_failure(
                                    domain, user_id, str(chat_id),
                                    job_title=job_title or '', job_id=job_id,
                                    app_id=app_id, external_url=job_url
                                )
                                if result == 'retry':
                                    return 'retry'
                            return 'failed'
                        elif '2fa_timeout' in error_codes:
                            await log(f"⏰ 2FA timeout (error_code_mapping)")
                            return 'failed'

                        # Handle Skyvern internal REACH_MAX_RETRIES
                        if 'REACH_MAX_RETRIES' in error_codes:
                            reason_str = str(reason)
                            if '<span' in reason_str and "doesn't support text input" in reason_str:
                                await log(f"📝 Rich text editor fill failed (span element). Setting manual_review.")
                                if chat_id:
                                    try:
                                        await send_telegram(str(chat_id),
                                            f"⚠️ <b>Не вдалося заповнити поле!</b>\n\n"
                                            f"📋 {job_title or 'Job'}\n\n"
                                            f"Сайт використовує rich text editor (TinyMCE/CKEditor), "
                                            f"який Skyvern не може заповнити автоматично.\n\n"
                                            f"<b>Що робити:</b>\n"
                                            f"Відкрийте сайт та вставте супровідний лист вручну."
                                        )
                                        await log(f"📱 Telegram notification sent to {chat_id}")
                                    except Exception as e:
                                        await log(f"⚠️ Failed to send Telegram: {e}")
                                return 'manual_review'
                            elif 'upload_file' in reason_str or 'file chooser' in reason_str or 'file upload' in reason_str.lower():
                                await log(f"📎 File upload failed (no file chooser / custom widget). Setting manual_review.")
                                if chat_id:
                                    try:
                                        await send_telegram(str(chat_id),
                                            f"⚠️ <b>Не вдалося завантажити CV!</b>\n\n"
                                            f"📋 {job_title or 'Job'}\n\n"
                                            f"Сайт використовує нестандартний віджет завантаження файлів, "
                                            f"який Skyvern не може обробити автоматично.\n\n"
                                            f"<b>Що робити:</b>\n"
                                            f"Відкрийте сайт та завантажте CV вручну. "
                                            f"Супровідний лист можливо вже заповнений."
                                        )
                                        await log(f"📱 Telegram notification sent to {chat_id}")
                                    except Exception as e:
                                        await log(f"⚠️ Failed to send Telegram: {e}")
                                return 'manual_review'
                            else:
                                await log(f"🔄 REACH_MAX_RETRIES - form interaction failed. Reason: {reason_str[:300]}")
                                if chat_id:
                                    # Extract a short human-readable hint from the reason
                                    hint = ""
                                    if 'validation error' in reason_str.lower() or 'date' in reason_str.lower():
                                        hint = "Форма показує помилку валідації (можливо неправильний формат дати)."
                                    elif "doesn't support text input" in reason_str:
                                        hint = "Skyvern не зміг знайти правильне поле для вводу тексту."
                                    else:
                                        hint = "Skyvern застряг на одному з кроків заповнення форми."
                                    try:
                                        await send_telegram(str(chat_id),
                                            f"⚠️ <b>Форму не вдалося заповнити!</b>\n\n"
                                            f"📋 {job_title or 'Job'}\n\n"
                                            f"{hint}\n\n"
                                            f"<b>Що робити:</b>\n"
                                            f"Відкрийте сайт та заповніть форму вручну.\n"
                                            f"Дані профілю та супровідний лист збережені в системі."
                                        )
                                    except Exception as e:
                                        await log(f"⚠️ Failed to send Telegram: {e}")
                                return 'manual_review'

                        # Handle REACH_MAX_STEPS (form too complex / stuck on validation)
                        if 'REACH_MAX_STEPS' in error_codes:
                            reason_str = str(reason)
                            reason_str_lower = reason_str.lower()
                            await log(f"⏱️ REACH_MAX_STEPS — Skyvern exhausted step limit. Reason: {reason_str[:300]}")

                            # Check if max steps was caused by login failure (wrong password loop)
                            login_keywords = ['login', 'logg inn', 'password', 'passord', 'invalid email', 'credentials']
                            if any(kw in reason_str_lower for kw in login_keywords):
                                await log(f"🔒 REACH_MAX_STEPS caused by login failure")
                                domain = extract_domain(job_url) if job_url else None
                                if chat_id and domain and user_id:
                                    result = await handle_login_failure(
                                        domain, user_id, str(chat_id),
                                        job_title=job_title or '', job_id=job_id,
                                        app_id=app_id, external_url=job_url
                                    )
                                    if result == 'retry':
                                        return 'retry'
                                return 'failed'

                            if chat_id:
                                hint = ""
                                if 'validation' in reason_str_lower or 'date' in reason_str_lower:
                                    hint = "\n\n💡 Можлива причина: помилка валідації форми (неправильний формат дати або обов'язкове поле)."
                                elif 'upload' in reason_str_lower or 'file' in reason_str_lower:
                                    hint = "\n\n💡 Можлива причина: не вдалося завантажити файл."
                                try:
                                    await send_telegram(str(chat_id),
                                        f"⏱️ <b>Skyvern вичерпав ліміт кроків!</b>\n\n"
                                        f"📋 {job_title or 'Job'}\n\n"
                                        f"Форма виявилась занадто складною — Skyvern не встиг заповнити її за відведені кроки.{hint}\n\n"
                                        f"<b>Що робити:</b>\n"
                                        f"Відкрийте сайт та заповніть форму вручну.\n"
                                        f"Дані профілю та супровідний лист збережені в системі."
                                    )
                                except Exception as e:
                                    await log(f"⚠️ Failed to send Telegram: {e}")
                            return 'manual_review'

                        # Fallback: Check failure_reason string matching
                        reason_lower = str(reason).lower()
                        is_magic_link = (
                            ('check email' in reason_lower and 'link' in reason_lower) or
                            ('email' in reason_lower and 'login link' in reason_lower) or
                            ('post-login' in reason_lower and 'email' in reason_lower) or
                            ('magic link' in reason_lower) or
                            ('email link' in reason_lower) or
                            ('email' in reason_lower and ('link' in reason_lower or 'verification' in reason_lower))
                        )

                        await log(f"   🔍 Magic link check (string fallback): {is_magic_link} (chat_id={chat_id})")

                        if is_magic_link:
                            await log(f"🔗 Magic link detected from failure reason!")
                            if chat_id:
                                try:
                                    await send_telegram(str(chat_id),
                                        f"🔗 <b>Magic Link Login!</b>\n\n"
                                        f"📋 {job_title or 'Job'}\n\n"
                                        f"⚠️ Сайт використовує Magic Link автентифікацію.\n\n"
                                        f"<b>Що робити:</b>\n"
                                        f"1️⃣ Перевірте пошту (включно зі спамом)\n"
                                        f"2️⃣ Натисніть на посилання для входу\n"
                                        f"3️⃣ Після входу подайте заявку вручну\n\n"
                                        f"ℹ️ Цей сайт НЕ підтримує автоматичну подачу через пароль."
                                    )
                                    await log(f"📱 Telegram notification sent to {chat_id}")
                                except Exception as e:
                                    await log(f"⚠️ Failed to send Telegram: {e}")
                            return 'magic_link'

                        if 'manual' in reason_lower:
                            return 'manual_review'

                        # Fallback: detect login failure from failure_reason text
                        login_fail_keywords = ['login', 'logg inn', 'password', 'passord', 'credentials', 'authentication', 'error message with no visible form']
                        if any(kw in reason_lower for kw in login_fail_keywords):
                            await log(f"🔒 Login failure detected from reason text")
                            domain = extract_domain(job_url) if job_url else None
                            if chat_id and domain and user_id:
                                result = await handle_login_failure(
                                    domain, user_id, str(chat_id),
                                    job_title=job_title or '', job_id=job_id,
                                    app_id=app_id, external_url=job_url
                                )
                                if result == 'retry':
                                    return 'retry'

                        return 'failed'

                    # Fetch steps and update dashboard in-place (no per-step spam)
                    if detailed_reporting and chat_id:
                        steps = await fetch_task_steps(client, task_id, headers)
                        if len(steps) > seen_step_count:
                            new_steps = steps[seen_step_count:]
                            current_action = None

                            for step in new_steps:
                                step_output = step.get("output", {}) or {}
                                action_results = step_output.get("action_results", []) or []

                                for result in action_results:
                                    action_type = (result.get("action_type", "") or result.get("type", "")).lower()
                                    if action_type in ("input_text", "fill", "send_keys"):
                                        value = ""
                                        if isinstance(result.get("data"), dict):
                                            value = result["data"].get("text", "")
                                        if not value:
                                            value = result.get("text", "")
                                        display_val = value[:35] + "..." if len(value) > 35 else value
                                        if display_val:
                                            all_filled_fields.append(display_val)
                                        current_action = f"Filled: {display_val}"
                                    elif action_type in ("click", "select_option"):
                                        target = ""
                                        if isinstance(result.get("data"), dict):
                                            target = result["data"].get("element", "")
                                        if not target:
                                            target = result.get("element_id", action_type)
                                        current_action = f"Clicked: {str(target)[:30]}"
                                    elif action_type == "upload_file":
                                        current_action = "Uploading file..."

                                if not action_results:
                                    current_action = "Navigating..."

                            seen_step_count = len(steps)

                            # Update dashboard in-place (single message, no spam)
                            if dashboard_msg_id:
                                dashboard_text = format_progress_dashboard(
                                    job_title or "Job", job_company or "Company", task_id,
                                    seen_step_count, all_filled_fields, "running",
                                    current_action=current_action
                                )
                                await edit_tech_telegram_message(chat_id, dashboard_msg_id, dashboard_text)

                await asyncio.sleep(10)

            except Exception as e:
                await log(f"⚠️ Monitoring Error: {e}")
                await asyncio.sleep(10)

async def extract_linkedin_apply_url(job_url: str, email: str, password: str) -> str | None:
    """Use Skyvern to login to LinkedIn, open job page, and extract external apply URL.
    Returns the external URL or None if it's LinkedIn Easy Apply only."""
    try:
        navigation_goal = f"""
1. If not logged in, login to LinkedIn with email: {email} and password: {password}
2. Navigate to {job_url}
3. Look for an "Apply" or "Apply on company website" or "Søk nå" button
4. If the button says "Easy Apply" — this is LinkedIn internal apply, STOP and report no external URL
5. If the button leads to an external website — click it
6. After redirect, extract the FINAL URL from the browser address bar
7. Report the external URL as the result

IMPORTANT: Do NOT fill any forms. Only extract the external application URL.
"""
        prompt = build_task_prompt(
            navigation_goal,
            data_extraction_goal="Extract the external application URL that the Apply button redirects to. If it's LinkedIn Easy Apply (no external redirect), return empty.",
        )
        payload = {
            "url": job_url,
            "prompt": prompt,
            "max_steps": 10,
        }

        headers = skyvern_headers()
        async with httpx.AsyncClient() as client:
            resp = await client.post(
                f"{SKYVERN_URL}/v1/run/tasks",
                json=payload,
                headers=headers,
                timeout=30.0
            )
            if resp.status_code not in (200, 201):
                await log(f"⚠️ LinkedIn URL extraction: Skyvern returned {resp.status_code}")
                return None

            task_data = resp.json()
            run_id = task_data.get("run_id")
            if not run_id:
                return None

            await log(f"🔗 LinkedIn extraction task: {run_id}")

            # Poll for completion (max 3 min)
            for _ in range(36):
                await asyncio.sleep(5)
                status_resp = await client.get(
                    f"{SKYVERN_URL}/v1/runs/{run_id}",
                    headers=headers,
                    timeout=10.0
                )
                if status_resp.status_code != 200:
                    continue
                task = status_resp.json()
                status = task.get("status", "")

                if status == "completed":
                    # Extract URL from extracted data
                    extracted = task.get("output") or {}
                    if isinstance(extracted, dict):
                        ext_url = extracted.get("url") or extracted.get("external_url") or extracted.get("apply_url") or ""
                    elif isinstance(extracted, str):
                        ext_url = extracted
                    else:
                        ext_url = ""

                    if ext_url and "linkedin.com" not in ext_url:
                        return ext_url
                    return None

                elif status in ("failed", "terminated", "canceled"):
                    return None

            return None  # timeout
    except Exception as e:
        await log(f"⚠️ LinkedIn URL extraction error: {e}")
        return None


async def process_application(app, skip_confirmation: bool = False):
    """Process a single application.

    Args:
        app: Application data from database
        skip_confirmation: If True, skip Telegram confirmation (for retries)
    """
    app_id = app['id']
    job_id = app['job_id']

    # Get Job data (including external_apply_url and has_enkel_soknad for FINN check)
    job_res = supabase.table("jobs").select("job_url, external_apply_url, title, company, user_id, has_enkel_soknad, application_form_type").eq("id", job_id).single().execute()
    job_data = job_res.data
    job_url = job_data.get('job_url')
    external_apply_url = job_data.get('external_apply_url', '')
    job_title = job_data.get('title', 'Unknown Job')
    job_company = job_data.get('company', 'Unknown Company')
    user_id = job_data.get('user_id')
    has_enkel_soknad = job_data.get('has_enkel_soknad', False)
    application_form_type = job_data.get('application_form_type', '')

    # Check for duplicate: has this job already been sent by this user?
    try:
        dup_check = supabase.table("applications") \
            .select("id, status") \
            .eq("job_id", job_id).eq("status", "sent") \
            .limit(1).execute()
        if dup_check.data:
            await log(f"⚠️ Job already has a SENT application ({dup_check.data[0]['id'][:8]}). Skipping duplicate.")
            supabase.table("applications").update({"status": "draft"}).eq("id", app_id).execute()
            return False
    except Exception as e:
        await log(f"⚠️ Duplicate check failed: {e}")

    # Consolidated job info log
    form_type_short = 'FINN' if has_enkel_soknad or application_form_type == 'finn_easy' else application_form_type or 'unknown'
    await log(f"📋 Job: {job_title} [{form_type_short}]")

    # Guard: skip if already waiting for registration
    existing_metadata = app.get('skyvern_metadata') or {}
    if existing_metadata.get('waiting_for_registration'):
        existing_flow_id = existing_metadata.get('registration_flow_id')
        if existing_flow_id:
            try:
                flow_check = supabase.table("registration_flows") \
                    .select("id, status").eq("id", existing_flow_id).single().execute()
                if flow_check.data:
                    flow_status = flow_check.data.get('status')
                    active = ('pending', 'analyzing', 'registering', 'waiting_for_user',
                              'email_verification', 'sms_verification', 'link_verification',
                              'review_pending', 'submitting')
                    if flow_status in active:
                        await log(f"⏳ Registration in progress ({flow_status}), skipping")
                        supabase.table("applications").update({
                            "status": "manual_review"
                        }).eq("id", app_id).eq("status", "sending").execute()
                        return
                    elif flow_status == 'completed':
                        await log(f"✅ Registration completed, continuing")
                        supabase.table("applications").update({
                            "skyvern_metadata": {
                                **existing_metadata,
                                "waiting_for_registration": False,
                                "registration_completed": True
                            }
                        }).eq("id", app_id).execute()
                        # Fall through to normal processing
                    else:
                        # Registration failed/cancelled/timeout — clear flag and retry
                        await log(f"⚠️ Previous registration {flow_status} — will retry")
                        supabase.table("applications").update({
                            "skyvern_metadata": {
                                **existing_metadata,
                                "waiting_for_registration": False,
                                "previous_registration_status": flow_status
                            }
                        }).eq("id", app_id).execute()
                        # Fall through to FlowRouter for a fresh registration attempt
            except Exception as e:
                await log(f"⚠️ Error checking registration flow: {e}")

    if not job_url and not external_apply_url:
        await log(f"❌ No URL found for App ID {app_id}")
        supabase.table("applications").update({
            "status": "failed",
            "skyvern_metadata": {"error_message": "No job URL or external apply URL found", "failure_reason": "no_url"}
        }).eq("id", app_id).execute()
        return

    # Check if this is a FINN Enkel Søknad
    # Cases:
    # 1. Direct FINN job (job_url contains finn.no) with has_enkel_soknad or finn_easy
    # 2. NAV/other job that redirects to FINN (external_apply_url contains finn.no/job/apply)

    is_finn_easy = False
    finn_apply_url = None  # The URL to use for FINN apply

    # Case 1: Direct FINN job
    if job_url and 'finn.no' in job_url:
        if has_enkel_soknad or application_form_type == 'finn_easy':
            is_finn_easy = True
            finn_apply_url = job_url
            await log(f"   ✓ FINN Enkel Søknad detected (direct FINN job)")

    # Case 2: NAV or other platform job with FINN external apply URL
    if not is_finn_easy and external_apply_url and 'finn.no/job/apply' in external_apply_url:
        is_finn_easy = True
        finn_apply_url = external_apply_url
        await log(f"   ✓ FINN Enkel Søknad detected (NAV→FINN redirect)")

    # Case 3: Has finn_easy markers but URL not detected yet - check external_apply_url
    if not is_finn_easy and (has_enkel_soknad or application_form_type == 'finn_easy'):
        if external_apply_url and 'finn.no' in external_apply_url:
            is_finn_easy = True
            finn_apply_url = external_apply_url
            await log(f"   ✓ FINN Enkel Søknad detected (from external_apply_url)")

    await log(f"   is_finn_easy: {is_finn_easy}")
    if finn_apply_url:
        await log(f"   finn_apply_url: {finn_apply_url}")

    # Get user's Telegram chat ID for notifications
    chat_id = None
    if user_id:
        try:
            settings_res = supabase.table("user_settings").select("telegram_chat_id").eq("user_id", user_id).single().execute()
            chat_id = settings_res.data.get('telegram_chat_id') if settings_res.data else None
            await log(f"   telegram_chat_id: {chat_id or 'NOT SET'}")
        except Exception as e:
            await log(f"   ⚠️ Failed to get telegram_chat_id: {e}")
    else:
        await log(f"   ⚠️ No user_id for job - cannot send Telegram notifications")

    # === FLOW ROUTER ===
    # Route to appropriate flow based on form type
    # This determines HOW to process the application before we start
    if not is_finn_easy and chat_id:
        route_result = await FlowRouter.route(
            form_type=application_form_type or 'unknown',
            app_id=app_id,
            job_data={
                'id': job_id,
                'title': job_title,
                'company': job_company,
                'job_url': job_url,
                'external_apply_url': external_apply_url,
                'application_form_type': application_form_type,
                'user_id': user_id
            },
            app_data=app,
            chat_id=chat_id
        )

        await log(f"   Flow: {route_result.get('flow')} - {route_result.get('status')}")

        # Handle special flow statuses
        if route_result.get('status') == 'blocked_platform':
            supabase.table("applications").update({
                "status": "manual_review",
                "error_message": f"Platform blocked: {route_result.get('message', 'too heavy')}"
            }).eq("id", app_id).execute()
            return False

        if route_result.get('status') == 'email_required':
            # Email application - already notified user, mark as manual_review
            supabase.table("applications").update({
                "status": "manual_review",
                "error_message": "Email application - manual sending required"
            }).eq("id", app_id).execute()
            return False

        if route_result.get('status') == 'needs_registration':
            # Needs registration - ask user or trigger registration
            await log("📝 Triggering registration flow...")
            domain = extract_domain(external_apply_url or job_url)
            flow_id = await trigger_registration_flow(
                domain=domain,
                job_id=job_id,
                app_id=app_id,
                chat_id=chat_id,
                job_title=job_title,
                external_url=external_apply_url or job_url,
                user_id=user_id
            )

            if flow_id is None:
                # User provided existing credentials — re-check and continue
                has_creds_now, new_creds, _ = await check_credentials_for_url(external_apply_url or job_url, user_id)
                if has_creds_now and new_creds:
                    await log(f"🔐 User provided credentials for {domain}, continuing...")
                    route_credentials = new_creds
                    # Fall through to standard submission below
                else:
                    await log(f"⚠️ No credentials found after Q&A for {domain}")
                    # Proceed without credentials
                    route_credentials = None
            else:
                # Registration flow started — wait for it to complete
                await log(f"⏳ Waiting for registration flow: {flow_id[:8]}...")
                registration_completed = await wait_for_registration_completion(flow_id, chat_id, max_wait_seconds=1800)

                if registration_completed:
                    await log(f"✅ Registration completed! Continuing with application...")
                    new_creds = await get_site_credentials(domain, user_id)
                    if new_creds:
                        route_credentials = new_creds
                        await log(f"🔐 Got new credentials for {domain}")
                        if chat_id:
                            await send_tech_telegram(chat_id,
                                f"✅ <b>Реєстрація завершена!</b>\n\n"
                                f"🔐 Тепер заповнюю форму з авторизацією...\n"
                                f"📋 {job_title}"
                            )
                        # Fall through to standard submission below
                    else:
                        await log(f"⚠️ Registration completed but credentials not found")
                        route_credentials = None
                else:
                    await log(f"❌ Registration failed or timed out for {domain}")
                    supabase.table("applications").update({
                        "status": "failed",
                        "skyvern_metadata": {"error_message": "Site registration failed or timed out", "failure_reason": "registration_failed"}
                    }).eq("id", app_id).execute()
                    if chat_id:
                        await send_tech_telegram(chat_id,
                            f"❌ <b>Реєстрація не завершилась</b>\n\n"
                            f"📋 {job_title}\n"
                            f"Спробуйте зареєструватись вручну на {domain}."
                        )
                    return False

        # Store route info for later use
        route_site_type = route_result.get('site_type', 'generic')
        route_credentials = route_result.get('credentials')
    else:
        route_site_type = 'finn' if is_finn_easy else 'generic'
        route_credentials = None

    # === CONFIRMATION FLOW ===
    # Get profile data first (needed for confirmation and form filling)
    # CRITICAL: Filter by user_id to ensure multi-user isolation
    profile_data = {}
    try:
        query = supabase.table("cv_profiles").select("*").eq("is_active", True)
        if user_id:
            query = query.eq("user_id", user_id)
        profile_res = query.limit(1).execute()
        if profile_res.data:
            profile_data = profile_res.data[0]
            # Log profile for verification
            profile_name = profile_data.get('structured_content', {}).get('personalInfo', {}).get('fullName', 'Unknown')
            await log(f"   👤 Profile: {profile_name} (user_id={user_id})")
    except Exception as e:
        await log(f"⚠️ Failed to fetch profile: {e}")

    # === VARIANT 4: HYBRID FLOW ===
    # Use hybrid flow for external forms (not FINN Easy) when:
    # - USE_HYBRID_FLOW is enabled
    # - Not a FINN Easy application
    # - Has external_apply_url or is external form
    # - chat_id is available (needed for Telegram interaction)
    # Hybrid Flow disabled — creates 2 Skyvern tasks (extraction + fill) which
    # overloads Docker on local PC. Standard flow uses 1 task with all data in payload.
    # All profile data (birth_year, languages, AI answers) already in navigation_payload.
    domain = extract_domain(external_apply_url or job_url) if (external_apply_url or job_url) else None
    skip_heavy_platforms = ['workday', 'successfactors']
    is_skip_hybrid_platform = detect_site_type(domain) in skip_heavy_platforms if domain else False
    use_hybrid = False  # Single-task flow is more reliable and resource-efficient

    confirmation_id = None  # Initialize before hybrid/standard branches

    if use_hybrid:
        await log("🔬 Using HYBRID FLOW (Variant 4)")

        # Prepare job data for hybrid flow
        hybrid_job_data = {
            'id': job_id,
            'title': job_title,
            'company': job_company,
            'job_url': job_url,
            'external_apply_url': external_apply_url,
            'application_form_type': application_form_type,
            'user_id': user_id  # For multi-user profile isolation
        }

        # Start hybrid flow
        hybrid_result = await process_application_hybrid(
            app_id=app_id,
            job_data=hybrid_job_data,
            app_data=app,
            chat_id=chat_id
        )

        if not hybrid_result.get('success'):
            # Hybrid flow failed - fall back to standard flow
            await log(f"⚠️ Hybrid flow failed: {hybrid_result.get('message')}")
            await log("⚠️ Falling back to standard confirmation flow...")
            # Continue with standard flow below
        else:
            # Hybrid flow started - wait for smart confirmation
            confirmation_id = hybrid_result.get('confirmation_id')
            await log(f"🔬 Hybrid confirmation sent: {confirmation_id}")

            # Wait for user confirmation (same as standard flow)
            confirmation_result = await wait_for_confirmation(confirmation_id)

            if confirmation_result == 'cancelled':
                await log(f"❌ User skipped application: {job_title}")
                # skipped = user decided not to apply, never retry this application
                supabase.table("applications").update({"status": "skipped"}).eq("id", app_id).execute()
                return False

            if confirmation_result == 'timeout':
                await log(f"⏰ Confirmation timeout: {job_title}")
                supabase.table("applications").update({"status": "draft"}).eq("id", app_id).execute()
                await send_telegram(chat_id,
                    f"⏰ <b>Час вичерпано</b>\n\n📋 {job_title}\nЗаявка повернута в чернетки.",
                    {"inline_keyboard": [
                        [{"text": "🔄 Повторити", "callback_data": f"retry_app_{app_id}"},
                         {"text": "❌ Відмінити", "callback_data": f"cancel_app_{app_id}"}]
                    ]}
                )
                return False

            # User confirmed with smart data!
            await log(f"✅ User confirmed (hybrid), proceeding with submission")

            # Get updated matched fields from confirmation
            try:
                conf_res = supabase.table("application_confirmations").select("payload").eq("id", confirmation_id).single().execute()
                if conf_res.data and conf_res.data.get('payload'):
                    payload = conf_res.data['payload']
                    matched_fields = payload.get('matched_fields', [])
                    await log(f"📋 Got {len(matched_fields)} fields from smart confirmation")

                    # Update profile_data with user-provided answers
                    for field in matched_fields:
                        if field.get('source') == 'user':
                            # Save to KB for future use
                            await save_field_to_kb(field['label'], field['value'], user_id)
            except Exception as e:
                await log(f"⚠️ Failed to get smart confirmation data: {e}")

            # Continue to form filling (will use updated KB data)

    # Standard confirmation flow (fallback or non-hybrid)
    if not use_hybrid:
        # Build form payload for confirmation
        form_payload = await build_form_payload(app, profile_data, user_id)

        # Send confirmation request if chat_id available and not skipping
        # Skip confirmation for heavy JS platforms (Workday, SuccessFactors) — go directly to Skyvern
        confirmation_id = None
        if chat_id and not skip_confirmation and not is_skip_hybrid_platform:
            apply_url = external_apply_url or job_url
            confirmation_id = await create_confirmation_request(
                app_id=app_id,
                job_id=job_id,
                job_title=job_title,
                company=job_company,
                external_url=apply_url,
                payload=form_payload,
                chat_id=chat_id
            )

            if confirmation_id:
                # Wait for user confirmation
                confirmation_result = await wait_for_confirmation(confirmation_id)

                if confirmation_result == 'cancelled':
                    await log(f"❌ User skipped application: {job_title}")
                    # skipped = user decided not to apply, never retry
                    supabase.table("applications").update({"status": "skipped"}).eq("id", app_id).execute()
                    await send_telegram(chat_id, f"⏭ <b>Заявку пропущено</b>\n\n📋 {job_title}\nБільше не буде пропонуватись.")
                    return False

                if confirmation_result == 'timeout':
                    await log(f"⏰ Confirmation timeout: {job_title}")
                    supabase.table("applications").update({"status": "draft"}).eq("id", app_id).execute()
                    await send_telegram(chat_id,
                        f"⏰ <b>Час вичерпано</b>\n\n📋 {job_title}\nЗаявка повернута в чернетки.",
                        {"inline_keyboard": [
                            [{"text": "🔄 Повторити", "callback_data": f"retry_app_{app_id}"},
                             {"text": "❌ Відмінити", "callback_data": f"cancel_app_{app_id}"}]
                        ]}
                    )
                    return False

                # User confirmed - proceed!
                await log(f"✅ User confirmed, proceeding with submission")
            else:
                await log(f"⚠️ Failed to create confirmation, proceeding without it")

    if is_finn_easy:
        # === FINN ENKEL SØKNAD FLOW ===
        await log(f"⚡ FINN Enkel Søknad detected: {job_title}")

        # Notify user via Telegram
        if chat_id:
            await send_telegram(chat_id,
                f"🚀 <b>Починаю подачу на FINN</b>\n\n"
                f"📋 {job_title}\n"
                f"⏳ Очікуйте код 2FA на пошту!\n\n"
                f"Коли отримаєте код, надішліть:\n"
                f"<code>/code XXXXXX</code>"
            )

        # PRE-CREATE finn_auth_requests record so webhook can find the user
        if chat_id and FINN_EMAIL:
            try:
                # Set expiration to 10 minutes from now
                from datetime import timedelta
                expires_at = (datetime.now() + timedelta(minutes=10)).isoformat()

                await log(f"📝 Pre-creating auth request for {FINN_EMAIL}")
                supabase.table("finn_auth_requests").insert({
                    "telegram_chat_id": chat_id,
                    "user_id": user_id,
                    "totp_identifier": FINN_EMAIL,
                    "status": "pending",
                    "expires_at": expires_at
                }).execute()
            except Exception as e:
                await log(f"⚠️ Failed to pre-create auth request: {e}")

        # Use finn_apply_url if available (for NAV→FINN redirects), otherwise job_url
        apply_url_to_use = finn_apply_url or job_url
        task_id = await trigger_finn_apply_task(apply_url_to_use, app, profile_data)

        if task_id:
            skyvern_meta = {
                "task_id": task_id,
                "finn_apply": True,
                "source": "worker",
                "started_at": datetime.now().isoformat()
            }

            supabase.table("applications").update({
                "status": "manual_review",
                "skyvern_metadata": skyvern_meta,
                "sent_at": datetime.now().isoformat()
            }).eq("id", app_id).execute()

            if chat_id:
                await send_telegram(chat_id,
                    f"✅ <b>Skyvern запущено!</b>\n\n"
                    f"🔑 Task: <code>{task_id}</code>\n"
                    f"🔗 <a href='http://localhost:8080/tasks/{task_id}'>Переглянути</a>\n\n"
                    f"⏳ Очікуйте код 2FA!"
                )

            final_status = await monitor_task_status(
                task_id, chat_id=chat_id, job_title=job_title, app_id=app_id,
                detailed_reporting=True, job_company=job_company, job_url=finn_apply_url or job_url,
                user_id=user_id, job_id=job_id
            )

            await log(f"💾 FINN task finished: {final_status}")

            # Handle user cancellation
            if final_status == 'cancelled':
                await log(f"🛑 Task cancelled by user")
                return False

            # Handle magic link detection
            if final_status == 'magic_link':
                supabase.table("applications").update({"status": "manual_review"}).eq("id", app_id).execute()
                return False

            supabase.table("applications").update({"status": final_status}).eq("id", app_id).execute()

            # Save form memory (FINN flow)
            try:
                mem_outcome = 'success' if final_status == 'sent' else 'failure'
                mem_reason = None if final_status == 'sent' else final_status
                memory = await extract_memory_from_task(
                    task_id, 'finn.no', mem_outcome, mem_reason, app_id,
                    finn_apply_url or job_url, 35)
                if memory:
                    await save_form_memory_with_skill(memory, task_id)
            except Exception as e:
                await log(f"⚠️ Memory save error (FINN): {e}")

            # Update confirmation status if exists
            if confirmation_id and final_status == 'sent':
                await update_confirmation_submitted(confirmation_id)

            if chat_id and final_status == 'sent':
                await send_telegram(chat_id, f"✅ <b>Заявку відправлено!</b>\n\n📋 {job_title}")
            return final_status == 'sent'
        else:
            await log("💾 FINN task failed to start")
            supabase.table("applications").update({
                "status": "failed",
                "skyvern_metadata": {"error_message": "Skyvern FINN task failed to start after retries. Check if Skyvern is running.", "failure_reason": "skyvern_start_failed"}
            }).eq("id", app_id).execute()
            if chat_id:
                await send_tech_telegram(chat_id, f"❌ <b>Помилка запуску FINN</b>\n\n📋 {job_title}")
            return False

    else:
        # === STANDARD FORM FLOW (with credentials check) ===
        await log(f"📄 Processing standard form: {job_title}")

        # Determine which URL to use - MUST have external_apply_url for non-FINN jobs
        # Never send LinkedIn/NAV job page URLs to Skyvern - they don't have application forms
        apply_url = external_apply_url
        if not apply_url:
            job_domain = job_url.lower() if job_url else ""
            if 'linkedin.com' in job_domain:
                # Try to extract external apply URL via Skyvern (login + click Apply)
                linkedin_email = os.getenv("LINKEDIN_EMAIL", "")
                linkedin_password = os.getenv("LINKEDIN_PASSWORD", "")
                if linkedin_email and linkedin_password:
                    await log(f"🔗 LinkedIn job without external URL — extracting via Skyvern login...")
                    extracted_url = await extract_linkedin_apply_url(job_url, linkedin_email, linkedin_password)
                    if extracted_url:
                        await log(f"✅ Extracted external URL: {extracted_url[:80]}")
                        # Save to DB for future use
                        supabase.table("jobs").update({"external_apply_url": extracted_url}).eq("id", job_id).execute()
                        apply_url = extracted_url
                    else:
                        await log(f"⚠️ Could not extract external URL from LinkedIn — may be Easy Apply only")
                        supabase.table("applications").update({"status": "manual_review"}).eq("id", app_id).execute()
                        if chat_id:
                            await send_telegram(str(chat_id),
                                f"⚠️ <b>LinkedIn Easy Apply</b>\n\n"
                                f"📋 {job_title}\n\n"
                                f"Не вдалось витягнути зовнішню форму. Можливо тільки Easy Apply.\n"
                                f"Подайте заявку вручну через LinkedIn."
                            )
                        return False
                else:
                    await log(f"⚠️ No LinkedIn credentials — cannot extract external URL")
                    supabase.table("applications").update({"status": "manual_review"}).eq("id", app_id).execute()
                    return False
            elif any(d in job_domain for d in ['nav.no', 'arbeidsplassen.nav.no']):
                # NAV is an aggregator — the real form is always on an external site
                # Try to extract the external URL via extract_job_text edge function
                await log(f"🔗 NAV job without external URL — extracting via extract_job_text...")
                try:
                    supabase_url = os.getenv("SUPABASE_URL")
                    supabase_key = os.getenv("SUPABASE_SERVICE_KEY")
                    async with httpx.AsyncClient() as extract_client:
                        extract_resp = await extract_client.post(
                            f"{supabase_url}/functions/v1/extract_job_text",
                            json={"job_id": job_id, "url": job_url},
                            headers={
                                "Authorization": f"Bearer {supabase_key}",
                                "Content-Type": "application/json"
                            },
                            timeout=30.0
                        )
                        if extract_resp.status_code == 200:
                            extract_data = extract_resp.json()
                            nav_external_url = extract_data.get("external_apply_url")
                            if nav_external_url:
                                await log(f"✅ Extracted NAV external URL: {nav_external_url[:80]}")
                                supabase.table("jobs").update({
                                    "external_apply_url": nav_external_url,
                                    "application_form_type": extract_data.get("application_form_type", "external_form")
                                }).eq("id", job_id).execute()
                                apply_url = nav_external_url
                            else:
                                await log(f"⚠️ extract_job_text returned no external URL for NAV job")
                except Exception as e:
                    await log(f"⚠️ Error extracting NAV URL: {e}")

                if not apply_url:
                    await log(f"⚠️ NAV job without external URL — manual review")
                    supabase.table("applications").update({"status": "manual_review"}).eq("id", app_id).execute()
                    return False
            else:
                # For FINN or other sources, job_url might be the form itself
                apply_url = job_url

        # Check if we have credentials for this site
        has_creds, credentials, domain = await check_credentials_for_url(apply_url, user_id)

        # Check if site uses magic link authentication
        if credentials and credentials.get('auth_type') == 'magic_link':
            await log(f"🔗 Site {domain} uses magic link authentication - skipping")
            if chat_id:
                await send_telegram(str(chat_id),
                    f"🔗 <b>Magic Link сайт!</b>\n\n"
                    f"📋 {job_title}\n\n"
                    f"⚠️ Сайт <b>{domain}</b> використовує Magic Link.\n"
                    f"Автоматична подача неможлива.\n\n"
                    f"Подайте заявку вручну через сайт."
                )
            supabase.table("applications").update({"status": "manual_review"}).eq("id", app_id).execute()
            return False

        if has_creds:
            await log(f"🔐 Using saved credentials for {domain}")
            if chat_id:
                await send_tech_telegram(chat_id,
                    f"🔐 <b>Знайдено збережений логін для {domain}</b>\n\n"
                    f"📋 {job_title}\n"
                    f"⏳ Заповнюю форму з авторизацією..."
                )
        else:
            await log(f"⚠️ No credentials for {domain}")

            # Check if this is an external_registration type that needs account
            if application_form_type == 'external_registration':
                await log(f"📝 Site requires registration/login for {domain}")

                # Credentials are already checked above by check_credentials_for_url()
                # If we're here, no credentials were found — skip the question, go straight to registration

                # If still no credentials after Q&A — trigger registration
                if not has_creds and application_form_type == 'external_registration':
                    await log(f"📝 Triggering registration flow for {domain}")

                    if chat_id:
                        await send_tech_telegram(chat_id,
                            f"🔐 <b>Реєстрація на {domain}</b>\n\n"
                            f"📋 {job_title}\n"
                            f"⏳ Запускаю процес реєстрації..."
                        )

                    # Trigger registration flow (with user_id for multi-user profile isolation)
                    flow_id = await trigger_registration(
                        domain=domain,
                        registration_url=apply_url,
                        job_id=job_id,
                        application_id=app_id,
                        user_id=user_id
                    )

                    if flow_id:
                        # Update application to wait for registration
                        supabase.table("applications").update({
                            "status": "manual_review",
                            "skyvern_metadata": {
                                "registration_flow_id": flow_id,
                                "waiting_for_registration": True,
                                "domain": domain
                            }
                        }).eq("id", app_id).execute()

                        await log(f"⏳ Waiting for registration to complete: {flow_id}")

                        # Wait for registration to complete (poll every 10 seconds, max 30 min)
                        registration_completed = await wait_for_registration_completion(flow_id, chat_id, max_wait_seconds=1800)

                        if registration_completed:
                            await log(f"✅ Registration completed! Continuing with application...")
                            # Fetch newly created credentials
                            credentials = await get_site_credentials(domain, user_id)
                            if credentials:
                                has_creds = True
                                await log(f"🔐 Got new credentials for {domain}")
                                if chat_id:
                                    await send_tech_telegram(chat_id,
                                        f"✅ <b>Реєстрація завершена!</b>\n\n"
                                        f"🔐 Тепер заповнюю форму з авторизацією...\n"
                                        f"📋 {job_title}"
                                    )
                            else:
                                await log(f"⚠️ Registration completed but credentials not found")
                                has_creds = False
                        else:
                            await log(f"❌ Registration failed or timed out")
                            supabase.table("applications").update({
                                "status": "failed",
                                "skyvern_metadata": {"error_message": "Site registration failed or timed out", "failure_reason": "registration_failed"}
                            }).eq("id", app_id).execute()
                            if chat_id:
                                await send_tech_telegram(chat_id,
                                    f"❌ <b>Реєстрація не завершилась</b>\n\n"
                                    f"📋 {job_title}\n"
                                    f"Спробуйте зареєструватись вручну."
                                )
                            return False
                else:
                    await log(f"❌ Failed to start registration flow")
                    supabase.table("applications").update({
                        "status": "failed",
                        "skyvern_metadata": {"error_message": "Failed to start registration flow", "failure_reason": "registration_start_failed"}
                    }).eq("id", app_id).execute()
                    return False

        # Proceed with form filling
        kb_data = await get_knowledge_base_dict(user_id)
        profile_text = await get_active_profile(user_id)
        resume_url = await get_latest_resume_url(user_id)

        task_id = await trigger_skyvern_task_with_credentials(
            apply_url, app, kb_data, profile_text, resume_url, credentials, user_id
        )

        if task_id:
            skyvern_meta = {
                "task_id": task_id,
                "resume_url": resume_url,
                "started_at": datetime.now().isoformat(),
                "with_credentials": has_creds,
                "domain": domain
            }

            supabase.table("applications").update({
                "status": "manual_review",
                "skyvern_metadata": skyvern_meta,
                "sent_at": datetime.now().isoformat()
            }).eq("id", app_id).execute()

            if chat_id:
                await send_tech_telegram(chat_id,
                    f"🚀 <b>Skyvern запущено!</b>\n\n"
                    f"📋 {job_title}\n"
                    f"🔑 Task: <code>{task_id}</code>\n"
                    f"{'🔐 З авторизацією' if has_creds else '📝 Без авторизації'}"
                )

            final_status = await monitor_task_status(
                task_id, chat_id=chat_id, job_title=job_title, app_id=app_id,
                detailed_reporting=True, job_company=job_company, job_url=apply_url,
                user_id=user_id, job_id=job_id
            )

            await log(f"💾 Updating DB status to: {final_status}")

            # Handle user cancellation
            if final_status == 'cancelled':
                await log(f"🛑 Task cancelled by user")
                return False

            # Handle magic link detection
            if final_status == 'magic_link':
                await log(f"🔗 Marking {domain} as magic_link site")
                await mark_site_as_magic_link(domain)
                supabase.table("applications").update({"status": "manual_review"}).eq("id", app_id).execute()
                return False

            # Handle login failed with password recovery
            if final_status == 'retry':
                await log(f"🔄 Retrying application after password update")
                supabase.table("applications").update({
                    "status": "sending", "updated_at": datetime.now(timezone.utc).isoformat()
                }).eq("id", app_id).execute()
                return False  # Will be picked up in next poll cycle

            supabase.table("applications").update({
                "status": final_status
            }).eq("id", app_id).execute()

            # Save form memory (standard flow)
            try:
                mem_outcome = 'success' if final_status == 'sent' else 'failure'
                mem_reason = None if final_status == 'sent' else final_status
                memory = await extract_memory_from_task(
                    task_id, domain, mem_outcome, mem_reason, app_id,
                    apply_url, 40 if has_creds else 30)
                if memory:
                    await save_form_memory_with_skill(memory, task_id)
            except Exception as e:
                await log(f"⚠️ Memory save error (standard): {e}")

            # Update confirmation status if exists
            if confirmation_id and final_status == 'sent':
                await update_confirmation_submitted(confirmation_id)

            if chat_id and final_status == 'sent':
                await send_telegram(str(chat_id), f"✅ <b>Заявку відправлено!</b>\n\n📋 {job_title}")

            return final_status == 'sent'

        else:
            await log("💾 Updating DB status to: failed")
            supabase.table("applications").update({
                "status": "failed",
                "skyvern_metadata": {"error_message": "Skyvern task failed to start after retries. Check if Skyvern is running.", "failure_reason": "skyvern_start_failed"}
            }).eq("id", app_id).execute()

            if chat_id:
                await send_tech_telegram(chat_id, f"❌ <b>Помилка запуску Skyvern</b>\n\n📋 {job_title}")

            return False

async def classify_applications(applications: list) -> tuple:
    """Classify applications into FINN Enkel Søknad and others.

    Returns: (finn_apps, other_apps)
    """
    finn_apps = []
    other_apps = []

    for app in applications:
        job_id = app['job_id']
        try:
            job_res = supabase.table("jobs").select(
                "job_url, external_apply_url, has_enkel_soknad, application_form_type"
            ).eq("id", job_id).single().execute()

            if job_res.data:
                job_url = job_res.data.get('job_url', '')
                external_apply_url = job_res.data.get('external_apply_url', '')
                has_enkel_soknad = job_res.data.get('has_enkel_soknad', False)
                form_type = job_res.data.get('application_form_type', '')

                # Check if FINN Enkel Søknad - 3 cases:
                # 1. Direct FINN job with finn_easy markers
                # 2. NAV/other job with FINN external_apply_url
                # 3. Has finn_easy markers with FINN in external_apply_url
                is_finn = False

                if job_url and 'finn.no' in job_url and (has_enkel_soknad or form_type == 'finn_easy'):
                    is_finn = True
                elif external_apply_url and 'finn.no/job/apply' in external_apply_url:
                    is_finn = True
                elif (has_enkel_soknad or form_type == 'finn_easy') and external_apply_url and 'finn.no' in external_apply_url:
                    is_finn = True

                if is_finn:
                    finn_apps.append(app)
                else:
                    other_apps.append(app)
            else:
                other_apps.append(app)
        except Exception:
            other_apps.append(app)

    return finn_apps, other_apps


def group_applications_by_user(applications: list) -> dict:
    """Group applications by user_id for parallel per-user processing."""
    groups: Dict[str, list] = {}
    for app in applications:
        uid = app.get("user_id", "unknown")
        if uid not in groups:
            groups[uid] = []
        groups[uid].append(app)
    return groups


async def process_user_applications(user_id: str, apps: list, semaphore: asyncio.Semaphore) -> int:
    """Process all applications for a single user sequentially, under a concurrency semaphore."""
    tag = f"[{user_id[:8]}]"
    processed = 0

    async with semaphore:
        await log(f"{tag} 🔄 Processing {len(apps)} app(s)")
        try:
            finn_apps, other_apps = await classify_applications(apps)

            if finn_apps:
                await log(f"{tag}    🔵 FINN Enkel Søknad: {len(finn_apps)}")
            if other_apps:
                await log(f"{tag}    ⚪ Other platforms: {len(other_apps)}")

            # Block FINN applications if credentials not configured
            if finn_apps and not FINN_CREDENTIALS_OK:
                await log(f"{tag} ❌ FINN credentials not configured - failing {len(finn_apps)} FINN app(s)")
                for app in finn_apps:
                    try:
                        supabase.table("applications").update({
                            "status": "failed",
                            "skyvern_metadata": {
                                "error_message": "FINN credentials (FINN_EMAIL/FINN_PASSWORD) not configured in worker .env",
                                "failure_reason": "finn_credentials_missing"
                            }
                        }).eq("id", app["id"]).execute()
                        clear_claim(app["id"])
                    except Exception as e:
                        await log(f"{tag} ⚠️ Failed to mark app {app['id'][:8]} as failed: {e}")
                finn_apps = []

            # Process FINN apps sequentially (one at a time, queue)
            for i, app in enumerate(finn_apps):
                try:
                    if len(finn_apps) > 1:
                        await log(f"{tag} 📋 FINN {i+1}/{len(finn_apps)} (черга: {len(finn_apps)-i-1} залишилось)")
                    await process_application(app)
                    processed += 1
                except Exception as e:
                    await log(f"{tag} ⚠️ FINN app {app['id'][:8]} failed: {e}")
                    try:
                        supabase.table("applications").update({
                            "status": "failed",
                            "skyvern_metadata": {"error_message": str(e), "failure_reason": "processing_exception"}
                        }).eq("id", app["id"]).execute()
                    except Exception:
                        pass
                finally:
                    clear_claim(app["id"])

            # Process other apps sequentially (one at a time, queue)
            for i, app in enumerate(other_apps):
                try:
                    if len(other_apps) > 1:
                        await log(f"{tag} 📋 Заявка {i+1}/{len(other_apps)} (черга: {len(other_apps)-i-1} залишилось)")
                    await process_application(app)
                    processed += 1
                except Exception as e:
                    await log(f"{tag} ⚠️ App {app['id'][:8]} failed: {e}")
                    try:
                        supabase.table("applications").update({
                            "status": "failed",
                            "skyvern_metadata": {"error_message": str(e), "failure_reason": "processing_exception"}
                        }).eq("id", app["id"]).execute()
                    except Exception:
                        pass
                finally:
                    clear_claim(app["id"])

        except Exception as e:
            await log(f"{tag} ⚠️ User processing error: {e}")

    return processed


async def process_finn_applications(applications: list):
    """Process FINN applications one by one."""
    if not applications:
        return

    count = len(applications)
    await log(f"🚀 Processing {count} FINN application(s)")

    for i, app in enumerate(applications):
        if count > 1:
            await log(f"📋 Application {i+1}/{count}")
        await process_application(app)


async def print_startup_summary():
    """Print startup summary with job statistics and next steps."""
    try:
        users_res = supabase.table("user_settings").select("user_id, telegram_chat_id").execute()
        users = users_res.data or []

        sending_res = supabase.table("applications").select("id", count="exact").eq("status", "sending").execute()
        approved_res = supabase.table("applications").select("id", count="exact").eq("status", "approved").execute()
        sending_count = sending_res.count or 0
        approved_count = approved_res.count or 0

        await log("=" * 60)
        await log("              ✅ СИСТЕМА ГОТОВА ДО РОБОТИ")
        await log("=" * 60)

        for u in users:
            uid = u["user_id"]
            # Get username
            try:
                email_res = supabase.rpc("get_user_email", {"uid": uid}).execute()
                email = (email_res.data or {}).get("email", uid[:8])
                username = email.split("@")[0] if "@" in str(email) else str(email)[:8]
            except Exception:
                username = uid[:8]

            # Hot jobs (relevance >= 50)
            hot_res = supabase.table("jobs").select("id", count="exact") \
                .eq("user_id", uid).gte("relevance_score", 50).execute()
            hot_count = hot_res.count or 0

            # Today's FINN Easy without sent/sending apps
            today_start = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0).isoformat()
            finn_res = supabase.table("jobs").select("id") \
                .eq("user_id", uid).eq("has_enkel_soknad", True) \
                .gte("relevance_score", 50).gte("created_at", today_start).execute()
            finn_ids = [j["id"] for j in (finn_res.data or [])]

            ready_finn = 0
            if finn_ids:
                sent_res = supabase.table("applications").select("job_id") \
                    .eq("user_id", uid).in_("status", ["sent", "sending"]) \
                    .in_("job_id", finn_ids).execute()
                sent_job_ids = {a["job_id"] for a in (sent_res.data or [])}
                ready_finn = len([fid for fid in finn_ids if fid not in sent_job_ids])

            await log(f"👤 {username}")
            await log(f"   🎯 Релевантних (≥50%): {hot_count}")
            await log(f"   ⚡ FINN Easy сьогодні: {ready_finn}")

        await log("")
        await log(f"📊 ЧЕРГА: 📨 Sending: {sending_count} | ✅ Approved: {approved_count}")
        await log("")
        await log("💡 НАСТУПНІ КРОКИ:")
        await log("   Telegram: /apply — переглянути FINN Easy вакансії")
        await log("   Telegram: /apply all — масова подача")
        await log("   Dashboard: кнопка 'FINN Søknad' для окремих вакансій")
        await log("=" * 60)

    except Exception as e:
        await log(f"⚠️ Could not print startup summary: {e}")


async def cleanup_stale_skyvern_tasks():
    """Cancel old running Skyvern runs and clean up finished ones.

    Prevents queue blockage and browser instance accumulation that
    causes Skyvern Docker to run out of resources (CPU/RAM).

    The new Task Run API has no list-all-runs endpoint, so instead of asking
    Skyvern to enumerate its tasks, we check the run_ids we ourselves stored
    in applications.skyvern_metadata for any application still marked
    'sending' or 'manual_review', one by one via GET /v1/runs/{run_id}.
    """
    try:
        headers = skyvern_headers()

        rows = supabase.table("applications") \
            .select("id, skyvern_metadata") \
            .in_("status", ["sending", "manual_review"]) \
            .execute()

        run_ids = []
        for row in (rows.data or []):
            meta = row.get("skyvern_metadata") or {}
            rid = meta.get("task_id")
            if rid:
                run_ids.append(rid)

        if not run_ids:
            return

        now = datetime.now(timezone.utc)
        stale_count = 0
        running_count = 0

        async with httpx.AsyncClient() as client:
            for rid in run_ids:
                try:
                    resp = await client.get(
                        f"{SKYVERN_URL}/v1/runs/{rid}",
                        headers=headers, timeout=10.0
                    )
                    if resp.status_code != 200:
                        continue

                    run = resp.json()
                    status = run.get('status', '')
                    created = run.get('created_at', '')
                    if not created:
                        continue

                    if status == 'running':
                        running_count += 1

                    task_time = datetime.fromisoformat(created.replace('Z', '+00:00'))
                    age_minutes = (now - task_time).total_seconds() / 60

                    # Cancel running tasks older than 30 min
                    if status == 'running' and age_minutes > 30:
                        await client.post(
                            f"{SKYVERN_URL}/v1/runs/{rid}/cancel",
                            headers=headers, timeout=10.0
                        )
                        stale_count += 1
                except Exception:
                    continue

        if stale_count > 0:
            await log(f"🧹 Cleaned up {stale_count} stale Skyvern tasks (>30min old)")
        elif running_count > 0:
            await log(f"📋 Skyvern: {running_count} running task(s), all fresh")
    except Exception as e:
        await log(f"⚠️ Skyvern task cleanup error: {e}")


async def main():
    await log("🌉 Skyvern Bridge started")

    # Startup health check (non-blocking - just a warning)
    skyvern_ok = await check_skyvern_health()
    if skyvern_ok:
        await log("✅ Skyvern is accessible")
    else:
        await log("⚠️ Skyvern is NOT accessible at " + SKYVERN_URL)
        await log("   Worker will continue (needed for cleanup), but task submissions will fail")

    # Release stale claims from previous crash of THIS worker
    try:
        supabase.table("applications").update({
            "worker_id": None, "claimed_at": None
        }).eq("worker_id", WORKER_ID).eq("status", "sending").execute()
    except Exception:
        pass

    # Write startup heartbeat
    try:
        supabase.table("worker_heartbeat").upsert({
            "id": WORKER_ID,
            "last_heartbeat": datetime.now(timezone.utc).isoformat(),
            "skyvern_healthy": skyvern_ok,
            "poll_cycle": 0,
            "applications_processed": 0,
            "started_at": datetime.now(timezone.utc).isoformat(),
            "hostname": socket.gethostname(),
            "location": WORKER_LOCATION
        }).execute()
        await log(f"💓 Heartbeat: startup recorded (worker_id={WORKER_ID}, location={WORKER_LOCATION})")
    except Exception as e:
        await log(f"⚠️ Heartbeat write failed: {e}")

    # Cleanup stuck applications on startup
    await cleanup_stuck_applications()

    # Cleanup stale Skyvern tasks (from previous worker sessions)
    await cleanup_stale_skyvern_tasks()

    await log(f"📡 Polling every {POLL_INTERVAL} seconds for new applications...")
    await log(f"🔀 Parallel: up to {MAX_CONCURRENT_USERS} users concurrently")

    await print_startup_summary()

    poll_cycle = 0
    total_processed = 0
    while True:
        try:
            # Periodic cleanup of stuck applications
            poll_cycle += 1
            if poll_cycle % CLEANUP_EVERY_N_CYCLES == 0:
                await cleanup_stuck_applications()

            # Atomically claim applications (optimistic locking — prevents duplicate processing)
            response = supabase.rpc("claim_applications", {
                "p_worker_id": WORKER_ID,
                "p_limit": 10
            }).execute()

            if response.data:
                count = len(response.data)
                user_groups = group_applications_by_user(response.data)
                user_count = len(user_groups)
                parallel_note = " — parallel" if user_count > 1 else ""
                await log(f"📬 Claimed {count} app(s) as '{WORKER_ID}' ({user_count} user(s){parallel_note})")

                semaphore = asyncio.Semaphore(MAX_CONCURRENT_USERS)
                tasks = [
                    asyncio.create_task(process_user_applications(uid, apps, semaphore))
                    for uid, apps in user_groups.items()
                ]
                results = await asyncio.gather(*tasks, return_exceptions=True)

                for i, result in enumerate(results):
                    if isinstance(result, Exception):
                        await log(f"⚠️ User processing exception: {result}")
                    elif isinstance(result, int):
                        total_processed += result

        except Exception as e:
            await log(f"⚠️ Error: {e}")

        # Periodic Skyvern health check + HF keepalive (every ~5 min)
        # HF Spaces sleeps after 15 min inactivity, so ping every 5 min
        if poll_cycle % 30 == 0:
            skyvern_ok = await check_skyvern_health()

        # Periodic Skyvern task cleanup (every ~10 min = 60 cycles * 10s)
        if poll_cycle % 60 == 30:
            await cleanup_stale_skyvern_tasks()

        # LinkedIn scanning (once per day, from local machine — Edge Functions blocked by LinkedIn)
        # 8640 cycles * 10s = 24 hours
        if poll_cycle % 8640 == 360:  # offset to not conflict with other tasks
            try:
                from linkedin_scraper import scan_all_users
                await log("🟣 Running LinkedIn scan from local worker...")
                await scan_all_users()
            except Exception as e:
                await log(f"⚠️ LinkedIn scan error: {e}")

        # Write heartbeat
        try:
            supabase.table("worker_heartbeat").upsert({
                "id": WORKER_ID,
                "last_heartbeat": datetime.now(timezone.utc).isoformat(),
                "skyvern_healthy": skyvern_ok,
                "poll_cycle": poll_cycle,
                "applications_processed": total_processed,
                "hostname": socket.gethostname(),
                "location": WORKER_LOCATION
            }).execute()
        except Exception:
            pass  # Non-critical

        await asyncio.sleep(POLL_INTERVAL)


if __name__ == "__main__":
    asyncio.run(main())

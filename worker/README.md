# JobBot Worker

> ## ⚠️ Skyvern is decommissioned (2026-07-20, commit `1235c80`)
>
> **This worker no longer fills or submits any application form — FINN or external.**
> All submission is owned by the agent-driven Playwright pipeline; see
> `skills/form-filling/SKILL.md` and `skills/application-pipeline/SKILL.md` in the repo
> root, which are the source of truth for how applications are actually processed.
>
> Everything this README used to describe (Skyvern Docker, `SKYVERN_API_KEY`,
> `auto_apply.py` as the form filler, `extract_apply_url.py` as "Stage 1") is **history**.
> Do not start Skyvern, do not set its env vars, and do not treat the code below the
> decommission guard as live logic.

Python support scripts for JobBot Norway: job analysis, LinkedIn scanning, and DB admin.

---

## Live scripts

### `analyze_worker.py` — job analysis (primary consumer of this directory)

Scores scanned jobs against the user's CV profile via **Groq**
(`openai/gpt-oss-120b` → `openai/gpt-oss-20b` → `llama-3.1-8b-instant`), classifies the
`track` (`nav_quota` / `career`), applies the career seniority + language gates, sends
Telegram job cards, and produces the evening digest. Normally runs from GitHub Actions
(`.github/workflows/analyze-jobs.yml`, every 6h + dispatch).

```bash
python analyze_worker.py
python analyze_worker.py --reanalyze-career-days 3   # re-score recent career jobs in place
python analyze_worker.py --user <user_id>
```

### `linkedin_daemon.py` — LinkedIn scan

Standalone LinkedIn scanner (uses `linkedin_scraper.py`). Runs once, e.g. after PC startup;
notifies on start/finish via Telegram. Jobs it inserts are picked up by the `analyze-jobs`
cron safety net rather than by `scheduled-scanner`.

```bash
python linkedin_daemon.py              # scan now
python linkedin_daemon.py --delay 30   # wait 30 min, then scan
```

**LinkedIn policy:** never log into LinkedIn automatically and never use a stored session
cookie for automated requests — permanent rule (account-ban risk). For `linkedin_easy_apply`
jobs the correct path is the ATS-resolver cascade in `skills/form-filling` → "LinkedIn
branch", not a login.

### `db_admin.py` — direct SQL helper

Ad-hoc queries/migrations against the self-hosted Supabase (`db-jobbot.vitalii.no`).

---

## Legacy / dead — do not treat as live

| File | Status |
|---|---|
| `auto_apply.py` | **Dead.** `process_application()` has an early-return guard (~line 4943) routing every row back to `status='sending', submission_method='agent'`. Everything below it — the Skyvern task builder, LinkedIn/NAV URL extraction, navigation goals, `save_form_memory_with_skill` — is unreachable. `claim_applications()` also excludes `submission_method='agent'` rows (migration `20260719132000_agent_pipeline_claim_exclusion.sql`). Retained only as a second line of defense for stray pre-existing rows. |
| `extract_apply_url.py` | **Dead.** Skyvern "Stage 1" URL-extraction daemon. |
| `navigation_goals.py` | **Dead.** Site-specific Skyvern prompt text. The "look for Karriere/Ledige stillinger links" instructions here are *prompt strings for Skyvern*, not an implemented search step. |
| `register_site.py` | **Legacy**, Skyvern-era site registration. Not extended. |
| `auto_apply (2).py`, `worker.log`, `linkedin_scan.bat`, `forms/`, `supabase/` | Leftovers from the Skyvern era. |

**If you are auditing this codebase for a missing feature:** conclusions drawn from these
files are unreliable — the current pipeline's logic lives in `skills/*/SKILL.md`, not in
Python. Check there first.

---

## Setup

```bash
cd worker
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env
```

`.env` — required:

```env
SUPABASE_URL=https://db-jobbot.vitalii.no
SUPABASE_SERVICE_KEY=your-service-role-key
GROQ_API_KEY=your-groq-key
TELEGRAM_BOT_TOKEN=main-bot-token          # user-facing @soknad_bot
TELEGRAM_TECH_BOT_TOKEN=tech-bot-token     # ops @vitalljobtechbot
```

Obsolete — do **not** set: `SKYVERN_API_URL`, `SKYVERN_API_KEY`, `FINN_EMAIL`,
`FINN_PASSWORD`, `LINKEDIN_EMAIL`, `LINKEDIN_PASSWORD`.

**Bot separation:** if `TELEGRAM_TECH_BOT_TOKEN` is unset, ops notifications must be
*skipped*, never sent through the main user-facing bot.

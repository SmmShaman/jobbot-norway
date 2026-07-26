# CLAUDE.md - JobBot Norway

> **Convention — keep this file current.** This file is the source of truth for how JobBot
> actually works. When a change makes a section here wrong, fix that section **in the same
> commit**. Triggers that REQUIRE an edit here: hosting/data-store/LLM-provider changes;
> new/removed Edge Functions or workflows; changes to who submits applications (agent vs.
> worker); changes to tracks/statuses/thresholds; deploy commands or project refs.
>
> **Behavioral rules live in `skills/`, not here.** This file describes the *system*; the
> `skills/*/SKILL.md` files describe *what the agent must do* (pipeline policy, form
> filling, letter writing) and are the binding source of truth for that. Do not duplicate
> skill content here — link to it.

## Project Overview

**JobBot Norway** is a job-search automation platform for the Norwegian market. It scrapes
FINN.no, NAV.no and LinkedIn, scores each job against the user's CV profile with an LLM,
writes Norwegian cover letters, and submits application forms.

**Submission is agent-driven.** Since 2026-07-20 (commit `1235c80`) the Claude agent itself
drives a local headless Chromium via Playwright and fills/submits the forms. **Skyvern is
fully decommissioned** — see "Legacy / dead code" below before touching anything in
`worker/`.

---

## Infrastructure

| Component | Platform | Details |
|-----------|----------|---------|
| Frontend | Netlify (job.vitalii.no) | Auto-deploy from GitHub `main`; manual: `npm run build && npx netlify deploy --prod --dir=dist` |
| Backend | **Self-hosted Supabase — `https://db-jobbot.vitalii.no`** | PostgreSQL, Auth, 15 Edge Functions. Set in `services/supabase.ts` and the scan workflow |
| Form submission | **The agent itself** (Playwright, headless Chromium in the agent's own container) | No separate service. See `skills/form-filling` |
| Support worker | Oracle VM (`129.151.219.55`) + local PC | Runs `analyze_worker.py` / `linkedin_daemon.py` only — **not** form filling |
| CI/CD | GitHub Actions | 4 workflows, see below |
| Monitoring | Telegram `@vitalljobtechbot` (tech bot) | `tech-bot` Edge Function |

⚠️ **Known drift:** `.github/workflows/deploy-supabase-functions.yml` still deploys with
`--project-ref ptrmidlhfdbybxmyovtm` (the old hosted Supabase project), while the frontend,
scan workflow and `db_admin.py` were repointed to self-hosted `db-jobbot.vitalii.no`
(commits `2a4e2aa`, `f1c8fe4`, `4545e12`). Verify which target is live before relying on
that workflow; the same stale ref also appears in `docs/byterover-context/`,
`.claude/rules/`, `INSTRUCTIONS_EDGE_FUNCTION.md` and the root `*.cjs` debug scripts.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, TypeScript 5.8, Vite 6, react-router-dom 7, Tailwind (CDN), Lucide icons |
| Backend | Supabase self-hosted (PostgreSQL, Auth, Deno Edge Functions) |
| Job analysis | **Groq** — `openai/gpt-oss-120b` → fallback `openai/gpt-oss-20b` → last resort `llama-3.1-8b-instant` (`reasoning_effort: low`), in `worker/analyze_worker.py` and the `job-analyzer` Edge Function |
| Cover letters | **No LLM API** — written by the Jobbot agent itself (`skills/soknad-writing`); `generate_application` only creates the row and a poller fills `cover_letter_no/uk` |
| Form automation | Playwright (`playwright-core@1.61.1` pinned to chromium build `1228`), driven by the agent |
| Bot | Telegram Bot API — main bot `@soknad_bot` (user-facing) + tech bot `@vitalljobtechbot` (ops) |
| Charts / export | Recharts, jsPDF, xlsx |

---

## Skills = the operational source of truth

The pipeline's *behavior* is documented as skills, not as Python code. Read these before
changing anything about how applications are handled:

| Skill | Covers |
|---|---|
| `skills/application-pipeline/SKILL.md` | Which jobs get a letter, tracks & `track_policies`, statuses, `/automode`, employer blacklist, score thresholds, confirmation UX, the two bots |
| `skills/form-filling/SKILL.md` | The 8-phase Playwright recon→fill→confirm→submit flow, agent-wake contract, LinkedIn branch (ATS-resolver cascade), `sites/<domain>.json` profiles, `assets/*.mjs` helpers |
| `skills/soknad-writing/SKILL.md` | How a Norwegian cover letter is written, letter styles per track |

**Sync rule:** the repo copies are authoritative; `~/.claude/skills/<name>/` is a copy kept
so the skill auto-loads. After editing here, re-copy to `~/.claude/skills/`. Never edit the
`~/.claude` copy directly.

---

## Core Workflows

### 1. Scan & Analyze
```
Cron / Telegram /scan -> scheduled-scanner (Edge Function)
  -> job-scraper (FINN/NAV per user's search URLs)   |  linkedin_daemon.py (LinkedIn)
  -> extract_job_text (details, deadline, form type, Enkel Soknad detection)
  -> analyze_worker.py (Groq scoring + track classification + gates)
  -> Telegram card if score >= user_settings.card_notify_min_score (default 40)
```

### 2. Application (single-button flow, since 2026-07-20)
```
Job card -> "✅ Підтвердити" (confirm_job_<jobId>)
  -> generate_application inserts the row with status='pending_manual',
     submission_method='agent'  (no LLM call)
  -> agent writes the Søknad (skills/soknad-writing), sends it as an FYI notice,
     advances the row to status='sending'
  -> agent-wake trigger fires (see below) -> Playwright fill -> confirm -> submit -> 'sent'
```
There is no manual approve gate in the normal path. `draft`/`approved` and the
`approve_app_`/`queue_agent_`/`retry_app_` handlers still exist as a **dormant
manual-recovery path** for stuck rows only.

### 3. Agent-wake contract
The agent picks up any `applications` row where
**`status = 'sending' AND submission_method = 'agent'`**, oldest first, strictly one at a
time. A `schedule_task` poller checks for matching rows. Every queuing path sets both
fields together: `generate_application/index.ts` (primary), `queueForAgentPipeline()` in
`telegram-bot/index.ts` (dormant recovery), `finn-apply/index.ts` (FINN dashboard button).
Full detail: `skills/form-filling` → "Agent-wake contract".

### 4. LinkedIn — never auto-login
`linkedin_easy_apply` jobs must **never** be handled by logging into LinkedIn or using a
stored session cookie (permanent policy, ban risk). The primary path is the **ATS-resolver
cascade** (`skills/form-filling` → "LinkedIn branch"): web-search by title+company, prefer
known ATS domains (Teamtailor, `*.myworkdayjobs.com`, Recman, Easycruit, Webcruiter, Varbi,
Jobylon, `careers.*`/`karriere.*`), verify by **70%+ description-text overlap**, fall back
to the company's own careers portal. Asking the user for the link is the *last* resort.

---

## Tracks & statuses (summary — policy detail in `skills/application-pipeline`)

- `jobs.track`: `nav_quota` (default) | `career`. LinkedIn is always `career`; NAV/FINN
  become `career` only on a leadership or IT keyword (`classify_track`).
- `track_policies` (global, changed only via `/automode`): `nav_quota` min_score 60,
  auto-submit toggleable, daily_limit 10 — `career` min_score 70, **auto-submit permanently
  hard-blocked**, no daily cap.
- `applications.status`: `pending_manual` → `draft` → `approved` → `sending` → `sent` |
  `manual_review` | `failed` | `rejected`.

**Known gap:** FINN Enkel Søknad routing is live, but no tested Playwright fill script
(incl. the login + 2FA relay) exists yet — FINN rows realistically land in `manual_review`.

---

## Project Structure

```
├── App.tsx / index.tsx          # AuthProvider > LanguageProvider > react-router Routes
├── types.ts                     # All TypeScript interfaces
├── pages/                       # Dashboard, Jobs, Settings, ClientProfile, Login, AdminUsers
├── components/                  # JobTable (largest), ProfileEditor, JobMap, Sidebar,
│                                #   ActivityLog, MetricCard, DateRangePicker
├── services/                    # api.ts (all Supabase calls), supabase.ts, translations.ts
├── contexts/                    # AuthContext (localStorage-based), LanguageContext
├── skills/                      # ★ operational source of truth (see table above)
│   ├── application-pipeline/    #   pipeline policy
│   ├── form-filling/            #   SKILL.md + assets/*.mjs + sites/<domain>.json
│   └── soknad-writing/          #   letter rules
├── supabase/functions/          # 15 Deno Edge Functions
│   ├── scheduled-scanner/       #   cron orchestrator
│   ├── job-scraper/             #   FINN/NAV scraping + nav-enhancer.ts
│   ├── extract_job_text/        #   HTML parsing, Enkel Soknad detection
│   ├── job-analyzer/            #   Groq relevance scoring
│   ├── generate_application/    #   creates the application row (no LLM)
│   ├── telegram-bot/            #   main bot webhook (largest function)
│   ├── tech-bot/                #   ops notifications
│   ├── finn-apply/              #   queues FINN application for the agent
│   ├── finn-2fa-webhook/        #   2FA code exchange
│   ├── analyze_profile/ registration-webhook/ admin-actions/ cancel-task/
│   └── db-admin/ fix-jobs-rls/
├── worker/                      # Python — support only, see "Legacy" below
│   ├── analyze_worker.py        #   ★ live: Groq analysis (GitHub Actions)
│   ├── linkedin_daemon.py       #   ★ live: LinkedIn scan (linkedin_scraper.py)
│   ├── db_admin.py              #   ★ live: direct SQL helper
│   └── auto_apply.py, extract_apply_url.py, navigation_goals.py, register_site.py
│                                #   ✝ legacy Skyvern-era, dead
├── database/                    # SQL migrations (not in supabase/migrations/)
└── .github/workflows/           # analyze-jobs, scheduled-scan, evening-digest, deploy-…
```

### GitHub Actions

| Workflow | Trigger |
|---|---|
| `scheduled-scan.yml` | hourly, **Mon-Fri only** (`0 * * * 1-5`) — each user's `scan_time_utc` is respected |
| `analyze-jobs.yml` | every 6h (`0 */6 * * *`) + `workflow_dispatch` + `repository_dispatch` — the cron is a safety net for jobs inserted by `linkedin_daemon.py` outside the scanner |
| `evening-digest.yml` | daily `0 18 * * *` |
| `deploy-supabase-functions.yml` | push to `main` touching `supabase/functions/**` (see drift warning above) |

---

## Legacy / dead code — read before analyzing `worker/`

Skyvern was decommissioned on **2026-07-20** (`1235c80`). The following are **dead** and
must not be treated as the live pipeline:

- `worker/auto_apply.py` — `process_application()` has an early-return guard at the top
  (~line 4943) that routes any row straight back to `status='sending',
  submission_method='agent'`. **Everything below that guard is unreachable**, including its
  LinkedIn/NAV URL-extraction branches and all `navigation_goal` prompt text. The
  `claim_applications()` RPC additionally excludes `submission_method='agent'` rows
  (migration `20260719132000_agent_pipeline_claim_exclusion.sql`).
- `worker/extract_apply_url.py` — Skyvern "Stage 1" URL-extraction daemon. Dead.
- `worker/navigation_goals.py` — Skyvern navigation prompts. Dead.
- `worker/register_site.py`, `save_form_memory_with_skill`, `site_form_memory` — Skyvern-era,
  not extended. Site knowledge now lives in `skills/form-filling/sites/<domain>.json`.
- `FALLBACK_TO_SKYVERN_WORKER` — **removed entirely**, not a false-by-default flag.

Consequence for code analysis: *"feature X is missing"* conclusions drawn from `worker/*.py`
are unreliable. Check `skills/*/SKILL.md` first — that is where the current pipeline's logic
is written.

---

## Environment Variables

**Edge Functions (secrets):** `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GROQ_API_KEY`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_TECH_BOT_TOKEN`, `GITHUB_PAT`

**Python worker (`.env`):** `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `GROQ_API_KEY`,
`TELEGRAM_BOT_TOKEN`, `TELEGRAM_TECH_BOT_TOKEN`

**GitHub Actions:** the above plus `SUPABASE_ACCESS_TOKEN`

Skyvern (`SKYVERN_API_URL`, `SKYVERN_API_KEY`) and LinkedIn credentials
(`LINKEDIN_EMAIL`/`LINKEDIN_PASSWORD`) are obsolete — do not reintroduce them.

---

## Database Tables

| Table | Purpose |
|-------|---------|
| `jobs` | Listings: status, scores, `track`, `application_form_type`, `external_apply_url`, deadline |
| `applications` | Cover letters, status, `submission_method` (`agent`), metadata |
| `track_policies` | Per-track policy (PK `track`): `min_score`, `auto_submit_allowed`, `letter_style`, `daily_limit` |
| `cv_profiles` | User CV profiles (text + structured JSON), versioned |
| `user_settings` | Per-user config, Telegram link, search URLs, `card_notify_min_score` |
| `application_confirmations` | Confirm/cancel button state for the fill-confirmation step |
| `site_credentials` / `registration_flows` | Saved logins, registration tracking |
| `finn_auth_requests` | FINN 2FA code exchange |
| `system_logs` / `export_history` | Per-user events & cost tracking, export records |

---

## Key Conventions

- **Multi-user isolation:** ALL queries filter by `user_id` (the service key bypasses RLS).
  Live users: Vitalii `f92ee73e-786a-4990-b434-23f67203eb53`, Natalia
  `fa497240-e8dc-4a05-9186-b90ad38c858a`. The agent may hand-write/hand-fill **only** for
  Vitalii — any other owner goes to `manual_review` (see `skills/application-pipeline`).
- **Two bots, never mixed:** if `TELEGRAM_TECH_BOT_TOKEN` is unset, *skip* the ops
  notification — never fall back to the main user-facing bot.
- **Auth workaround:** `supabase.auth.*()` hangs — use direct REST fetch with a timeout.
- **FINN detection priority:** `has_enkel_soknad` > `application_form_type='finn_easy'` > URL.
- **FINN URL format:** `finn.no/job/apply?adId=XXXXX` (NOT `/job/apply/XXXXX`).
- **Edge Function timeout:** 30s — heavy work goes to GitHub Actions.
- **Translations:** all UI strings in en/no/uk via `services/translations.ts`.
- **Outcome feedback:** every attempt's verdict updates the relevant
  `skills/form-filling/sites/<domain>.json` before moving to the next job on that domain.

---

## Development Commands

```bash
npm install && npm run dev     # frontend on http://localhost:3000
npm run build                  # production build
npx tsc --noEmit               # type check

# Edge Functions (from project root)
supabase functions deploy <name> --project-ref <ref>
supabase functions deploy telegram-bot --no-verify-jwt --project-ref <ref>

# Support workers
cd worker && python analyze_worker.py                      # Groq analysis (usually via GH Actions)
cd worker && python analyze_worker.py --reanalyze-career-days N
cd worker && python linkedin_daemon.py                     # LinkedIn scan
```

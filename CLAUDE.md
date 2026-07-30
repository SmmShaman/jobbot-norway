# CLAUDE.md - JobBot Norway

## Project Overview

**JobBot Norway** is a job search automation platform for the Norwegian market. It scrapes FINN.no, LinkedIn, and NAV.no, uses AI to analyze job relevance against user profiles, generates Norwegian cover letters, and automates form submissions via Skyvern browser automation.

**Production**: Frontend on Netlify, backend on Supabase (project ref: `ptrmidlhfdbybxmyovtm`)

---

## Infrastructure

| Component | Platform | Details |
|-----------|----------|---------|
| Frontend | Netlify (job.vitalii.no) | Auto-deploy from GitHub main, manual: `npm run build && npx netlify deploy --prod --dir=dist` |
| Backend | **Self-hosted Supabase on Contabo VPS** — `db-jobbot.vitalii.no` (Kong :8100, db :5433) | Migrated off managed Supabase 2026-07-20. The old managed project `ptrmidlhfdbybxmyovtm` is **dead** (quota block) — do not point anything at it. Service keys live in `Projects\ENV-FILES` and on the VPS, never in this repo. |
| Primary Worker | **Contabo VPS** (`173.249.31.179`, worker id `vps-contabo`) | `auto_apply.py`, heartbeat visible via tech-bot `/worker`. The old Oracle VM `129.151.219.55` row was historical — verify before assuming it still runs. |
| Dev Worker | Local PC (WSL2) | Secondary worker for development/testing |
| Skyvern | **Contabo VPS**, `~/skyvern` docker compose (image pinned `v1.0.12`) | Reached through a Cloudflare tunnel; API key in `worker/.env`, auth header `x-api-key`. **Not** the HuggingFace Space `goldcc/skyvern` any more — that was the pre-July setup and naming it as a live component has already caused one wrong diagnosis (2026-07-30). |
| CI/CD | GitHub Actions | Edge Function deploy, hourly scan, job analysis |
| Monitoring | Telegram `@vitalljobtechbot` | `tech-bot` Edge Function, `/worker` command |
| DNS/Tunnel | Cloudflare | Tunnel to the VPS Skyvern; SSH to the VPS goes to the raw IP, **not** through `vitalii.no` (CF proxies it) |

> **Before diagnosing anything here:** the runtime lives on the VPS, not in this checkout.
> Read `~/.claude/memory-shared/vps_runbook_master.md`, `tokens_and_access_map.md` and the newest
> `session_handoff_*.md`, then verify live state over SSH/API. See "Sync Before You Diagnose" in
> `C:\Users\stuar\CLAUDE.md`.

**Multi-worker locking**: Workers use atomic `claim_applications()` RPC — each instance has a unique `WORKER_ID`. Two workers can run safely without duplicating work.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, TypeScript 5.8, Vite 6, Tailwind (CDN), Lucide icons |
| Backend | Supabase (PostgreSQL, Auth, Edge Functions) |
| AI | Google Gemini (chat completions, job analysis, cover letters) |
| Automation | Skyvern (Docker on Contabo VPS, browser form filling) |
| Bot | Telegram Bot API (notifications, commands, 2FA) |
| Map | Leaflet (job geolocation) |
| Charts | Recharts (dashboard stats) |
| Export | jsPDF, xlsx (job data export) |
| CI/CD | GitHub Actions (deploy, scan, analyze) |

---

## Quick Start

```bash
# Frontend
npm install
npm run dev          # http://localhost:3000

# Worker (requires Skyvern Docker running)
cd worker
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env  # Fill with real credentials
python auto_apply.py

# Type check
npx tsc --noEmit
```

---

## Project Structure

```
├── App.tsx                     # Root: AuthProvider > LanguageProvider > MainLayout
├── index.tsx                   # ReactDOM entry
├── types.ts                    # All TypeScript interfaces
├── pages/
│   ├── DashboardPage.tsx       # Stats, charts, job map
│   ├── JobsPage.tsx            # Job table with filters
│   ├── SettingsPage.tsx        # User settings (URLs, prompts, Telegram, automation)
│   ├── ClientProfilePage.tsx   # CV profile management
│   ├── LoginPage.tsx           # Supabase Auth login
│   └── AdminUsersPage.tsx      # Admin: user management
├── components/
│   ├── JobTable.tsx            # Main job list (88K, largest component)
│   ├── ProfileEditor.tsx       # CV structured editor
│   ├── JobMap.tsx              # Leaflet map with geocoding
│   ├── Sidebar.tsx             # Collapsible nav
│   ├── ActivityLog.tsx         # System logs viewer
│   ├── MetricCard.tsx          # Dashboard stat card
│   └── DateRangePicker.tsx     # Calendar range filter
├── services/
│   ├── api.ts                  # All Supabase API calls (43K)
│   ├── supabase.ts             # Client init + session helpers
│   ├── translations.ts         # i18n (en, no, uk)
│   └── mockData.ts             # Dev fallback data
├── contexts/
│   ├── AuthContext.tsx          # Auth state (localStorage-based, bypasses hanging supabase.auth)
│   └── LanguageContext.tsx      # Language state with DB persistence
├── supabase/functions/          # 14 Deno Edge Functions
│   ├── scheduled-scanner/       # Cron orchestrator: scrape + insert + trigger analyzer
│   ├── job-scraper/             # FINN/NAV scraping + nav-enhancer.ts
│   ├── extract_job_text/        # HTML parsing, Enkel soknad detection, contact extraction
│   ├── job-analyzer/            # Gemini relevance scoring + aura + radar
│   ├── generate_application/    # Cover letter generation (NO + UK)
│   ├── analyze_profile/         # Resume PDF extraction + AI analysis
│   ├── telegram-bot/            # Bot webhook (147K, massive)
│   ├── finn-apply/              # Queue FINN applications
│   ├── finn-2fa-webhook/        # 2FA code exchange
│   ├── registration-webhook/    # Site registration Q&A via Telegram
│   ├── admin-actions/           # User CRUD
│   ├── cancel-task/             # Cancel Skyvern tasks
│   ├── db-admin/                # Direct SQL execution
│   └── fix-jobs-rls/            # RLS policy repair
├── worker/                      # Python workers (run locally)
│   ├── auto_apply.py            # Main: polls DB, fills forms via Skyvern (196K)
│   ├── analyze_worker.py        # GitHub Actions: Gemini analysis
│   ├── extract_apply_url.py     # Stage 1: URL extraction daemon
│   ├── register_site.py         # Registration on recruitment sites
│   └── navigation_goals.py      # Site-specific Skyvern instructions
├── database/                    # SQL migrations (25+ files, not in supabase/migrations/)
└── .github/workflows/           # deploy-supabase-functions, analyze-jobs, scheduled-scan
```

---

## Core Workflows

### 1. Scan & Analyze Pipeline
```
Trigger (Cron/Telegram /scan) -> scheduled-scanner (Edge Function)
  -> job-scraper (scrape FINN/NAV URLs per user)
  -> extract_job_text (details, deadline, form type)
  -> GitHub Actions dispatch -> analyze_worker.py (Gemini)
  -> Telegram card for jobs >= card_notify_min_score (per-user setting, default 40);
     jobs below that are still analyzed/stored, just summarized in the evening digest

```

### 2. Application Generation
```
User clicks "Write Soknad" -> generate_application (Gemini)
  -> Cover letter in Norwegian + Ukrainian translation
  -> Status: draft -> approved (user confirms) -> sending
```

### 3. Two-Stage Skyvern Automation
- **Stage 1** (`extract_apply_url.py`): Daemon extracts external URLs for non-FINN jobs
- **Stage 2** (`auto_apply.py`): Polls for `status='sending'`, fills forms via Skyvern
  - FINN Enkel Soknad: direct `finn.no/job/apply?adId=XXXXX` with 2FA via Telegram
  - External forms: Webcruiter, Easycruit, Teamtailor, etc.

### 4. Telegram Bot Flow
```
/scan -> scrape -> analyze -> notification with buttons
  -> "Write Soknad" -> AI generates cover letter
  -> "Approve" -> "Send to {Company}" -> worker fills form
  -> 2FA code via /code XXXXXX or plain digits -> submitted
```

---

## Database Tables

| Table | Purpose |
|-------|---------|
| `jobs` | Job listings with status, scores, form type, deadline |
| `applications` | Cover letters, status tracking, Skyvern metadata |
| `cv_profiles` | User CV profiles (text + structured JSON) with versioning |
| `user_settings` | Per-user config, Telegram link, search URLs, prompts |
| `finn_auth_requests` | 2FA code exchange for FINN login |
| `site_credentials` | Saved logins for recruitment platforms |
| `registration_flows` | Registration process tracking |
| `system_logs` | Per-user event/cost tracking |
| `export_history` | XLSX/PDF export records |

---

## Environment Variables

### Supabase Edge Functions (secrets)
`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, `TELEGRAM_BOT_TOKEN`, `GITHUB_PAT`

### Python Worker (.env)
`SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `GEMINI_API_KEY`, `SKYVERN_API_URL`, `SKYVERN_API_KEY`, `FINN_EMAIL`, `FINN_PASSWORD`, `TELEGRAM_BOT_TOKEN`

### GitHub Actions Secrets
All of the above plus `SUPABASE_ACCESS_TOKEN`, `SUPABASE_SERVICE_ROLE_KEY`

---

## Key Conventions

- **Auth workaround**: `supabase.auth.*()` hangs -- use direct REST fetch with timeout
- **Multi-user isolation**: ALL queries must filter by `user_id` (service key bypasses RLS)
- **FINN detection priority**: `has_enkel_soknad` > `application_form_type='finn_easy'` > URL check
- **FINN URL format**: `finn.no/job/apply?adId=XXXXX` (NOT `/job/apply/XXXXX`)
- **Edge Function timeout**: 30 seconds -- heavy work delegated to GitHub Actions worker
- **Deployment**: Automatic via GitHub Actions on merge to main (no manual deploy needed)
- **Translations**: All UI strings in 3 languages (en, no, uk) via `services/translations.ts`
- **Types**: All interfaces in `types.ts`, components use PascalCase, services use camelCase
- **Styling**: Tailwind CSS via CDN, Font: Inter
- **Icons**: Lucide React exclusively

---

## Development Commands

```bash
npm run dev                    # Frontend dev server
npm run build                  # Production build
npx tsc --noEmit               # Type check

# Edge Functions (from project root)
supabase functions deploy <name> --project-ref ptrmidlhfdbybxmyovtm
supabase functions deploy telegram-bot --no-verify-jwt --project-ref ptrmidlhfdbybxmyovtm

# Worker
cd worker && python auto_apply.py           # Form filling daemon
cd worker && python extract_apply_url.py --daemon  # URL extraction
cd worker && python register_site.py        # Site registration
cd worker && python analyze_worker.py       # Job analysis (usually via GH Actions)
```

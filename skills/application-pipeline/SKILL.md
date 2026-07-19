# Application Pipeline (bot rules, tracks, policies, auto mode)

## Sync rule

This directory (`Jobbot-NO/skills/application-pipeline/` in the repo) is the
**source of truth**. `~/.claude/skills/application-pipeline/` is a copy kept
only so the skill auto-loads in every future session. **After any change
here, re-copy it to `~/.claude/skills/application-pipeline/`.** Never edit the
`~/.claude` copy directly.

## Why this exists

`skills/form-filling` covers *how* a single form gets filled, and
`skills/soknad-writing` covers *how* a letter gets written. This skill covers
everything above that: which jobs get a letter at all, which track they
belong to, when a submission may happen automatically vs. wait for a human,
and how the two Telegram bots divide responsibility. Previously this content
was scattered inside `form-filling/SKILL.md` (blacklist, threshold) — it
lives here now because it's process policy, not form mechanics.

## Two bots, two audiences (do not mix them up)

- **Main bot** (`@soknad_bot`, `telegram-bot` Edge Function, `TELEGRAM_BOT_TOKEN`)
  — user-facing: job cards, approve/send buttons, `/scan`, `/report`,
  `/automode`, `/navreport`, 2FA codes.
- **Tech bot** (`@vitalljobtechbot`, `TELEGRAM_TECH_BOT_TOKEN`) — service/ops
  info only: scan-progress notices, evening digest, worker heartbeat
  warnings, analysis-run summaries. If `TELEGRAM_TECH_BOT_TOKEN` is unset, the
  correct behavior is to **skip that notification**, never fall back to
  sending it via the main bot — this fallback bug was the actual defect
  fixed in Part A (`analyze_worker.py`, `auto_apply.py`,
  `scheduled-scanner/index.ts` all had this fallback and were corrected to
  skip-and-log instead).
- Every bot command resolves `userId` via `getUserIdFromChat(supabase,
  chatId)` first; if it returns null, reply with the standard `"⚠️ Telegram
  не прив'язаний до акаунту. Використайте /link CODE"` and return — never
  proceed with a null user_id (multi-user isolation, see
  `.claude/rules/bugfix-patterns.md`).

## Search tracks

Two tracks, both stored on `jobs.track` (`nav_quota` default | `career`),
policy config in `track_policies` (PK `track`; columns `min_score`,
`auto_submit_allowed`, `letter_style`, `daily_limit`):

| Track | Purpose | min_score | auto_submit | letter_style | daily_limit |
|---|---|---|---|---|---|
| `nav_quota` | NAV activity-report jobs — "can I do this" | 60 | can be toggled on via `/automode` | `standard` | 10 |
| `career` | Leadership/IT jobs, LinkedIn | 70 | **never** — hard-blocked regardless of command | `wide_individual` | NULL (no cap) |

`track_policies` is global config, not per-user, and is only ever changed via
the `/automode` bot command — never edited by hand in the DB.

### Classifier (`worker/analyze_worker.py::classify_track`)

- LinkedIn source → always `career`.
- Otherwise (NAV/FINN) → `career` only if title+description contains a
  leadership keyword (`leder`, `daglig leder`, `avdelingsleder`, `teamleder`,
  `direktør`, `sjef`, `manager`, plus education-leadership terms `rektor`,
  `undervisningsinspektør`, `styrer barnehage`, `barnehagestyrer` — added
  2026-07-19 because Vitalii is an HK-dir approved teacher, so
  leadership-in-education counts as career even though a plain
  `lærer`/`lærervikar` with no leadership signal stays `nav_quota`; the
  kindergarten-director terms use the multi-word/compound form rather than
  bare `styrer`, since that word alone is a common Norwegian verb — "manages/
  steers" — and would false-positive on unrelated job text) or an IT keyword
  (`utvikler`, `developer`, `devops`, `backend`, `cto`, etc.).
  See `TRACK_LEADERSHIP_KEYWORDS`/`TRACK_IT_KEYWORDS` for the exact lists.
- Default: `nav_quota`.

## Card format

Every job card (both the list view and the single-job view in
`telegram-bot/index.ts`) shows a track badge via `formatTrackBadge(job)`:
`"🎯 Кар'єра"` if `job.track === 'career'`, else `"🟢 NAV-квота"` — same
pattern as the existing `formatFormType(job)` helper.

## Application statuses

`applications.status`: `pending_manual` (queued, no letter yet — see
`skills/soknad-writing`) → `draft` (letter written, awaiting user review) →
`approved` (user confirmed) → `sending` (worker/agent actively submitting) →
`sent` (confirmed submitted) | `manual_review` (submission couldn't be
verified or hit a blocker — see `skills/form-filling` gotchas) | `failed` |
`rejected`.

## Employer blacklist

Hard refusal list, checked (case-insensitive substring match on `company`)
before any recon/fill/submit work — skip straight to `manual_review` or skip
silently, regardless of relevance score. Placeholder until a DB-backed
`employer_blacklist` table exists; this list is the source of truth until then.

- **Nammo** (any entity containing "Nammo", e.g. "NAMMO RAUFOSS AS") — user
  refuses to apply here. Reason (2026-07-18): they don't hire Ukrainians.

## Relevance threshold

Default minimum `relevance_score` to consider for the manual-confirmation
batch pipeline is **70** (raised from 60 on 2026-07-18). Per-track
`min_score` in `track_policies` (60 for `nav_quota`, 70 for `career`) governs
auto-mode eligibility specifically; this 70 threshold is the general batch
cutoff applied on top of that.

## Auto mode (`/automode`)

`/automode on|off [nav|career]` toggles `track_policies.auto_submit_allowed`.
Rules enforced in the bot handler itself, not just by convention:

- No track argument → only `nav_quota` is toggled (deliberately conservative
  default; career must never flip silently).
- `track=career` + `action=on` → hard-refused with an explanation message,
  regardless of who sends the command. This is a permanent policy, not a
  per-request toggle: **career-track jobs are never auto-submitted**, only
  ever queued for manual approval, because they warrant the wide individual
  letter and human judgment on fit.
- After any change, the bot replies with the current state of both tracks
  (including `daily_limit` if set) so the user always sees the full picture,
  not just the one track they touched.

## Learning / outcome feedback loop

Each application attempt has an outcome verdict — `sent`, `manual_review`, or
`failed` — and that verdict should feed back into the relevant
`sites/<domain>.json` profile in `skills/form-filling`, not just sit in the
`applications` row. Concretely: if an attempt hits a new gotcha (unexpected
selector, a char limit that didn't match what was recorded, a submit
verification that needed adjusting), update the site's JSON profile before
moving on to the next job on that same site — the next attempt on that domain
should not re-discover the same problem. This replaces the old Skyvern-era
`site_form_memory`/MetaClaw auto-generated "master skill" aggregation (see
`worker/auto_apply.py::save_form_memory_with_skill`, legacy, not extended)
with something much simpler: the agent itself edits the profile file, the
same way it edits any other source file.

## `/navreport` (submitted-applications report)

`/navreport [days]` (default 30) — pulls `applications` with
`status in ('sent', 'manual_review')` and `sent_at >= now() - days`, joined to
`jobs(title, company, application_form_type, track)`. Sends a Ukrainian text
summary (first 30 rows inline, "…and N more, see the CSV" beyond that) plus a
full CSV attachment (`date,job_title,employer,method,track`) via the
`sendTelegramDocument` helper (Deno native `FormData`/`Blob`, no external
library — there was no prior file-attachment capability in the codebase).
This exists specifically to give NAV a clean paper trail for the activity
report — hence "nav" in the name, though it includes both tracks' sent/
manual_review rows for a full audit picture.

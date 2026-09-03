# Form Filling (Playwright, agent-driven)

## Sync rule

This directory (`Jobbot-NO/skills/form-filling/` in the repo) is the **source of
truth**. `~/.claude/skills/form-filling/` is a copy kept only so the skill
auto-loads in every future session. **After any change here, re-copy it to
`~/.claude/skills/form-filling/`.** Never edit the `~/.claude` copy directly.

## Why this exists

Skyvern (hosted browser automation) is fully decommissioned as of 2026-07-20.
The agent itself drives a local headless Chromium via Playwright, directly in
its own container — no separate worker/service needed. This is a generic
method for filling *any* recruitment site's application form, not tied to one
site, including FINN Enkel Søknad. Site-specific knowledge goes in
`sites/*.json`.

## Turn budget — how much work fits into one wake

Measured 2026-07-29, 05:00–05:52 CEST: **21.61M tokens, 0 applications sent.**
16.33M of that (76%) went to sub-agents — four of them running in parallel
("Resolve+write LinkedIn batch A/B/C/D") over 13 applications, 16.1M in a single
15-minute stretch. The main session overflowed its context three times in 45
minutes. The rules below exist to make that impossible; they are as much a part
of this skill as the Playwright mechanics.

1. **One application per wake.** The gate hands you **at most one** row to work
   on (`sending_to_fill` / `pending_manual`), plus a `*_total` counter so you
   can see the queue depth. Take that row to a terminal state (`sent`,
   `manual_review`, `failed`) and **end the turn** — do not query for the next
   row, do not "finish the batch while the context is warm". The poller fires
   again within 2–5 minutes and the next row starts on a fresh context. Context
   carried across applications is pure re-read cost: the same session prompt is
   billed again on every message, and a compaction mid-application loses the
   very state that made continuing look attractive.
2. **Sub-agents: two at a time, and only for genuinely independent work.**
   Never fan out one sub-agent per application — that is the pattern that cost
   16.3M. A sub-agent is worth spawning only when its job is (a) independent of
   anything the other sub-agent is doing, (b) bounded by a concrete stopping
   condition, and (c) able to answer in a few lines. Give every sub-agent an
   explicit instruction to **return a short structured result** (URL + verdict +
   one-line evidence), never a transcript, never raw HTML or DOM dumps. If a
   task cannot be described that tightly, do it inline instead: an inline step
   reuses the context you already paid for, a sub-agent pays for its own from
   scratch.
3. **Web search / ATS resolution is metered too.** Per application: at most
   ~5 searches and ~3 pages fetched. Nothing found within that → `manual_review`
   with the `ats-resolver: no external form; searched: …` note. The resolver is
   a 15-minute job at 87% hit rate, not an open-ended investigation.
4. **Never re-read what the gate already gave you.** The gate has run every
   query you would run. No confirming `curl`, no "let me just check the queue".
5. **Halt switch — `/workspace/agent/HALTED`.** When the owner says stop
   ("Зупини роботу…"), write the reason into that file
   (`echo "2026-07-29 Vitalii: …" > /workspace/agent/HALTED`) and end the turn.
   Both poller gates check the file first and return `wakeAgent:false` without
   running a single query, so a halt costs nothing at all — as opposed to
   2026-07-29, where answering "стоп-режим досі активний" every 2 minutes burned
   ~0.1M a time. Remove the file (`rm /workspace/agent/HALTED`) only on an
   explicit resume instruction from the owner in the chat; silence is not a
   resume, and neither is the poller firing again.

## Environment constants (fixed, do not vary per site)

- Chromium executable: `/home/node/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome`
- Playwright package: `playwright-core@1.61.1` — **must stay pinned to this
  exact version**, it must match the `chromium-1228` build above. Installing a
  different playwright-core version without also updating the chromium build
  (or vice versa) will break launch.
- Launch args: `{ executablePath, headless: true, args: ['--no-sandbox'] }`
- Install `playwright-core` **locally** in the working directory (e.g. `pnpm
  add playwright-core@1.61.1` inside a folder with its own minimal
  `package.json`), not just globally via `install_packages` — ESM `import`
  does not consult `NODE_PATH`, so a global-only install is invisible to `.mjs`
  scripts run from an arbitrary cwd. Always run fill scripts with cwd = the
  folder containing that local `node_modules`.
- **Screenshots**: never read a full-size PNG with the Read tool. Always
  downscale first (`assets/screenshot.mjs`, `ffmpeg -vf scale=700:-1 -q:v 6`).
  Unlike text, images don't compress under context auto-compaction — a handful
  of full-size screenshots is enough to overflow the prompt.

## Phases

0. **Check the cache first — this is the whole ballgame.** Derive the form host
   from the apply URL and look for `/workspace/agent/form-scripts/<host>/fill.mjs`.
   If it exists, **skip phases 1–2 entirely**: run it with `"submit": false`,
   answer only what it reports in `unmapped` / `required_missing`, then re-run
   with `"submit": true`. No recon, no DOM dumps, no exploratory screenshots.
   Eight platforms cover 80% of the queue, so on most applications this phase is
   the entire job. Read `CACHE.md` for the I/O contract; it is short and exact.
0b. **Ensure the account — BEFORE any field is filled (owner's rule,
   2026-09-03: «спочатку перевірити, чи є акаунт; є — залогінитись; нема —
   зареєструватись; і лише потім заповнювати»).** Run `assets/account.mjs`
   `ensureAccount()` right after the cookie banner, on every host — cached or
   not. It asks the site one cheap question (`detect`: guest form / login
   wall / "this e-mail is already registered") and then does the whole account
   dance itself: stored password from `site_credentials` → log in; e-mail
   already registered → password reset, one-time code read from the
   applicant's mailbox over IMAP (`assets/imap-mail.mjs`), new password stored;
   no account → register, verify via IMAP, store. Outcome `mode`:
   - `guest` / `login` / `reset` / `register` → the form is now reachable;
     continue with the fill phases as usual.
   - `blocked` → `manual_review` NOW with `outcome.reason` written into
     `applications.error_message` (ALWAYS the DB column, not only the tech-bot
     message), no recon, no letter. The only `blocked` reasons left are: no
     IMAP access to the mailbox that owns the account (add
     `<TAG>_IMAP_USER/<TAG>_IMAP_PASSWORD` to `worker/.env`), a CAPTCHA on the
     login, or a hook the platform profile does not have yet.
   An account wall by itself is **no longer** a manual_review reason — on
   2026-08-06 Storebrand (Recman) and Europris (Talentech) burned full fill
   runs to hit it at the last step, and every Recman posting from the same
   employer has been hand-off only since. Per-employer accounts (Recman keys
   its candidate DB by corporation id) use `scope` → credential key
   `apply.recman.page#801`; host-wide accounts (Webcruiter) use the bare host.
   The password never appears in the fill output, the agent context, Telegram
   or a screenshot: the script that sets it is the script that stores it.
1. **Recon — only when the cache misses.** Visit the form fresh, headless, and
   map its structure before writing any fill logic. Use `assets/recon.mjs`
   (`dumpFields`, `dumpButtons`, `findByExactText`) to enumerate inputs/buttons
   and their labels. Take a downscaled screenshot at each step. Do not skip
   straight to writing a fill script from guesses.
   **Recon is the expensive step** — 26.07 cost 20.41M tokens for three sites,
   most of it re-trying the same upload widget seven times. Budget it as a
   one-time investment in that platform, and make it pay off by finishing
   phase 9.
2. **Field mapping by label, not by guessed name** — recruitment sites
   frequently use framework-generated or per-job-dynamic field names (e.g.
   `text_7905`, or React `useId()` ids like `:rv:`). The *label text* is the
   stable, human-meaningful anchor. Map fields by their label first, and only
   fall back to structural selectors (`input[name^="text_"]`, "the input
   nearest this label") when no stable name/id exists.
3. **Fill everything except the cover letter.** Personal info, CV upload
   (`assets/file-upload.mjs`), custom per-job questions, phone number
   (`assets/phone-input.mjs` if the site has a masked phone widget). Leave the
   cover-letter field empty for now.
   Reason (owner's rule, 2026-07-29): the letter is the expensive part and it is
   written by Claude on the subscription, so it must not be written for an
   application that never reaches a form. Filling first also surfaces the things
   that kill a run — account wall, CAPTCHA, a hidden hard requirement, a dead
   URL — before any letter has been paid for.

3b. **Write the letter — last, and only if the form asks for one.** Once every
   other field is filled and nothing is left to decide, look at what the form
   actually wants:
   - a **text field** for the letter → write it now per
     `skills/soknad-writing/SKILL.md`, check the live char limit first
     (`assets/text-fields.mjs`; some fields are contenteditable divs, not real
     `<textarea>`s), then insert it;
   - a **file upload** for the letter → write it, render to a file next to the
     CV and attach it;
   - **no letter field at all** → do not write one. Some forms only take a CV.
     A letter nobody asked for is pure cost.
   Save the text into `applications.cover_letter_no` / `cover_letter_uk` in the
   same run, so the record matches what was actually sent. If the run dies after
   this point, the letter survives for the retry.
4. **Screenshot + field→value list** — capture a downscaled screenshot of the
   fully-filled form (`assets/screenshot.mjs`), and separately produce a plain
   text list of every field name/label and the value that was entered into it.
   Do this *before* submitting: it is the record of what was sent.
   By this point the letter is written and placed, so one screenshot covers the
   whole application — no second pass.
5. **Submit — do not ask first.** Click the real submit button in the same run.
   **There is no form-approval step.** The user already approved this specific
   job when they pressed "✅ Підтвердити" on the job card — that button is what
   created this row in the first place (see the wake contract below). Asking a
   second time for the filled form was removed on 2026-07-27 at the owner's
   explicit instruction ("підтверджувати завжди"), because the wait bought no
   safety and cost real money. Do **not** create an `application_confirmations`
   row, do **not** send inline buttons, do **not** wait for anything.
6. **Final screenshot + status update** — capture a downscaled screenshot
   confirming submission, set `applications.status = 'sent'`.
7. **Tell the user after the fact — in the tech bot.** Send the post-submit
   screenshot plus the field→value list from phase 4 to
   `TELEGRAM_TECH_BOT_TOKEN` (`@vitalljobtechbot`) **with no buttons**. This is
   a receipt, not a request: state the employer, the role, and that the
   application has been sent.
   **Not the main bot.** As of 2026-07-27 `@soknad_bot` carries only messages
   that need the user to act — job cards with buttons, blocking questions, 2FA
   codes. Receipts, letters and hand-offs go to the tech bot so an actionable
   card is never buried; see `skills/application-pipeline/SKILL.md` for the
   full split. (The tech bot reads `update.message` only and has no
   `callback_query` branch, so it can never carry a working button — which is
   exactly why anything needing a button belongs in the main bot.)
8. **Error handling** — on any failure (cover letter over the site's char
   limit, unexpected form step, missing selector, etc.), capture a screenshot
   and set `applications.status = 'manual_review'` rather than guessing or
   retrying blindly. Never leave a row sitting in `sending`: with no human step
   left, a row in `sending` means work in progress, and anything still there
   after `AGENT_STUCK_TIMEOUT_MINUTES` is swept into `failed` by the worker.

9. **Bank the recon — mandatory, before the turn ends.** If phase 1 ran, you
   have just spent millions of tokens learning one platform. Write both
   `/workspace/agent/form-scripts/<host>/profile.json` and a parameterised
   `fill.mjs` matching the `CACHE.md` contract, then verify the script by
   re-running it against the same URL with `"submit": false`. A turn that did
   recon and did not leave a working `fill.mjs` behind has to be treated as
   unfinished — the next application on that platform will pay the full cost
   again. This is not bookkeeping; it is the difference between ~6.8M tokens per
   application and near-zero.
   Keep it keyed by **form host, not employer** (`candidate.webcruiter.com`, not
   the hospital that posted the job) — one script must serve every company on
   that ATS. Working files for a single run may live in `/tmp`; anything worth
   keeping goes under `/workspace/agent/`, which is host-backed and survives
   container rebuilds. `/tmp` does not: 58 scripts written there between 22.07
   and 27.07 were all thrown away.

**Legacy confirmations.** `application_confirmations` rows created before
2026-07-27 may still be `pending` with live Telegram cards. If the user presses
one, the row flips to `confirmed` and reaches the agent through the
`confirmed_to_submit` queue — honour it by re-running the fill script and
submitting. Do not create new rows in that table.

Employer blacklist and relevance-score thresholds are process policy, not
form-filling mechanics — see `skills/application-pipeline/SKILL.md` for both.

## Agent-wake contract (how the agent learns there's work to do)

The trigger is: `applications.status = 'sending' AND applications.
submission_method = 'agent'`. Every queuing path — external forms AND FINN
Enkel Søknad alike — sets both fields together:
- `supabase/functions/generate_application/index.ts` — the primary path since
  2026-07-20: sets `submission_method='agent'` right at row creation
  (`status='pending_manual'`), triggered by the job card's single "✅
  Підтвердити" (`confirm_job_`) button. From 2026-07-29 the row is advanced to
  `status='sending'` **mechanically** by `worker/ats_resolver.py` as soon as the
  job has a usable `external_apply_url` — no letter is written at this stage and
  no agent wakes for it. Letter writing moved inside the fill run (phase 3b), so
  nothing is written for an application that never reaches a form.
- `queueForAgentPipeline()` in `supabase/functions/telegram-bot/index.ts`,
  used by the `auto_apply_`/`queue_agent_`/`retry_app_` button handlers — a
  dormant manual-recovery path, not part of the normal confirm-button flow.
- `supabase/functions/finn-apply/index.ts`, used by the FINN "Enkel Søknad"
  dashboard button.

**One row per wake, oldest first.** The gate slices the queue down to a single
row before it wakes you (`POLICY v6`, 2026-07-29) and reports the rest as a
`*_total` counter. Take that row to a terminal state and end the turn; the next
row is the next wake's job, on a fresh context — see "Turn budget" above for why
this is not negotiable. Report queue position in messages sent during the run
("Заявка 2 з 5", from the counter) — see `skills/application-pipeline`
"Confirmation UX" for the exact convention.

This same flag is what keeps the legacy Python worker
(`worker/auto_apply.py`) from ever touching these rows — its
`claim_applications()` RPC excludes `submission_method = 'agent'` (migration
`20260719132000_agent_pipeline_claim_exclusion.sql`), and as of 2026-07-20
`process_application()` additionally has an early-return guard that routes
any row it still somehow receives straight to `status='sending',
submission_method='agent'` without calling Skyvern — belt-and-suspenders, not
the primary mechanism.

A `schedule_task` poller (script-gated, empty-queue-safe) checks for
`applications` rows matching the trigger above and wakes the agent when one
exists. On wake: pick up the row, run phases 1-8 above, and on success set
`status = 'sent'` (or `manual_review` on any failure/gotcha per phase 8) — do
not touch `submission_method` after that, it's a historical marker, not a
live state field.

**End the turn immediately when the queues are empty.** The gate script
(`GATE v3`, 2026-07-27 — see `scripts/patch-agent-pollers.cjs`) has already run
every query you would run, and hands you three fields: `sending_to_fill`,
`confirmed_to_submit`, and a `legacy_awaiting_button` count. When the first two
are empty, stop — **no confirming `curl`, no "let me verify the queue", no "без
змін" status line.** Each such wake re-reads the whole session context for
~190k tokens; 8.1M went that way across 26–27.07 before this rule existed.

Since phase 5 submits in the same run, a row at `status='sending'` now always
means work in progress or a crashed run — never a human deliberating. That is
why `worker/auto_apply.py` sweeps agent rows into `failed` after
`AGENT_STUCK_TIMEOUT_MINUTES` (default 120, env-overridable), well above a
normal fill but low enough that a dead run does not linger. The legacy
30-minute sweep applies only to non-agent rows.

`legacy_awaiting_button` counts pre-2026-07-27 confirmations still sitting at
`status='pending'`. It is reported for visibility only — it never suppresses a
wake, and you should not act on it.

**Skyvern is gone — there is no fallback path.** `FALLBACK_TO_SKYVERN_WORKER`
has been removed entirely from `telegram-bot/index.ts`, and
`worker/auto_apply.py` no longer calls Skyvern under any code path.

**FINN Enkel Søknad — routing is live, the fill script is not built yet.**
`finn-apply/index.ts` queues FINN applications into the same agent pipeline
as everything else, but a tested, live Playwright fill-script for
`finn.no/job/apply` (including the FINN login + 2FA relay, previously
Skyvern's job via `finn-2fa-webhook`/`finn_auth_requests`) has not been
written. Until it exists, treat any FINN row that reaches phase 1 as a fresh
site-onboarding task — recon it like any new `sites/<domain>.json` site
(phase 1 below) rather than assuming prior Skyvern-era FINN logic still
applies, and expect `manual_review` as the realistic outcome for now.

## LinkedIn branch

`linkedin_easy_apply` jobs are not supported by the legacy worker at all (the
two applications that failed under it, TrendAI and Palo Alto Networks, were
both LinkedIn). For the agent pipeline:

1. **Never log into LinkedIn automatically, and never store/use a LinkedIn
   session cookie for automated requests.** Both are the same risk class
   (account ban, ToS violation) — explicitly out of scope, permanent, not a
   per-request toggle. Confirmed 2026-07-19: the anonymous/logged-out page
   ALWAYS shows a sign-in wall on the "Apply" button regardless of whether the
   underlying job is Easy Apply or an offsite/external form — do not read
   "sign-in wall visible" as "therefore Easy Apply only," that was an actual
   mistake made and corrected this same day (see the Walley/Norion Bank case
   below). Anonymous recon alone cannot distinguish the two job types.
2. **ATS-resolver cascade — the primary path now** (validated 2026-07-19,
   87% direct-hit rate across 10 sampled LinkedIn jobs against real ATS
   pages). Run it for **the one application this wake is about** — resolving a
   batch of LinkedIn rows in parallel sub-agents is exactly the 16.3M mistake
   of 2026-07-29; see "Turn budget" for the limits (≤5 searches, ≤3 pages,
   ≤2 sub-agents, never one per application). Given the job title + company (+ location if the title alone is
   ambiguous), do a web search and prioritize results on known ATS domains —
   Teamtailor (`*.teamtailor.com`, or a company's own `karriar.*`/`karriere.*`
   subdomain), Workday (`*.myworkdayjobs.com`), Recman, Easycruit, Webcruiter,
   Varbi, Jobylon, or a plain `careers.*` company subdomain. Verify the
   candidate page is the same posting by comparing its description text
   against the LinkedIn posting's description — require roughly **70%+
   textual overlap** before treating it as a match; don't just trust the
   title matching. If a company's job title on the external page differs from
   LinkedIn's (e.g. localized/translated title), the description-text match is
   what carries the verification, not the title string.
   - Reference test set (ground truth, 2026-07-19): Tibber →
     `jobs.tibber.com/jobs/7540838`; Siemens → `jobs.siemens.com` (Senior
     Commercial PM Oslo); Norconsult → `wd3.myworkdayjobs...REQ-6176`; NOBA →
     `careers.noba.bank/jobs/7740454`; Capgemini →
     `careers.capgemini.com/1124492001` (⚠️ title on that page is Norwegian,
     "Fullstack Utvikler" — matched via description, not title); DNB → FINN
     `467297242`; Mesta → NAV `ab88c4da`.
   - If a plain web search doesn't surface a direct hit (seen with NOV):
     search the company's own careers portal directly (most companies with an
     ATS also list open roles on their own `karriere`/`careers` page; find it
     from the company's LinkedIn page or a general search, then search inside
     it) before giving up on the resolver.
   - **Offsite-marker prefilter**: LinkedIn's anonymous guest HTML (e.g. the
     `jobs-guest/jobs/api/jobPosting/<id>` payload) carries a `trk` value on
     the apply link — `public_jobs_apply-link-offsite` was observed on the
     confirmed-offsite Walley/Norion Bank posting. Where this marker reliably
     differs between Easy-Apply-only postings and offsite ones, use it as a
     cheap early signal: offsite marker present → go straight to the
     ATS-resolver above; treat this as a prefilter/hint, not a substitute for
     actually verifying the resolved page's description text.
3. **Cookie-based session cascade — proposed, NOT implemented, pending
   explicit separate confirmation.** The idea floated 2026-07-19: fall back to
   a stored `LINKEDIN_SESSION_COOKIE` (from env) for a handful of authenticated
   GET requests (≤5/day) only when the resolver above finds nothing, disabling
   itself on any challenge/checkpoint response. **This has not been written.**
   It sits in the same risk category as rule 1 (automated use of an
   authenticated LinkedIn session — ban risk, ToS violation) and directly
   revisits the permanent "never automate LinkedIn login" policy from rule 1.
   Do not implement this without a fresh, explicit, separately-flagged
   confirmation from the user that spells out the account-ban risk — a
   general "automate everything" instruction elsewhere is not sufficient
   authorization for this specific piece.
4. If an external apply URL is found (via the resolver, or a link the user
   forwards themselves after clicking "Apply" in their own logged-in
   LinkedIn app/browser): treat it exactly like any other external-form job
   from here on — proceed through the normal recon/fill phases against that
   URL, not against linkedin.com.
5. **Asking the user for the link — last resort only**, after the resolver
   (and, if it ever exists, the cookie cascade) both come up empty. If the
   underlying job truly is Easy-Apply-only inside LinkedIn (requires login,
   no external form exists at all): do not attempt it. Set
   `applications.status = 'manual_review'`, make sure the cover letter is
   already written and attached to the application, and message the user
   with the direct job link so they can apply by hand.
6. **Hidden live-form requirements are a normal, expected branch — not a
   one-off.** The live application form is ground truth over both the
   LinkedIn posting text and the job's own listed description; it can reveal
   a hard requirement neither of those mentioned (confirmed case,
   2026-07-19: Walley/Norion Bank's actual form on `karriar.norionbank.se`
   required "goda kunskaper i svenska" — Swedish, not Norwegian, because the
   corporate language of the whole group is Swedish — invisible from the
   Norwegian-language LinkedIn posting). When this happens: stop before
   filling that field, do not guess or fabricate an answer, ask the user to
   confirm whether they actually meet it. If they don't: set
   `applications.status = 'rejected'` with `error_message` stating the
   specific hidden requirement found and where, and record the same fact in
   that site's `sites/<domain>.json` profile so a future job on the same
   domain doesn't need to rediscover it live.

## Account flow via IMAP (implemented 2026-09-03)

Some sites require a registered account before the application form is even
reachable (Webcruiter: host-wide, redirects to `/Account/spalogin`; Recman:
per-employer — the same e-mail is a guest on one employer's instance and
"already registered" on another). Since 2026-09-03 this is code, not design:

| Module | Job |
|---|---|
| `assets/env.mjs` | reads `worker/.env`; lists every `<TAG>_IMAP_USER`/`<TAG>_IMAP_PASSWORD` pair = one mailbox the agent may read |
| `assets/imap-mail.mjs` | `waitForMail({mailbox, fromIncludes, since, extract})` — polls Gmail IMAP (BODY.PEEK, mails stay unread), returns the one-time code or link |
| `assets/credentials.mjs` | `getCredentials` / `saveCredentials` / `markLogin` on `site_credentials` via PostgREST (`SUPABASE_URL` + `SUPABASE_SERVICE_KEY`), `generatePassword()`, `credentialDomain(host, scope)` |
| `assets/account.mjs` | `ensureAccount({page, site, applicant, userId})` — the orchestration; the platform profile supplies hooks `detect`, `login`, `requestReset`, `completeReset`, `register`, `completeRegistration` |

Rules:
1. The mailbox is chosen by the **applicant's e-mail**: accounts on ATS sites
   belong to `stuardbmw@gmail.com`, so the reset/verification mail lands there
   and the agent needs `<TAG>_IMAP_USER=stuardbmw@gmail.com` with a Gmail app
   password. `AUKRO_IMAP_*` (stuardaukro@) covers only accounts the agent
   itself registers on that address. No pair for the mailbox → `blocked`.
2. Passwords are generated (16 chars) and stored in `site_credentials`
   (`site_domain` = host or `host#scope`, unique with `email`; plaintext, same
   as the COWI row from 26.07). `registration_flows` is the legacy Skyvern-era
   table and is not written by this flow.
3. One reset / registration attempt per platform per run. A failed attempt
   (no mail within 5 min, extra identity questions, SMS 2FA, CAPTCHA) →
   `manual_review` with the reason in `applications.error_message`.
4. Never bypass a CAPTCHA; never automate LinkedIn login (see below).
5. `profile.json` may declare `"requiresMailbox": "stuardbmw@gmail.com"` —
   the fill-poller gate then treats the host as cached only while that
   mailbox has an IMAP pair in `worker/.env`, so the agent is not woken to
   fail on a wall it cannot pass yet.

The legacy `worker/register_site.py` (Skyvern + Telegram Q&A relay) stays
untouched and unused.

## Known gotchas (check for these on every new site)

- **Cookie banners** — dismiss first, before anything else
  (`assets/cookie-banner.mjs` tries a list of known accept-button texts).
- **Character limits on text fields** (cover letter, free-text answers) — the
  displayed limit ("0/1500") is the ground truth; verify it live via recon
  rather than trusting a limit stated elsewhere, and check length BEFORE
  inserting text, not after.
- **Multi-step / wizard forms** — steps are often gated behind a "Next"-style
  button that must be clicked to reveal the next step's fields; match this
  button by role+name (`page.getByRole('button', { name: 'Neste' })`), not by
  `getByText`, which can false-positive match unrelated paragraph text
  containing the same words.
- **File upload widgets** — try native `setInputFiles` first; if the widget is
  a custom drop-zone that hides/intercepts the real input, fall back to the
  DataTransfer-based approach in `assets/file-upload.mjs`.
- **Masked phone inputs with a decorative country dropdown** — the dropdown
  may have zero effect on the actual value; see `assets/phone-input.mjs`.
- **contenteditable fields disguised as textareas** — a field can look exactly
  like a `<textarea>` visually and even have an associated `<label for="...">`
  pointing at it, while actually being a `<div contenteditable="plaintext-only">`.
  `locator('textarea')` will silently find nothing — always verify the real
  tag via recon (`findByExactText`) before assuming.
- **Store test assets (CV PDFs etc.) in a path that survives container
  rebuilds** (e.g. `/workspace/agent/assets/`), never in `/tmp`, which is wiped
  on rebuild.
- **SAP SuccessFactors / DNB-style CAPTCHA-gated login** — a guest "Quick
  Apply" flow for an email that's already registered on the site can fail to
  complete without a full password login, and that login can be gated by a
  CAPTCHA. Do not attempt to bypass or solve the CAPTCHA. Retrying via a fresh
  OTP/registration loop does not route around it (confirmed after 5 cycles on
  DNB, 2026-07-19) — treat as `manual_review` and wait for the user to pass
  the CAPTCHA once manually via a direct URL+credentials handoff.
- **Email-only application "forms"** (e.g. vilect.com/Frisikt Økonomi Vest) —
  some sites' "apply" flow is just a mailto address, not a web form at all.
  This skill's phases (recon/fill/screenshot/submit) don't apply; treat as a
  distinct application-form type and just send the cover letter as an email
  after user approval — do not try to force it through Playwright.

## `sites/<domain>.json` profile schema

Every new site gets one file, named after its application-form domain (e.g.
`recman.page.json`, not the job board's own domain if it delegates to a
third-party form host). Shape:

```json
{
  "domain": "apply.recman.page",
  "notes": "Free-text: anything about this site worth remembering that doesn't fit a field below.",
  "entryFlow": [
    { "step": "dismiss cookie banner", "selector": "text=Aksepter alle" },
    { "step": "click apply button", "selector": "text=Søk nå" }
  ],
  "steps": [
    {
      "name": "Last opp CV",
      "fields": [
        { "label": "CV", "selector": "input[type=\"file\"]", "type": "file", "gotcha": null }
      ],
      "advanceButton": { "role": "button", "name": "Neste" }
    },
    {
      "name": "Profil",
      "fields": [
        { "label": "Fornavn*", "selector": "input[name=\"firstName\"]", "type": "text" },
        { "label": "Etternavn*", "selector": "input[name=\"lastName\"]", "type": "text" },
        { "label": "E-post*", "selector": "input[name=\"email\"]", "type": "text" },
        {
          "label": "phone",
          "selector": "input[name=\"mobilePhone.number\"]",
          "type": "maskedPhone",
          "gotcha": "country dropdown is cosmetic; type calling-code+number digits directly, see assets/phone-input.mjs"
        }
      ],
      "advanceButton": { "role": "button", "name": "Neste" }
    },
    {
      "name": "Spørsmål",
      "fields": [
        {
          "label": "dynamic per-job questions",
          "selector": "input[name^=\"text_\"]",
          "type": "text",
          "gotcha": "field names are per-job dynamic (e.g. text_7905); match by associated <label> text, answer is judgment-based per question"
        }
      ],
      "advanceButton": { "role": "button", "name": "Neste" }
    },
    {
      "name": "Gjennomgå og søk",
      "fields": [
        {
          "label": "Søknadsbrev",
          "selector": ".ApplyV2Textarea__textarea[contenteditable]",
          "type": "contenteditable",
          "charLimit": 1500,
          "gotcha": "not a real <textarea>; use assets/text-fields.mjs fillContentEditable"
        }
      ],
      "submitButton": { "role": "button", "name": "Søk" }
    }
  ]
}
```

Field object shape: `label` (human-readable, from the DOM), `selector`
(Playwright selector/locator string), `type` (`text` | `file` | `maskedPhone`
| `contenteditable` | `select` etc.), `charLimit` (optional), `gotcha`
(optional free-text warning). Step object shape: `name`, `fields[]`, and either
`advanceButton` (mid-wizard) or `submitButton` (final step).

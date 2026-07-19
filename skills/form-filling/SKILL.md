# Form Filling (Playwright, agent-driven)

## Sync rule

This directory (`Jobbot-NO/skills/form-filling/` in the repo) is the **source of
truth**. `~/.claude/skills/form-filling/` is a copy kept only so the skill
auto-loads in every future session. **After any change here, re-copy it to
`~/.claude/skills/form-filling/`.** Never edit the `~/.claude` copy directly.

## Why this exists

Skyvern (hosted browser automation) is being phased out for job-application
forms. Instead, the agent itself drives a local headless Chromium via
Playwright, directly in its own container — no separate worker/service needed.
This is a generic method for filling *any* recruitment site's application
form, not tied to one site. Site-specific knowledge goes in `sites/*.json`.

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

1. **Recon** — visit the form fresh, headless, and map its structure before
   writing any fill logic. Use `assets/recon.mjs` (`dumpFields`, `dumpButtons`,
   `findByExactText`) to enumerate inputs/buttons and their labels. Take a
   downscaled screenshot at each step. Record everything learned into a new
   `sites/<domain>.json` profile (schema below) — do not skip straight to
   writing a fill script from guesses.
2. **Field mapping by label, not by guessed name** — recruitment sites
   frequently use framework-generated or per-job-dynamic field names (e.g.
   `text_7905`, or React `useId()` ids like `:rv:`). The *label text* is the
   stable, human-meaningful anchor. Map fields by their label first, and only
   fall back to structural selectors (`input[name^="text_"]`, "the input
   nearest this label") when no stable name/id exists.
3. **Fill — do NOT submit.** Fill every field: personal info, CV upload
   (`assets/file-upload.mjs`), custom per-job questions, cover letter
   (`assets/text-fields.mjs` — check char limit BEFORE inserting, some fields
   are contenteditable divs, not real `<textarea>`s), phone number
   (`assets/phone-input.mjs` if the site has a masked phone widget). Locate but
   do not click the final submit button.
4. **Screenshot + field→value list** — capture a downscaled screenshot of the
   fully-filled form (`assets/screenshot.mjs`), and separately produce a plain
   text list of every field name/label and the value that was entered into it.
5. **Confirmation via tech-bot** — send the screenshot + field→value list to
   the tech-bot with two buttons: "✅ Все вірно — відправляй" / "❌ Скасувати".
   Reuse the existing `application_confirmations` DB table / confirm/cancel
   button pattern already used in `telegram-bot/index.ts`
   (`confirm_apply_*`/`cancel_apply_*`) rather than inventing a new one.
6. **Re-run + submit** — on "✅", re-run the *same* fill script (cheap, a few
   seconds) so no browser session needs to stay open while the user
   deliberates, then click the real submit button this time.
7. **Final screenshot + status update** — capture a downscaled screenshot
   confirming submission, set `applications.status = 'sent'`.
8. **Error handling** — on any failure (cover letter over the site's char
   limit, unexpected form step, missing selector, etc.), capture a screenshot
   and set `applications.status = 'manual_review'` rather than guessing or
   retrying blindly.

Employer blacklist and relevance-score thresholds are process policy, not
form-filling mechanics — see `skills/application-pipeline/SKILL.md` for both.

## Agent-wake contract (how the agent learns there's work to do)

Since 2026-07-19, the Telegram bot's approve/retry buttons for non-FINN
applications set `applications.status = 'sending'` AND
`applications.submission_method = 'agent'` (see `queueForAgentPipeline` in
`supabase/functions/telegram-bot/index.ts`). This flag is also what keeps the
legacy Python worker (`worker/auto_apply.py`) from ever touching these rows —
its `claim_applications()` RPC excludes `submission_method = 'agent'` (migration
`20260719132000_agent_pipeline_claim_exclusion.sql`), so there is no race
between the two pipelines.

A `schedule_task` poller (script-gated, empty-queue-safe) checks for
`applications` rows with `status = 'sending' AND submission_method = 'agent'`
and wakes the agent when one exists. On wake: pick up the row, run phases 1-8
above, and on success set `status = 'sent'` (or `manual_review` on any
failure/gotcha per phase 8) — do not touch `submission_method` after that,
it's a historical marker, not a live state field.

The legacy Skyvern/worker path still exists and is reachable only if someone
flips `FALLBACK_TO_SKYVERN_WORKER = true` in `telegram-bot/index.ts` — treat it
as an emergency-only escape hatch, not a normal branch to maintain going
forward. FINN Enkel Søknad is untouched by any of this; it still goes through
the worker/Skyvern path unconditionally, regardless of the flag.

## LinkedIn branch

`linkedin_easy_apply` jobs are not supported by the legacy worker at all (the
two applications that failed under it, TrendAI and Palo Alto Networks, were
both LinkedIn). For the agent pipeline:

1. **Never log into LinkedIn automatically.** An automated login is a distinct
   risk (account ban) and is explicitly out of scope — a separate decision for
   later, not something to sneak in as part of form-filling.
2. On recon, check — as an anonymous/logged-out visitor — whether the job
   posting exposes an external "Apply on company website" link. LinkedIn often
   shows this even to visitors who aren't logged in; look for it before
   assuming Easy Apply is the only path.
3. If an external apply URL is found: treat it exactly like any other
   external-form job from here on — proceed through the normal recon/fill
   phases against that URL, not against linkedin.com.
4. If the only apply path is Easy Apply *inside* LinkedIn (requires login): do
   not attempt it. Set `applications.status = 'manual_review'`, make sure the
   cover letter is already written and attached to the application, and
   message the user with the direct job link so they can apply by hand.

## Registration flow via IMAP (planned architecture — not yet implemented)

Some sites require a registered account before the application form is even
reachable (as opposed to a guest-friendly form like easycruit — see
`sites/easycruit.com.json`). The legacy `worker/register_site.py` only does
Telegram Q&A relay via Skyvern and is **not** being patched or extended —
account registration for the agent-driven Playwright flow is meant to be a
clean, separate implementation. As of 2026-07-19, this is design-only:
**zero code has been written**.

Design (agreed 2026-07-18):
1. Detect the site's login type first (password-based signup vs. magic-link).
2. Register using a generated password (store it — see below).
3. The agent reads the verification email itself via IMAP — no Telegram relay
   needed for this step. Wait up to 5 minutes, poll only `UNSEEN` messages
   from the site's own domain, extract the code or link from the message body.
4. Complete verification (enter code, or navigate the extracted link) and
   proceed into the actual application form.
5. Persist flow state and any generated password into the `registration_flows`
   table so re-runs don't re-register.

Prerequisites already verified and ready to use once this is built:
`AUKRO_IMAP_USER` / `AUKRO_IMAP_PASSWORD` in `worker/.env`; connectivity to
`imap.gmail.com:993` over SSL confirmed working from throwaway test scripts.

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

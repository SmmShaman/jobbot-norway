# Form-script cache — the contract

Recon is the expensive part of form filling, and until 2026-07-27 it was paid
for again on every single application: the agent wrote its scripts into
`/tmp/formfill/`, which is wiped on container rebuild, and only two site
profiles were ever committed. Measured cost: **~6.8M tokens per new site**
(20.41M for Sopra Steria + Svevia + COWI on 26.07), repeated in full the next
time the same ATS came up.

Eight platforms cover 80% of the queue, so recon should happen **once per
platform, ever**:

| Platform | Share of jobs with an apply URL |
|---|---|
| `easycruit.com` | 32.2% |
| `candidate.webcruiter.com` | 23.1% |
| `recman.page` | 7.4% |
| `nammo.csod.com` (Cornerstone) | 5.0% |
| `jobbnorge.no` | 3.3% |
| `sweco.no` | 3.3% |
| `app.vilect.com` (email-only, no web form) | 3.3% |
| `myworkdayjobs.com` | 2.5% |

## Where it lives

```
/workspace/agent/form-scripts/          ← host-backed, survives container rebuild
  <form-domain>/
    profile.json                        ← schema in SKILL.md § sites/<domain>.json
    fill.mjs                            ← deterministic filler for this ATS
  _salvaged/                            ← raw scripts rescued from /tmp on 2026-07-27
```

**Never `/tmp`.** `/tmp` is wiped on rebuild; `/workspace/agent` is a bind mount
from the host and is not. Working files for a single run may go in `/tmp`, but
anything worth keeping is written here before the turn ends.

The directory is keyed by the **form host**, not the employer:
`candidate.webcruiter.com`, not `sykehuset-innlandet`. One script serves every
company on that ATS — that is the whole point.

## fill.mjs I/O contract

Called as `node fill.mjs input.json`. It must not read anything else and must
not talk to the database or Telegram — the agent owns all of that.

**Input** (`input.json`):

```json
{
  "applyUrl": "https://candidate.webcruiter.com/cv?advertid=5156278770",
  "cvPath": "/workspace/agent/assets/cv.pdf",
  "applicant": {
    "firstName": "Vitalii", "lastName": "Berbeha",
    "email": "…", "phone": "+47…",
    "address": "…", "postalCode": "…", "city": "…"
  },
  "coverLetter": "…",
  "answers": { "Norsk muntlig": "Ja", "Førerkort": "Nei" },
  "submit": false,
  "outDir": "/tmp/run-<application_id>"
}
```

`answers` is keyed by a **substring of the field's visible label** — per-job
questions differ, so the script matches loosely and reports what it could not
place rather than guessing.

**Output** — exactly one JSON line on stdout, exit code 0 on success:

```json
{
  "ok": true,
  "filled": [{ "label": "E-post", "value": "…" }],
  "unmapped": ["Hvor mange års erfaring har du med Java?"],
  "required_missing": [],
  "screenshot": "/tmp/run-…/filled.png",
  "submitted": false,
  "error": null
}
```

| Field | Meaning |
|---|---|
| `filled` | every field the script set, for the receipt |
| `unmapped` | labels found on the form with no value in `answers` — **the only place the agent has to think on a known site** |
| `required_missing` | required fields still empty; a non-empty list means do NOT submit |
| `submitted` | whether the real submit button was clicked (mirrors `submit` in the input) |
| `error` | human-readable failure, `null` on success |

On failure: exit non-zero, `ok: false`, `error` set. The agent then falls back
to recon for this run and updates the profile.

## How the agent uses it

1. Derive the form host from the apply URL.
2. If `form-scripts/<host>/fill.mjs` exists → run it with `submit: false`,
   read `unmapped` / `required_missing`, answer only those, re-run with
   `submit: true`. **No recon, no screenshots of exploration, no DOM dumps.**
3. If it does not exist → full recon per SKILL.md phases 1–2, then write both
   `profile.json` and `fill.mjs` here **before ending the turn**.
4. If `fill.mjs` exists but fails → recon, fix the script in place, and record
   what changed in `profile.json` under `notes`.

A profile is only worth writing if the next application on that host can run
without a model in the loop. If the script needs the agent to look at a
screenshot to work, it is not finished.

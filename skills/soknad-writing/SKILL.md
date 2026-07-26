# Søknad Writing (cover letters, agent-authored)

## Sync rule

This directory (`Jobbot-NO/skills/soknad-writing/` in the repo) is the
**source of truth**. `~/.claude/skills/soknad-writing/` is a copy kept only so
the skill auto-loads in every future session. **After any change here,
re-copy it to `~/.claude/skills/soknad-writing/`.** Never edit the
`~/.claude` copy directly.

## Why this exists

`supabase/functions/generate_application/index.ts` makes **no LLM API call**.
It only queues a row with `status='pending_manual', submission_method='agent'`
(single-button "✅ Підтвердити" flow, updated 2026-07-20 — see
`skills/application-pipeline`). A polling task picks that row up and the
Jobbot agent itself writes `cover_letter_no` (Norwegian) and `cover_letter_uk`
(Ukrainian) by hand, sends the finished letter to the user as a plain FYI
notice (no approve button — there is no manual draft-approval gate in the
normal flow anymore), then advances status straight to `sending` so the
fill/submit poller picks it up next. Multiple queued rows are processed
strictly one at a time, oldest first, with a "Заявка N з M" position in the
FYI message. This skill is the standard for the writing itself — not a prompt
template for some other model, but the actual authoring guide for the agent.

## User-editable master prompt (dashboard) — read BEFORE writing

Before writing each letter, fetch the user's own prompt:
`user_settings.application_prompt` for that user_id (self-hosted DB,
db-jobbot.vitalii.no). If non-empty, that text — edited by the user in the
job.vitalii.no dashboard Settings — is the **authoritative style and task
directive** for the letter body. This skill still governs process mechanics
(queueing, statuses, lengths, track styles, FYI messages), but where
`application_prompt` and this skill disagree on tone/style/emphasis, **the
user's dashboard prompt wins**.

Hard honesty rule (2026-07-23, from Vitalii): never invent or intensify facts
beyond what the CV profile literally states — no added "daily/щодня/hver
dag", no inflated scope, no invented numbers. If the CV says "ansvarlig for
produktanskaffelse", write exactly that responsibility, not "handles
procurement every day". A plain true sentence beats an impressive
embellished one — which is also what the dashboard prompt itself demands
("ærlig, uten bullshit").

## Length and style standard

- **Target length: 2500-3500 characters** of Norwegian body text. This is a
  *wide, individual* letter — specific roles, specific numbers, specific
  companies — not a generic template with employer name swapped in.
- **Style varies by track** (`track_policies.letter_style`):
  - `nav_quota` → `standard`: a solid, competent letter, still individual, but
    doesn't need to over-sell — these are NAV activity-report jobs, the bar is
    "clearly capable and honest," not "must win against 50 applicants."
  - `career` → `wide_individual`: the full wide treatment every time — every
    relevant leadership/technical episode, quantified impact, explicit
    connection to what the specific employer says they value. Career-track
    jobs never get auto-submitted (see `skills/application-pipeline`), so
    there is always a human reading this one closely.
- **Field-limit adaptation**: the live page is the ground truth, exactly as in
  `skills/form-filling`'s char-limit gotcha. If a site's cover-letter field is
  capped below 2500 (some ATSes cap at 1500 or even 1000), condense to fit —
  do not truncate mechanically mid-sentence. Re-derive a shorter version that
  keeps the strongest 2-3 points rather than cutting the wide letter in half.

## Structure (from the reference example)

1. **Opening** — name the exact position and company, one line on why you're
   writing.
2. **Strongest relevant role(s)** — one paragraph per major relevant
   experience, each with: title, employer, concrete scope (team size,
   portfolio size, budget, whatever is quantifiable), and one lesson/insight
   that shows judgment, not just duties performed. **Role selection is
   per-vacancy (confirmed by Vitalii, 2026-07-23)**: pick only the CV
   entries that are actually relevant to *this specific* job ad — do not
   force in every past role regardless of fit. The full CV profile (finance/
   management history, teaching, and the technical/AI/software project work)
   is confirmed accurate by Vitalii as-is ("в моєму профілі все максимально
   те чим я займався") — trust it as ground truth, just choose which parts
   are relevant to the ad at hand. Every role paragraph must include a
   recency remark (roughly how long ago that role was, e.g. "for over fem
   år siden", "i 2019-2020", "de siste to årene") so the reader can place it
   in time — never present a role without signaling its distance from today.
3. **Bridge to current situation** — if self-employed / between roles, frame
   it as active, ongoing, skill-building — not a gap.
4. **Employment status & tense (binding)** — check the profile's
   `current_position`/`current_company` (or the latest `workExperience` entry's
   `endDate`) before writing about the most recent role:
   - If that role has an end date (even the most recent one in the list), it
     is **finished**. Write it in preteritum like every other past role
     (`jobbet`, `hadde ansvar`, `bygde opp`, `rådgav jeg`) — never present
     tense, never "jeg jobber nå hos X". A finished job is not a current job
     just because it's the newest entry.
   - Only write present/present-perfect ("jeg jobber", "har jeg drevet") for a
     role that is genuinely ongoing (empty `endDate`, or a term like
     `nåværende`/`present`/`pågående`).
   - If there is no current role at all (candidate is between jobs), do not
     invent one — use the "Bridge to current situation" framing above
     instead (active job-seeking, skill-building, self-driven activity), in
     past/present-perfect tense about what led here, not a fake "I currently
     work at X."
6. **Why this employer specifically** — reference something concrete from the
   job ad or company (training program, career path, team structure), tied to
   what you personally value in a workplace.
7. **Norwegian-level disclosure (if relevant)** — see B1 rule below. Frame as
   an honest, continuously-improving skill, not an apology.
8. **Closing** — invite a conversation, sign with full name.

## Norwegian B1 honesty rule (binding, do not soften or embellish)

Vitalii's real Norwegian level is **B1**, confirmed directly by him: "Володію
на рівні В1 так і пиши. Не можна однозначно відповісти так чи ні." Apply this
everywhere a letter or form touches language ability:

- Never write or select "fully fluent" / "Ja" (full yes) on Norwegian
  proficiency. If a form gives Ja/Nei/Delvis, the correct answer is
  **Delvis**. If it's free text, say **B1** directly.
- In prose, state B1 honestly but positively (see reference example
  paragraph 6): frame it as effective, working proficiency plus an active,
  ongoing effort — not a weakness to hide, not a claim of mastery.
- Never claim native-level ("Morsmål") — this applies to structured fields
  too, e.g. easycruit's `field_7_58`-family language questions (see
  `sites/easycruit.com.json`): Norsk bokmål → level code `7` (God kjennskap),
  never `3` (Morsmål).

## PDF attachments

When a site wants the cover letter as an uploaded PDF rather than pasted text,
render it with Playwright's `page.pdf()` from a minimal styled HTML template
(letterhead-free, just clean paragraphs) rather than hand-building a PDF via a
separate library — one less dependency, and it guarantees the PDF text
matches exactly what was authored.

## Ukrainian translation for Telegram cards

`cover_letter_uk` is a Ukrainian translation of the same letter, generated
alongside `cover_letter_no`, shown to the user in the Telegram approval card
(cover letters over ~1500 chars get truncated for the Telegram message — see
`.claude/rules/bugfix-patterns.md` "Telegram Message Length"). The Ukrainian
version does not need independent editorial judgment — it should track the
Norwegian original paragraph-for-paragraph so the user can verify content, not
read a stylistically-independent piece.

## Reference example (Karrieresenteret, "Salgskonsulent B2B og B2C", nav_quota
track, 2591 chars — application id `f7c3acd8-5081-4f53-8d14-dd17e989d979`)

```
Jeg søker stillingen som salgskonsulent B2B og B2C hos Karrieresenteret, og ønsker å bidra med solid erfaring fra salg, kunderelasjoner og resultatoppnåelse - bygget opp gjennom mer enn 15 år i lederroller og kunderettet arbeid.

Som daglig leder (CEO) i OUR CAPITAL LLC - handelshuset også kjent under det fulle navnet "Torgoviy dim Nash Kapital" - bygde jeg opp en kundeportefølje på over 2000 B2B-kunder og ledet et team på 10 ansatte over flere år, med ansvar for nysalg, prising, oppfølging av salgsresultater og langsiktig kunderelasjon. Jeg lærte tidlig at salg handler om å forstå kundens reelle behov før man presenterer en løsning, og at tillit bygges gjennom oppfølging - ikke bare det første møtet.

Som lånesjef hos PT Lombard Doncredit rådgav jeg kunder om økonomiske løsninger, vurderte kredittverdighet og fulgte opp avtaler gjennom hele kundereisen - en rolle som krevde tillitsbygging og tydelig kommunikasjon, ofte i krevende samtaler der kunden trengte konkrete og ærlige svar. Senere, som Project Manager hos Aliance Group s.r.o., hadde jeg ansvar for leverandøravtaler, budsjett og resultatoppfølging innen salg av private label-produkter på Amazon, der jeg jobbet målrettet mot konkrete salgsmål hver måned og justerte strategi underveis.

De siste årene har jeg drevet mitt eget enkeltpersonforetak innen netthandel, der jeg selv står for hele salgsprosessen - fra produktvalg og markedsføring til kundedialog, forhandling og oppfølging etter salg. Det har gitt meg en praktisk og oppdatert forståelse av moderne salgsarbeid, både digitalt og i direkte kundekontakt, og lært meg å stå på egne ben kommersielt.

Det jeg leser om Karrieresenteret og samarbeidspartnerne deres - grundig opplæring, tett oppfølging og en tydelig karrierevei - er nettopp den typen miljø jeg trives best i. Jeg liker å bli utfordret, jeg tar godt imot veiledning og coaching, og jeg er motivert av konkrete mål og målbare resultater. Jeg er en lagspiller som setter pris på et konkurransepreget men støttende miljø, samtidig som jeg jobber selvstendig og ansvarlig med egen kundeportefølje.

Norsk er mitt tredjespråk. Jeg behersker det på nivå B1 og kommuniserer godt i det daglige og i faglige sammenhenger, men er ærlig om at jeg ikke er på morsmålsnivå ennå. Jeg jobber kontinuerlig med å forbedre norsken min, og ser på kommunikasjon som et verktøy jeg fortsetter å utvikle - akkurat som salgsferdigheter generelt.

Jeg ser fram til å høre fra dere, og stiller gjerne til en samtale for å fortelle mer om hvorfor jeg passer godt inn i teamet deres.

Med vennlig hilsen
Vitalii Berbeha
```

Note what this example demonstrates concretely: OUR CAPITAL LLC and "Torgoviy
dim Nash Kapital" are named together as the *same* company (never split into
two separate employers — see memory `jobbot_vitalii_cv_facts`), each role gets
its own paragraph with quantified scope, and the B1 disclosure is exactly one
paragraph, positioned second-to-last, framed positively.

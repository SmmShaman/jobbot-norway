/**
 * patch-agent-pollers.cjs — keep the two Jobbot pollers in sync with the
 * form-filling policy and the Telegram channel split.
 *
 * HISTORY
 *
 * GATE v2 (2026-07-27, superseded) closed an "idle wake" leak: the fill gate
 * woke the agent on any row matching `applications.status='sending' AND
 * submission_method='agent'`, which is also the state a filled form sits in
 * while it waits for the user's confirm button. The agent woke every 2 minutes
 * only to answer "без змін" — ~190k tokens a time, 8.1M across 26–27.07.
 *
 * GATE v3 (2026-07-27, superseded) followed the owner's decision to drop the
 * form-approval step ("підтверджувати завжди"): fill and submit in one run, so
 * nothing waits and there is nothing to subtract.
 *
 * POLICY v6 (2026-07-29, current) closes the two leaks measured on 29.07, when
 * 21.61M tokens bought zero sent applications:
 *   - a halt guard: while `/workspace/agent/HALTED` exists both gates answer
 *     `wakeAgent:false` before running a single query. The owner's stop order of
 *     05:33 was costing ~0.1M every 2 minutes, because the gate knew nothing
 *     about it and the agent paid for a full context read just to say "стоп-режим
 *     досі активний";
 *   - both gates now slice their queue to ONE row and report the rest as a
 *     counter, so an application can no longer accumulate context behind the
 *     previous one (the main session overflowed three times in 45 minutes).
 * The prompt blocks also drop the "скасовує / ПЕРЕКРИВАЄ будь-яку вимогу вище"
 * phrasing of v4–v5: an instruction that announces it overrides the agent's own
 * rules reads exactly like a prompt injection, and on 27.07 the agent classified
 * it as one and refused to work for an hour (5.65M). Policy now lives in
 * `skills/form-filling/SKILL.md` — a file the agent trusts — and the poller only
 * points at it.
 *
 * POLICY v10 (2026-09-02, current) adds BOUNDED AUTO-RECON on top of v9. The
 * measured cost of v9's consent-only recon: 19.08–31.08 every queued job landed
 * on an uncached ATS, nobody pressed the card button within the 120-min window,
 * and the pipeline sent exactly zero applications for two weeks. Owner's call
 * (2026-09-02): the fill gate may now grant recon of up to RECON_AUTO_CAP
 * (default 2) NEW platforms per UTC day by stamping
 * skyvern_metadata.auto_recon_granted on the row itself (so the budget is spent
 * once per row, survives the stuck-timeout watchdog, and repeat gate ticks are
 * free). Rows beyond the daily budget still wait for the card button, which
 * since 9e34fc8 also revives timed-out rows. When several uncached hosts queue
 * up, the gate spends the budget on the host with the most queued rows first —
 * recon knowledge generalises per host, so that is the best token-per-vacancy
 * buy.
 *
 * POLICY v9 (2026-08-10, superseded) re-enables NAV/FINN auto-queue at the user's
 * auto_soknad_min_score (owner's decision after 4 days of v8 produced zero
 * submissions — nobody pressed buttons). LinkedIn is excluded from auto AND
 * loses its card button entirely: no form exists and no search channel is
 * allowed, so the button promised what the system cannot do. Because a sending
 * row no longer proves the owner saw it, recon consent is per-row again:
 * confirm_job_/allow_recon_ stamp skyvern_metadata.owner_confirmed, and the
 * fill gate lets an uncached-platform row through only with that stamp (or the
 * legacy RECON_ALLOWED file). Cached platforms flow freely.
 *
 * POLICY v8 (2026-08-06, superseded) implemented "кнопка на кожну вакансію":
 * auto_soknad_enabled OFF for every user, the ONLY way to status='sending' was
 * the owner pressing «✅ Підтвердити», and that press doubled as the recon
 * permission. Everything else from v7 — one row per wake, daily submit cap,
 * letter-last, halt guard, per-user filter — is intact in v9 too.
 *
 * ROUTING v4 (2026-07-27, superseded) applies the owner's second rule: @soknad_bot
 * carries ONLY messages that need the user to do something. Everything
 * informational — cover-letter FYIs, submit receipts, manual-apply hand-offs —
 * moves to @vitalljobtechbot, so an actionable card can never be buried under
 * a wall of notifications. This also strips the 2026-07-26 "куди слати
 * підтвердження" block, which is still present on the pending_manual poller and
 * still mandates the confirm/cancel buttons that no longer exist.
 *
 * USAGE (on the VPS):
 *   cd /home/stuar/nanoclaw-v2 && node /home/stuar/Projects/Jobbot-NO/scripts/patch-agent-pollers.cjs
 *   …same with --dry-run to print the resulting prompts and gates, writing nothing.
 *
 * Idempotent per poller: a poller whose prompt already carries the marker is
 * skipped. Blocks appended by earlier runs are stripped before the current one,
 * and every text replacement is self-erasing, so upgrades never stack
 * contradictory rules. A backup of each row is written next to the DB first.
 */

const path = require('path');
const fs = require('fs');

// This script lives in the jobbot repo but drives the nanoclaw session DB, so
// better-sqlite3 has to be resolved out of the nanoclaw checkout rather than
// from next to this file.
function loadDatabase() {
  const roots = [
    process.env.NANOCLAW_ROOT,
    '/home/stuar/nanoclaw-v2',
    process.cwd(),
  ].filter(Boolean);
  try {
    return require('better-sqlite3');
  } catch (_) {
    /* fall through to the explicit roots below */
  }
  for (const root of roots) {
    try {
      return require(path.join(root, 'node_modules', 'better-sqlite3'));
    } catch (_) {
      /* try the next root */
    }
  }
  throw new Error(
    'better-sqlite3 not found — set NANOCLAW_ROOT to the nanoclaw checkout'
  );
}

const Database = loadDatabase();

// Agent + session are stable for the jobbot agent; override via env if recreated.
const DB_PATH =
  process.env.JOBBOT_INBOUND_DB ||
  '/home/stuar/nanoclaw-v2/data/v2-sessions/ag-1784275710688-s87c7v/sess-1784275710698-esmwo9/inbound.db';

const FILL_SERIES = process.env.JOBBOT_FILL_SERIES || 'task-1784787379628-6jph2g';
const MANUAL_SERIES = process.env.JOBBOT_MANUAL_SERIES || 'task-1784787352236-wrt8oh';

const MARKER = 'POLICY v11 (2026-09-03)';

// Two users are live in production. The agent is only allowed to write letters
// and fill forms for Vitalii — Natalia's rows must go to manual_review by hand
// (see skills/application-pipeline/SKILL.md, "Multi-user safeguard"). Until now
// the gates ignored this, so both her pending_manual rows woke the agent every
// two minutes for work it is forbidden to do, and with the one-row-per-wake
// slice they would have blocked the head of the queue permanently. Filter at the
// gate: an application the agent may not touch is not work.
const OWNER_USER_ID =
  process.env.JOBBOT_OWNER_USER_ID || 'f92ee73e-786a-4990-b434-23f67203eb53';

// Appended blocks, oldest first. Everything from the first match onwards is cut
// before the current block is added.
const BLOCK_SENTINELS = [
  '\n\n📮 КУДИ СЛАТИ ПІДТВЕРДЖЕННЯ', // patch3-pollers.cjs, 2026-07-26
  '\n\n⏹ ЗАВЕРШУЙ ХІД ОДРАЗУ', // GATE v2
  '\n\n⏹ АВТОСАБМІТ', // GATE v3 / ROUTING v4 / CACHE v5
  '\n\n⏹ РЕЖИМ РОБОТИ', // POLICY v6+ (fill poller block starts here)
  '\n\n⏹ ЦЕЙ ПОЛЛЕР БІЛЬШЕ НЕ ПИШЕ ЛИСТІВ', // POLICY v9+ manual block — without
  // this sentinel a re-run stacked a duplicate block (found on the v10 dry-run)
];

// Both gates start with this. A halt costs zero tokens: no wake, no queries, and
// the agent never has to explain that it is halted.
const HALT_GUARD = `#!/bin/bash
# ${MARKER}: owner-issued stop. While the file exists nothing wakes the agent.
if [ -f /workspace/agent/HALTED ]; then
  echo '{"wakeAgent":false,"data":{"halted":true}}'
  exit 0
fi
set -a
source /workspace/extra/jobbot/worker/.env
set +a`;

const ROUTING_RULE = `📵 МАРШРУТИЗАЦІЯ БОТІВ

- @soknad_bot (TELEGRAM_BOT_TOKEN) — ЛИШЕ те, що вимагає дії користувача: картка вакансії з кнопками, пряме питання, якого не обійти, 2FA-код. Нічого більше.
- @vitalljobtechbot (TELEGRAM_TECH_BOT_TOKEN) — УСЕ інше: тексти листів, квитанції про відправлення, скріншоти, «🖐 ВРУЧНУ: …», помилки, підсумки прогонів, статуси.

Причина: важлива картка з кнопкою губиться серед десятків інформаційних повідомлень. Якщо сумніваєшся, куди слати — це тех-бот. Якщо TELEGRAM_TECH_BOT_TOKEN не заданий, повідомлення треба ПРОПУСТИТИ, а не слати в головний бот. Повний опис поділу — у \`skills/application-pipeline/SKILL.md\`, розділ «Two bots, two audiences».`;

const FILL_SCRIPT = `${HALT_GUARD}
# The agent fills and submits in one run, so a row in 'sending' is always real
# work. Legacy pending confirmations are counted, never subtracted.
AUTH=(-H "apikey: \${SUPABASE_SERVICE_KEY}" -H "Authorization: Bearer \${SUPABASE_SERVICE_KEY}")
# Which platforms already have a cached fill script. Recon of a NEW platform
# costs ~6.8M tokens, so it is rationed: the card button consents per row, the
# gate itself grants up to RECON_AUTO_CAP/day (below), and the legacy
# /workspace/agent/RECON_ALLOWED file still lets one through unconditionally.
# What the agent already knows about a platform. Two levels, both usable:
#   fill.mjs     — a runnable script, the cheap case
#   profile.json — a recon map (field labels, wizard steps, gotchas). Filling from
#                  a map costs far less than recon from zero, and the easycruit
#                  profile explicitly generalises across every subdomain.
# A profile routed to manual_review is NOT workable — waking for it would only
# produce a status change. POLICY v11: an account wall is no longer such a
# profile — fill.mjs logs in / resets / registers itself (assets/account.mjs)
# — BUT only when the agent can read the mailbox that owns the account. A
# profile may declare "requiresMailbox": "<e-mail>"; the host counts as cached
# only while worker/.env has a <TAG>_IMAP_USER equal to that address, so the
# agent is not woken to fail on a wall it cannot pass yet.
IMAP_USERS=$(env | sed -n 's/^[A-Z0-9]*_IMAP_USER=//p' | tr 'A-Z' 'a-z' | tr '\\n' ' ')
CACHED=$(for d in /workspace/agent/form-scripts/*/; do
  n=$(basename "$d")
  if [ -f "$d/profile.json" ]; then
    if grep -q '"strategy"[[:space:]]*:[[:space:]]*"manual_review"' "$d/profile.json"; then continue; fi
    need=$(sed -n 's/.*"requiresMailbox"[[:space:]]*:[[:space:]]*"\\([^"]*\\)".*/\\1/p' "$d/profile.json" | head -1 | tr 'A-Z' 'a-z')
    if [ -n "$need" ] && ! echo " $IMAP_USERS " | grep -q " $need "; then continue; fi
    echo "$n"
  elif [ -f "$d/fill.mjs" ]; then
    echo "$n"
  fi
done 2>/dev/null | tr '\\n' ' ')
SCRIPTED=$(for d in /workspace/agent/form-scripts/*/; do [ -f "$d/fill.mjs" ] && basename "$d"; done 2>/dev/null | tr '\\n' ' ')
RECON_OK=0; [ -f /workspace/agent/RECON_ALLOWED ] && RECON_OK=1
# ${MARKER}: bounded auto-recon. Up to RECON_AUTO_CAP new platforms per UTC day
# get recon consent from the gate itself (stamped onto the row as
# skyvern_metadata.auto_recon_granted, so the budget is spent once per row and
# repeat ticks are free). Beyond the budget the card button still works.
AUTO_CAP=\${RECON_AUTO_CAP:-2}
AUTO_FILE="/workspace/agent/.recon-auto-used-$(date -u +%F)"
AUTO_USED=$(cat "$AUTO_FILE" 2>/dev/null)
case "$AUTO_USED" in ''|*[!0-9]*) AUTO_USED=0;; esac
find /workspace/agent -maxdepth 1 -name '.recon-auto-used-*' -mtime +7 -delete 2>/dev/null
Q1=$(curl -s "\${SUPABASE_URL}/rest/v1/applications?select=id,skyvern_metadata,jobs!inner(external_apply_url)&status=eq.sending&submission_method=eq.agent&user_id=eq.${OWNER_USER_ID}&order=created_at.asc" "\${AUTH[@]}")
Q2=$(curl -s "\${SUPABASE_URL}/rest/v1/application_confirmations?select=id&status=eq.confirmed&submitted_at=is.null&order=created_at.asc" "\${AUTH[@]}")
Q3=$(curl -s "\${SUPABASE_URL}/rest/v1/application_confirmations?select=application_id&status=eq.pending" "\${AUTH[@]}")
# Daily submission cap. The owner's rule (2026-07-29): every job above the score
# threshold gets a letter — there can legitimately be ten in a day — but only
# max_applications_per_day of them are actually SUBMITTED. The cap belongs here,
# on the irreversible and expensive step, not on letter writing.
TODAY=$(date -u +%F)
Q4=$(curl -s "\${SUPABASE_URL}/rest/v1/user_settings?select=max_applications_per_day&user_id=eq.${OWNER_USER_ID}" "\${AUTH[@]}")
Q5=$(curl -s "\${SUPABASE_URL}/rest/v1/applications?select=id&status=eq.sent&user_id=eq.${OWNER_USER_ID}&or=(sent_at.gte.\${TODAY},updated_at.gte.\${TODAY})" "\${AUTH[@]}")
case "$Q4" in ""|"null") Q4="[]";; esac
case "$Q5" in ""|"null") Q5="[]";; esac
# A failed curl must not turn into a JS syntax error inside the gate.
case "$Q1" in ""|"null") Q1="[]";; esac
case "$Q2" in ""|"null") Q2="[]";; esac
case "$Q3" in ""|"null") Q3="[]";; esac
node -e "
const arr = v => (Array.isArray(v) ? v : []);
const allFill = arr($Q1);
const allSubmit = arr($Q2);
const legacy = new Set(arr($Q3).map(r => r.application_id));
const dirs = '$CACHED'.trim().split(/\\s+/).filter(Boolean);
const scripted = '$SCRIPTED'.trim().split(/\\s+/).filter(Boolean);
const reconOk = '$RECON_OK' === '1';
const host = u => { try { return new URL(u).hostname.replace(/^www\\./, ''); } catch (e) { return ''; } };
// Match by suffix, not equality: every employer on easycruit gets its own
// subdomain (ostre-toten.easycruit.com) while the form engine — and therefore the
// cached knowledge — is shared. Exact matching would have made the cache useless
// for exactly the platform that covers a third of the queue.
const covers = (list, h) => !!h && list.some(d => {
  const base = d.replace(/^\\*\\./, '');
  return h === base || h.endsWith('.' + base);
});
// A row is workable when the agent already has knowledge of its form host —
// a script, or at least a recon map. Anything else would mean recon from zero,
// which is the single most expensive thing the agent does.
const ready = allFill.filter(r => covers(dirs, host((r.jobs || {}).external_apply_url)));
// ${MARKER}: NAV/FINN auto-queue (since v9), so a sending row does not prove
// the owner saw it. Recon consent for an uncached platform comes from either
// the card button (confirm_job_/allow_recon_ stamps owner_confirmed) or the
// gate's own daily auto-recon budget (stamps auto_recon_granted, below).
// Cached platforms need no consent; RECON_ALLOWED stays as the legacy override.
const consented = r => { const m = r.skyvern_metadata || {}; return m.owner_confirmed === true || m.auto_recon_granted === true; };
const workable = allFill.filter(r => ready.includes(r) || consented(r) || reconOk);
const uncached = allFill.filter(r => !workable.includes(r));
const cap = Number((arr($Q4)[0] || {}).max_applications_per_day) || 5;
const sentToday = arr($Q5).length;
const capReached = sentToday >= cap;
// Bounded auto-recon: only when nothing cached/consented is waiting, spend one
// unit of today's budget on ONE uncached row — preferring the host with the
// most queued rows, because recon knowledge generalises across the whole host.
// The grant is stamped onto the row BEFORE waking, so a crash, a stuck-timeout
// or the next tick never re-spends the budget on the same row.
const autoCap = Number('$AUTO_CAP') || 0;
let autoUsed = Number('$AUTO_USED') || 0;
let autoPick = [];
if (!capReached && !allSubmit.length && !workable.length && uncached.length && autoUsed < autoCap) {
  const byHost = {};
  uncached.forEach(r => { const h = host((r.jobs || {}).external_apply_url); if (h) byHost[h] = (byHost[h] || 0) + 1; });
  const cand = uncached.slice().sort((a, b) =>
    (byHost[host((b.jobs || {}).external_apply_url)] || 0) - (byHost[host((a.jobs || {}).external_apply_url)] || 0)
  )[0];
  const meta = Object.assign({}, cand.skyvern_metadata || {}, {
    auto_recon_granted: true,
    auto_recon_granted_at: new Date().toISOString()
  });
  try {
    require('child_process').execFileSync('curl', ['-s', '-f', '-X', 'PATCH',
      '\${SUPABASE_URL}/rest/v1/applications?id=eq.' + cand.id,
      '-H', 'apikey: \${SUPABASE_SERVICE_KEY}',
      '-H', 'Authorization: Bearer \${SUPABASE_SERVICE_KEY}',
      '-H', 'Content-Type: application/json',
      '-d', JSON.stringify({ skyvern_metadata: meta })]);
    require('fs').writeFileSync('$AUTO_FILE', String(autoUsed + 1));
    autoUsed += 1;
    cand.skyvern_metadata = meta;
    autoPick = [cand];
  } catch (e) { /* PATCH failed: no stamp, no budget spent, retry next tick */ }
}
const stillUncached = uncached.filter(r => !autoPick.includes(r));
// One row per wake: context must not accumulate across applications.
const toSubmit = capReached ? [] : allSubmit.slice(0, 1);
const pool = workable.concat(autoPick);
const toFill = (capReached || toSubmit.length) ? [] : pool.slice(0, 1);
const wake = toFill.length > 0 || toSubmit.length > 0;
console.log(JSON.stringify({
  wakeAgent: wake,
  data: {
    sending_to_fill: toFill,
    confirmed_to_submit: toSubmit,
    has_fill_script: toFill.length
      ? covers(scripted, host((toFill[0].jobs || {}).external_apply_url))
      : null,
    sent_today: sentToday,
    daily_cap: cap,
    daily_cap_reached: capReached,
    ready_cached_total: ready.length,
    awaiting_recon_total: stillUncached.length,
    awaiting_recon_hosts: [...new Set(stillUncached.map(r => host((r.jobs || {}).external_apply_url)).filter(Boolean))].slice(0, 12),
    recon_allowed: reconOk,
    auto_recon_cap: autoCap,
    auto_recon_used_today: autoUsed,
    auto_recon_granted_now: autoPick.length > 0,
    confirmed_to_submit_total: allSubmit.length,
    legacy_awaiting_button: legacy.size
  }
}));
"
`;

const MANUAL_SCRIPT = `${HALT_GUARD}
# Owner's rule (2026-07-29): writing the cover letter and filling the form are ONE
# process, and the letter is written last — see skills/form-filling/SKILL.md phase 3b.
# So this poller no longer wakes the agent to write letters in advance.
# Promotion pending_manual -> sending is mechanical and happens in
# worker/ats_resolver.py; a row that cannot be promoted is missing its form URL,
# which is the resolver's problem, not something the agent can fix by thinking.
# The counters stay so the queue is still visible in the logs.
Q=$(curl -s "\${SUPABASE_URL}/rest/v1/applications?select=id,jobs(external_apply_url)&status=eq.pending_manual&user_id=eq.${OWNER_USER_ID}&order=created_at.asc" -H "apikey: \${SUPABASE_SERVICE_KEY}" -H "Authorization: Bearer \${SUPABASE_SERVICE_KEY}")
case "$Q" in ""|"null") Q="[]";; esac
node -e "
const arr = v => (Array.isArray(v) ? v : []);
const all = arr($Q);
const withUrl = all.filter(r => (r.jobs || {}).external_apply_url);
console.log(JSON.stringify({
  wakeAgent: false,
  data: {
    pending_manual_total: all.length,
    awaiting_promotion: withUrl.length,
    awaiting_form_url: all.length - withUrl.length,
    note: 'letters are written inside the fill run, not here'
  }
}));
"
`;

// Shared preamble for both pollers. Deliberately written as a pointer to the
// skill files rather than as a rule that claims to override anything: the
// "скасовує/ПЕРЕКРИВАЄ" phrasing of v4–v5 made the agent suspect an injection.
const TURN_BUDGET = `⏹ РЕЖИМ РОБОТИ (${MARKER})

Джерело правди — \`/workspace/extra/jobbot/skills/form-filling/SKILL.md\` (розділ «Turn budget», фази 0–9) і \`skills/form-filling/CACHE.md\`. Нижче — тільки те, що стосується цього поллера.

1️⃣ ОДНА ЗАЯВКА ЗА ПРОГІН. Гейт віддає щонайбільше один рядок і окремо \`*_total\` — довжину черги. Рядки вже відфільтровані за \`user_id\` власника (Vitalii), тож чужі заявки до тебе не доходять і будити тебе через них гейт не буде.

1️⃣b ДОБОВИЙ ЛІМІТ ПОДАЧ. Листи пишуться на всі релевантні вакансії, але ВІДПРАВЛЯЄТЬСЯ щонайбільше \`daily_cap\` за добу (налаштування \`max_applications_per_day\`). Гейт рахує це сам і показує \`sent_today\`/\`daily_cap\`; коли ліміт вибрано, він просто не будить тебе до наступної доби. Не намагайся «дотиснути ще одну» — і не став \`status='sent'\` рядкам, які насправді не відправлені: цей лічильник спирається саме на них. Доведи цей рядок до кінцевого статусу і заверши хід. Не питай наступний рядок, не «добери ще, поки контекст теплий»: поллер спрацює знову за 2–5 хв і візьме наступну заявку на чистому контексті. 29.07 контекст переповнився тричі за 45 хв саме через накопичення.

2️⃣ СУБАГЕНТИ — не більше 2 одночасно і лише для справді незалежних задач з чіткою умовою зупинки. Віяло «один субагент на заявку» ЗАБОРОНЕНО: 29.07 чотири паралельні субагенти на 13 LinkedIn-заявок з'їли 16,3M (76% усіх витрат) і не відправили жодної. Кожному субагенту прямо кажи повернути короткий структурований результат (URL + вердикт + один рядок доказу), а не транскрипт, не HTML і не дампи DOM. Якщо задачу не вдається так вузько описати — роби її сам: свій контекст ти вже оплатив, субагент оплачує новий.

3️⃣ ATS-resolver на заявку — щонайбільше ~5 пошуків і ~3 відкриті сторінки. Не знайшов у цьому бюджеті → \`manual_review\` з \`error_message\` виду «ats-resolver: no external form; searched: …».

4️⃣ НЕ перевіряй те, що вже дав гейт. Жодного curl/SQL «щоб пересвідчитись» і жодного рядка «Без змін» — просто заверши хід. Кожне таке пробудження коштує ~190k; так згоріло 8,1M за 26–27.07.

5️⃣ СТОП-РЕЖИМ. Якщо власник каже зупинитись — запиши причину у \`/workspace/agent/HALTED\` (\`echo "дата, хто, причина" > /workspace/agent/HALTED\`) і заверши хід. Далі гейт узагалі не будитиме тебе, поки файл існує, тож пояснювати щось на кожне спрацювання не доведеться. Знімати стоп (\`rm /workspace/agent/HALTED\`) — лише за явним розпорядженням власника в чаті.`;

const FILL_BLOCK = `

${TURN_BUDGET}

🗄 ПЛАТФОРМИ. NAV/FINN-заявки потрапляють у чергу автоматично (з POLICY v9, поріг \`auto_soknad_min_score\`). Рядок НЕЗНАЙОМОЇ платформи гейт віддає тобі лише тоді, коли дозвіл на розвідку вже є: штамп \`owner_confirmed\` (власник натиснув кнопку на картці) або \`auto_recon_granted\` (гейт сам видає до \`auto_recon_cap\` таких дозволів на добу — ${MARKER} — і ставить штамп у \`skyvern_metadata\` ще ДО твого пробудження). Тож окремо питати дозволу НЕ треба: якщо рядок прийшов — його вже дозволено, розвідуй і заповнюй. Дивись поле \`has_fill_script\`:

- \`true\` — є готовий \`fill.mjs\`. Запусти його з \`"submit": false\`, дай відповіді лише на те, що він поверне в \`unmapped\`/\`required_missing\`, потім \`"submit": true\`. Контракт — у \`CACHE.md\`.
- \`false\` — скрипта немає, але Є \`profile.json\` — карта форми з recon: підписи полів, кроки візарда, пастки. Заповнюй ЗА НЕЮ, а не з нуля, і до кінця ходу збережи \`fill.mjs\`, щоб наступного разу було \`true\`.

Каталог named за хостом форми, і збіг перевіряється за суфіксом: \`ostre-toten.easycruit.com\` обслуговує профіль \`easycruit.com\` — у easycruit кожен роботодавець має свій піддомен, а рушій форми спільний. Не роби recon для нового піддомену знайомої платформи.

Якщо для хоста в \`form-scripts/\` немає НІ скрипта, НІ \`profile.json\` — це нова платформа. Розвідай її В ЦЬОМУ Ж прогоні (recon коштує ~6,8M — тому за один прогін розбирай ОДНУ нову платформу) і, до завершення ходу, ОБОВʼЯЗКОВО збережи \`/workspace/agent/form-scripts/<хост>/profile.json\` і параметризований \`fill.mjs\`, перевіривши його повторним запуском. НІКОЛИ не лишай напрацьоване в \`/tmp\` — його стирає перезбірка контейнера (так згинули 58 скриптів за 22–27.07). Поля \`awaiting_recon_total\`/\`awaiting_recon_hosts\` — тепер лише лічильники ще не розібраних нових платформ у черзі, а \`recon_allowed\` — легасі-прапорець, на нього не зважай.

✍️ ЛИСТ ПИШЕТЬСЯ ОСТАННІМ, УСЕРЕДИНІ ЦЬОГО Ж ПРОГОНУ. Заповни ВСЕ, крім супровідного листа: контакти, CV, питання роботодавця, телефон. Аж коли решта готова і нічого вирішувати не лишилось — подивись, чого форма просить: текстове поле → напиши лист за \`skills/soknad-writing/SKILL.md\` (спершу перевір ліміт символів) і встав; файл → напиши, збережи файлом і прикріпи поруч із CV; поля для листа немає взагалі → НЕ пиши його. Готовий текст збережи в \`applications.cover_letter_no\`/\`cover_letter_uk\` у цьому ж прогоні.

Причина: лист пише Claude з підписки, і він не має писатися для заявки, яка до форми так і не дійшла. Заповнення першим також викриває CAPTCHA чи мертвий URL ДО того, як за лист заплачено.

🔐 АКАУНТ — ПЕРШИЙ КРОК, ДО ЗАПОВНЕННЯ (${MARKER}, правило власника 03.09: «спочатку перевірити, чи є акаунт; є — залогінитись; нема — зареєструватись; потім заповнювати»). Одразу після cookie-банера скрипт викликає \`ensureAccount()\` з \`skills/form-filling/assets/account.mjs\` (фаза 0b у SKILL.md): збережений пароль із \`site_credentials\` → логін; «e-post уже зареєстровано» → скидання пароля, код з пошти власника через IMAP (\`assets/imap-mail.mjs\`), новий пароль у \`site_credentials\`; акаунта нема → реєстрація з підтвердженням через ту саму пошту. Акаунт-стіна САМА ПО СОБІ більше не причина для manual_review. У вихідному JSON скрипта є поле \`account.mode\`: \`guest|login|reset|register\` — форма доступна, заповнюй далі; \`blocked\` — став \`manual_review\` і запиши \`account.reason\` в \`error_message\` (це лише: немає IMAP-доступу до скриньки акаунта, CAPTCHA на вході, або в профілю платформи ще нема хуків). Пароль ніколи не проходить через твій контекст, вивід скрипта чи Telegram — його зберігає сам скрипт. Для нової платформи, що має стіну, під час recon напиши хуки \`detect/login/requestReset/completeReset/register\` у \`fill.mjs\` за зразком \`form-scripts/candidate.webcruiter.com/fill.mjs\`.

📤 ВІДПРАВЛЕННЯ. Кроку схвалення вже заповненої форми в процесі немає (фаза 5 у SKILL.md): форма заповнена разом із листом → скріншот і список «поле → значення» → одразу натисни submit → постав \`applications.status='sent'\` → надішли скріншот і список у ТЕХНІЧНИЙ бот як квитанцію БЕЗ кнопок. Рядків у \`application_confirmations\` не створюй, інлайн-кнопок не шли і нічого не чекай: користувач схвалив цю вакансію кнопкою «✅ Підтвердити» на картці — саме вона й створила цей рядок.

Черга \`confirmed_to_submit\` — це старі підтвердження (до 2026-07-27), картки яких ще живі, і вона має пріоритет над \`sending_to_fill\`. Якщо користувач натисне таку кнопку, перезапусти скрипт заповнення і відправ. Поле \`legacy_awaiting_button\` — лише лічильник для видимості, на нього не реагуй.

Рядок у \`sending\` означає роботу в процесі або впалий прогін — ніколи не «людина думає». Не лишай заявку в цьому статусі: будь-яка помилка → \`manual_review\` зі скріншотом.

${ROUTING_RULE}`;

const MANUAL_BLOCK = `

⏹ ЦЕЙ ПОЛЛЕР БІЛЬШЕ НЕ ПИШЕ ЛИСТІВ (${MARKER})

Написання супровідного листа переїхало ВСЕРЕДИНУ прогону заповнення форми і робиться останнім кроком — див. \`skills/form-filling/SKILL.md\`, фаза 3b. Лист більше не пишеться наперед: він коштує підписки, а заявка часто до форми не доходила.

Переведення \`pending_manual\` → \`sending\` тепер механічне, його робить \`worker/ats_resolver.py\`, щойно у вакансії з'являється \`external_apply_url\`. Розуму це не потребує, тож гейт тебе сюди більше не будить (\`wakeAgent:false\` завжди).

Якщо ти все ж отримав це завдання — заверши хід без жодного curl/SQL. Заявка без \`external_apply_url\` чекає на резолвер, а не на тебе.

${ROUTING_RULE}`;

// Sentences in the prompt bodies that contradict the rules above. Each entry is
// self-erasing; several variants of the same sentence are listed so the script
// works on a fresh prompt and on one an earlier version already rewrote.
const FILL_REPLACEMENTS = [
  [
    'і ЧЕКАЙ на явну кнопку підтвердження в Telegram. НІКОЛИ не сабміть без явного підтвердження.',
    "і ОДРАЗУ натисни submit роботодавцю. Далі постав applications.status='sent' і надішли скріншот + список у ТЕХНІЧНИЙ бот як квитанцію БЕЗ кнопок.",
  ],
  [
    'у ГОЛОВНИЙ бот як FYI БЕЗ кнопок — це квитанція, а не запит.',
    'у ТЕХНІЧНИЙ бот як квитанцію БЕЗ кнопок.',
  ],
  [
    'надішли користувачу в Telegram пряме посилання на вакансію + готовий текст листа для ручної подачі.',
    'надішли в ТЕХНІЧНИЙ бот пряме посилання на вакансію + готовий текст листа для ручної подачі.',
  ],
  [
    'Обробляй заявки по одній, повідомляй про кожен результат окремо.',
    'Гейт віддає одну заявку за прогін — обробляй саме її і завершуй хід.',
  ],
];

const MANUAL_REPLACEMENTS = [
  [
    'Надішли користувачу в Telegram FYI-повідомлення з текстом листа (обидві мови, коротко) — це лише інформаційне повідомлення, БЕЗ кнопки підтвердження (підтвердження вже відбулось раніше, на етапі pending_manual).',
    'Надішли FYI з коротким текстом листа (NO+UK) у ТЕХНІЧНИЙ бот (TELEGRAM_TECH_BOT_TOKEN, @vitalljobtechbot). У головний бот @soknad_bot такі повідомлення НЕ йдуть.',
  ],
  [
    'Гейт-скрипт поверне до 5 таких рядків за раз (id, job_id, user_id, created_at) — це навмисне обмеження, черга велика (88+ заявок станом на 2026-07-23), не намагайся обробити більше за один прохід.',
    'Гейт-скрипт поверне РІВНО ОДИН такий рядок (найстаріший: id, job_id, user_id, created_at) і окремо лічильник pending_manual_total. Це навмисне обмеження: одна заявка за прогін, решту візьмуть наступні пробудження.',
  ],
  ['Для кожної заявки з даних:', 'Для заявки, яку віддав гейт:'],
  [
    'Обробляй заявки по черзі. Якщо для якоїсь заявки щось не вдалось — повідом і переходь до наступної, не зупиняй весь прохід.',
    "За прогін — одна заявка. Якщо з нею не вдалось: постав manual_review з error_message, повідом у тех-бот і заверши хід; наступну візьме наступне пробудження.",
  ],
];

// Phrases that announce they cancel or override earlier rules. The agent is
// trained to distrust exactly this shape of instruction and on 2026-07-27 it
// classified the poller prompt as an injection because of them (5.65M spent
// refusing to work). Same content, stated as fact rather than as an override.
const SHARED_REPLACEMENTS = [
  [
    'recon → мапа полів → заповнення через Playwright → скріншот → підтвердження в Telegram → submit.',
    'recon → мапа полів → заповнення через Playwright → скріншот → submit → квитанція в тех-бот.',
  ],
  [
    'Цей блок ПЕРЕКРИВАЄ будь-які висновки з підсумків твоїх попередніх сесій, зокрема твердження «linkedin_easy_apply завжди йде в manual_review» і «в цьому беклозі все одно все LinkedIn-only».',
    'Повний опис — у skills/form-filling/SKILL.md, розділ «LinkedIn branch»; нижче стислий виклад. Підсумки твоїх сесій до 2026-07-26, де сказано «linkedin_easy_apply завжди йде в manual_review», описують стан до появи ATS-resolver.',
  ],
  [
    'УВАГА: «LinkedIn → вручну» з цього переліку СКАСОВАНО 2026-07-26',
    'Виняток: LinkedIn-вакансії спершу проходять ATS-resolver',
  ],
  [
    'Чергу з 76+ заявок score≥60 обробляй безперервно.',
    'Черга обробляється безперервно, але темп задає поллер: одна заявка за прогін.',
  ],
  [
    'постав їй status=manual_review і одразу бери наступну',
    'постав їй status=manual_review і заверши хід — наступну візьме наступне пробудження',
  ],
];

const POLLERS = [
  {
    name: 'fill queue',
    series: FILL_SERIES,
    script: FILL_SCRIPT,
    recurrence: '*/5 * * * *',
    block: FILL_BLOCK,
    replacements: FILL_REPLACEMENTS.concat(SHARED_REPLACEMENTS),
  },
  {
    name: 'pending_manual queue',
    series: MANUAL_SERIES,
    script: MANUAL_SCRIPT, // halt guard + one row per wake
    recurrence: null, // cadence unchanged
    block: MANUAL_BLOCK,
    replacements: MANUAL_REPLACEMENTS.concat(SHARED_REPLACEMENTS),
  },
];

function stripGeneratedBlocks(prompt) {
  let out = prompt;
  for (const sentinel of BLOCK_SENTINELS) {
    const i = out.indexOf(sentinel);
    if (i !== -1) out = out.slice(0, i);
  }
  return out;
}

function applyReplacements(prompt, replacements) {
  let out = prompt;
  for (const [find, replace] of replacements) {
    if (out.includes(find)) {
      out = out.split(find).join(replace);
      console.log(`    replaced  : "${find.slice(0, 46)}…"`);
    }
  }
  return out;
}

const DRY_RUN = process.argv.includes('--dry-run');
// Re-apply even when the prompt already carries the marker — for when the gate
// script changed but the policy text did not.
const FORCE = process.argv.includes('--force');

function patchPoller(db, poller) {
  const row = db
    .prepare(
      'select id, content, recurrence from messages_in where series_id = @s order by process_after desc limit 1'
    )
    .get({ s: poller.series });

  if (!row) {
    console.error(`  MISSING — no messages_in row for ${poller.series}`);
    return false;
  }

  const content = JSON.parse(row.content);
  if (content.prompt.includes(MARKER) && !FORCE) {
    console.log(`  SKIP — ${poller.name} already at ${MARKER}`);
    return true;
  }

  if (DRY_RUN) {
    const next =
      applyReplacements(stripGeneratedBlocks(content.prompt), poller.replacements) +
      poller.block;
    console.log(`  DRY-RUN ${poller.name}: prompt ${content.prompt.length} -> ${next.length} chars`);
    console.log('----- prompt -----');
    console.log(next);
    if (poller.script) {
      console.log('----- gate -----');
      console.log(poller.script);
    }
    return true;
  }

  const backupPath = path.join(
    path.dirname(DB_PATH),
    `poller-backup-${poller.series}-${Date.now()}.json`
  );
  fs.writeFileSync(
    backupPath,
    JSON.stringify(
      { id: row.id, series_id: poller.series, recurrence: row.recurrence, content: row.content },
      null,
      1
    )
  );

  const beforeLen = content.prompt.length;
  if (poller.script) content.script = poller.script;
  content.prompt =
    applyReplacements(stripGeneratedBlocks(content.prompt), poller.replacements) +
    poller.block;

  const update = db.transaction(() => {
    db.prepare('update messages_in set content = @c where id = @id').run({
      c: JSON.stringify(content),
      id: row.id,
    });
    if (poller.recurrence) {
      db.prepare(
        'update messages_in set recurrence = @r where series_id = @s and recurrence is not null'
      ).run({ r: poller.recurrence, s: poller.series });
    }
  });
  update();

  console.log(`  PATCHED ${poller.name} (row ${row.id})`);
  console.log(`    prompt    : ${beforeLen} -> ${content.prompt.length} chars`);
  if (poller.script) console.log(`    gate      : ${poller.script.length} chars`);
  if (poller.recurrence) console.log(`    recurrence: ${row.recurrence} -> ${poller.recurrence}`);
  console.log(`    backup    : ${backupPath}`);
  return true;
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`inbound.db not found: ${DB_PATH}`);
    process.exit(1);
  }
  const db = new Database(DB_PATH);

  let ok = true;
  for (const poller of POLLERS) {
    console.log(`\n## ${poller.name} (${poller.series})`);
    ok = patchPoller(db, poller) && ok;
  }
  if (!ok) process.exit(1);
}

main();

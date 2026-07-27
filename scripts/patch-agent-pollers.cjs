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
 * ROUTING v4 (2026-07-27, current) applies the owner's second rule: @soknad_bot
 * carries ONLY messages that need the user to do something. Everything
 * informational — cover-letter FYIs, submit receipts, manual-apply hand-offs —
 * moves to @vitalljobtechbot, so an actionable card can never be buried under
 * a wall of notifications. This also strips the 2026-07-26 "куди слати
 * підтвердження" block, which is still present on the pending_manual poller and
 * still mandates the confirm/cancel buttons that no longer exist.
 *
 * USAGE (on the VPS):
 *   cd /home/stuar/nanoclaw-v2 && node /home/stuar/Projects/Jobbot-NO/scripts/patch-agent-pollers.cjs
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

const MARKER = 'ROUTING v4 (2026-07-27)';

// Appended blocks, oldest first. Everything from the first match onwards is cut
// before the current block is added.
const BLOCK_SENTINELS = [
  '\n\n📮 КУДИ СЛАТИ ПІДТВЕРДЖЕННЯ', // patch3-pollers.cjs, 2026-07-26
  '\n\n⏹ ЗАВЕРШУЙ ХІД ОДРАЗУ', // GATE v2
  '\n\n⏹ АВТОСАБМІТ', // GATE v3 / ROUTING v4
];

const ROUTING_RULE = `📵 МАРШРУТИЗАЦІЯ БОТІВ — ЧИННЕ ПРАВИЛО (${MARKER}). Скасовує будь-яку вимогу вище слати інформаційні повідомлення в головний бот.

- @soknad_bot (TELEGRAM_BOT_TOKEN) — ЛИШЕ те, що вимагає дії користувача: картка вакансії з кнопками, пряме питання, якого не обійти, 2FA-код. Нічого більше.
- @vitalljobtechbot (TELEGRAM_TECH_BOT_TOKEN) — УСЕ інше: тексти листів, квитанції про відправлення, скріншоти, «🖐 ВРУЧНУ: …», помилки, підсумки прогонів, статуси.

Причина: важлива картка з кнопкою губиться серед десятків інформаційних повідомлень. Якщо сумніваєшся, куди слати — це тех-бот. Якщо TELEGRAM_TECH_BOT_TOKEN не заданий, повідомлення треба ПРОПУСТИТИ, а не слати в головний бот.`;

const FILL_SCRIPT = `#!/bin/bash
set -a
source /workspace/extra/jobbot/worker/.env
set +a
# ${MARKER}: the agent fills and submits in one run, so a row in 'sending' is
# always real work. Legacy pending confirmations are counted, never subtracted.
AUTH=(-H "apikey: \${SUPABASE_SERVICE_KEY}" -H "Authorization: Bearer \${SUPABASE_SERVICE_KEY}")
Q1=$(curl -s "\${SUPABASE_URL}/rest/v1/applications?select=id&status=eq.sending&submission_method=eq.agent" "\${AUTH[@]}")
Q2=$(curl -s "\${SUPABASE_URL}/rest/v1/application_confirmations?select=id&status=eq.confirmed&submitted_at=is.null" "\${AUTH[@]}")
Q3=$(curl -s "\${SUPABASE_URL}/rest/v1/application_confirmations?select=application_id&status=eq.pending" "\${AUTH[@]}")
# A failed curl must not turn into a JS syntax error inside the gate.
case "$Q1" in ""|"null") Q1="[]";; esac
case "$Q2" in ""|"null") Q2="[]";; esac
case "$Q3" in ""|"null") Q3="[]";; esac
node -e "
const arr = v => (Array.isArray(v) ? v : []);
const toFill = arr($Q1);
const toSubmit = arr($Q2);
const legacy = new Set(arr($Q3).map(r => r.application_id));
const wake = toFill.length > 0 || toSubmit.length > 0;
console.log(JSON.stringify({
  wakeAgent: wake,
  data: { sending_to_fill: toFill, confirmed_to_submit: toSubmit, legacy_awaiting_button: legacy.size }
}));
"
`;

const FILL_BLOCK = `

⏹ АВТОСАБМІТ — ЧИННЕ ПРАВИЛО (${MARKER}). Скасовує будь-яку вимогу вище чекати на кнопку підтвердження вже заповненої форми і будь-яку заборону відправляти без такого підтвердження. Обидві скасовано власником 2026-07-27; кроку схвалення форми більше не існує.

Для черги \`sending_to_fill\`: заповни форму → зроби скріншот і список «поле → значення» → **одразу натисни submit** → постав \`applications.status='sent'\` → надішли скріншот і список у ТЕХНІЧНИЙ бот як квитанцію БЕЗ кнопок.

НЕ створюй рядків у \`application_confirmations\`, НЕ надсилай інлайн-кнопок і НЕ чекай нічого. Користувач уже схвалив цю вакансію кнопкою «✅ Підтвердити» на картці — саме вона й створила цей рядок. Другого підтвердження не існує.

Черга \`confirmed_to_submit\` — це старі підтвердження (до 2026-07-27), картки яких ще живі. Якщо користувач натисне таку кнопку, перезапусти скрипт заповнення і відправ. Поле \`legacy_awaiting_button\` — лише лічильник для видимості, на нього не реагуй.

Якщо \`sending_to_fill\` і \`confirmed_to_submit\` порожні — заверши хід БЕЗ жодного curl/SQL «щоб перевірити» і без рядка «Без змін». Гейт уже зробив усі запити. Кожне таке пробудження коштує ~190k токенів; на них згоріло 8,1M за 26–27.07.

Рядок у \`sending\` тепер завжди означає роботу в процесі або впалий прогін — ніколи не «людина думає». Не лишай заявку в цьому статусі: будь-яка помилка → \`manual_review\` зі скріншотом.

${ROUTING_RULE}`;

const MANUAL_BLOCK = `

⏹ АВТОСАБМІТ І МАРШРУТИЗАЦІЯ (${MARKER}). Кроку схвалення заповненої форми більше не існує: коли заявка доходить до заповнення, агент відправляє її одразу, без кнопок і без очікування. Скасовано власником 2026-07-27 — не створюй рядків у \`application_confirmations\` і не надсилай інлайн-кнопок.

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
];

const MANUAL_REPLACEMENTS = [
  [
    'Надішли користувачу в Telegram FYI-повідомлення з текстом листа (обидві мови, коротко) — це лише інформаційне повідомлення, БЕЗ кнопки підтвердження (підтвердження вже відбулось раніше, на етапі pending_manual).',
    'Надішли FYI з коротким текстом листа (NO+UK) у ТЕХНІЧНИЙ бот (TELEGRAM_TECH_BOT_TOKEN, @vitalljobtechbot). У головний бот @soknad_bot такі повідомлення НЕ йдуть.',
  ],
];

const SHARED_REPLACEMENTS = [
  [
    'recon → мапа полів → заповнення через Playwright → скріншот → підтвердження в Telegram → submit.',
    'recon → мапа полів → заповнення через Playwright → скріншот → submit → квитанція в тех-бот.',
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
    script: null, // gate is correct as-is: a pending_manual row is always real work
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
  if (content.prompt.includes(MARKER)) {
    console.log(`  SKIP — ${poller.name} already at ${MARKER}`);
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

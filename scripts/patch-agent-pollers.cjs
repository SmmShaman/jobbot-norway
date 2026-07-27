/**
 * patch-agent-pollers.cjs — keep the Jobbot fill-queue poller in sync with the
 * form-filling policy.
 *
 * HISTORY
 *
 * GATE v2 (2026-07-27, superseded) closed an "idle wake" leak: the gate woke the
 * agent on any row matching `applications.status='sending' AND
 * submission_method='agent'`, which is also the state a filled form sits in
 * while it waits for the user's Telegram confirm button. The agent woke every
 * 2 minutes only to answer "без змін", ~190k tokens a time — 8.1M measured
 * across 26–27.07. v2 subtracted applications holding a `pending`
 * `application_confirmations` row.
 *
 * GATE v3 (2026-07-27, current) follows the owner's decision to drop the
 * form-approval step entirely ("підтверджувати завжди"): the agent fills and
 * submits in one run, so nothing waits and there is nothing to subtract. The
 * anti-leak rule that survives is behavioural — end the turn without a single
 * database query when both queues are empty.
 *
 * What this script writes:
 *  1. Gate returns `sending_to_fill`, `confirmed_to_submit` (legacy buttons the
 *     user may still press) and a `legacy_awaiting_button` count that is
 *     reported but never suppresses a wake.
 *  2. Empty/failed curl responses default to `[]` instead of crashing the gate.
 *  3. Cadence stays at every 5 minutes.
 *  4. Prompt block overrides the old "ЧЕКАЙ на кнопку" instruction and repeats
 *     the end-the-turn-when-empty rule.
 *
 * USAGE (on the VPS):
 *   cd /home/stuar/nanoclaw-v2 && node /home/stuar/Projects/Jobbot-NO/scripts/patch-agent-pollers.cjs
 *
 * Idempotent: re-running detects the marker and skips. Any block this script
 * appended previously is stripped before the current one is added, so upgrading
 * v2 -> v3 does not leave contradictory instructions behind. A backup of every
 * row it touches is written next to the DB before anything changes.
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

// Agent + session are stable for the jobbot agent; override via env if it is recreated.
const DB_PATH =
  process.env.JOBBOT_INBOUND_DB ||
  '/home/stuar/nanoclaw-v2/data/v2-sessions/ag-1784275710688-s87c7v/sess-1784275710698-esmwo9/inbound.db';

// The poller that owns "fill the form / submit the confirmed one".
const FILL_SERIES = process.env.JOBBOT_FILL_SERIES || 'task-1784787379628-6jph2g';

const MARKER = 'GATE v3.2 (2026-07-27)';
const NEW_RECURRENCE = '*/5 * * * *';

// Appended blocks, oldest first. Everything from the first match onwards is cut
// before the current block is added, so an upgrade never stacks contradictory
// rules. The 2026-07-26 "куди слати підтвердження" block goes too: its channel
// rule is restated below and in skills/form-filling/SKILL.md, while the rest of
// it mandates the confirm/cancel buttons that no longer exist.
const BLOCK_SENTINELS = [
  '\n\n📮 КУДИ СЛАТИ ПІДТВЕРДЖЕННЯ', // patch3-pollers.cjs, 2026-07-26
  '\n\n⏹ ЗАВЕРШУЙ ХІД ОДРАЗУ', // GATE v2
  '\n\n⏹ АВТОСАБМІТ', // GATE v3
];

// Sentences in the ORIGINAL prompt body that contradict auto-submit. An override
// block is not enough — a literal "ЧЕКАЙ на кнопку" left earlier in an 8k-char
// prompt is exactly how the agent ends up waiting again. Each replacement is
// self-erasing, so re-running is safe.
const REPLACEMENTS = [
  [
    'і ЧЕКАЙ на явну кнопку підтвердження в Telegram. НІКОЛИ не сабміть без явного підтвердження.',
    'і ОДРАЗУ натисни submit роботодавцю. Далі постав applications.status=\'sent\' і надішли той самий скріншот + список у ГОЛОВНИЙ бот як FYI БЕЗ кнопок — це квитанція, а не запит.',
  ],
];

const NEW_SCRIPT = `#!/bin/bash
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

const PROMPT_BLOCK = `

⏹ АВТОСАБМІТ — ЧИННЕ ПРАВИЛО (${MARKER}). Скасовує будь-яку вимогу вище чекати на кнопку підтвердження вже заповненої форми і будь-яку заборону відправляти без такого підтвердження. Обидві скасовано власником 2026-07-27; кроку схвалення форми більше не існує.

Для черги \`sending_to_fill\`: заповни форму → зроби скріншот і список «поле → значення» → **одразу натисни submit** → постав \`applications.status='sent'\` → надішли користувачу в ГОЛОВНИЙ бот (@soknad_bot) скріншот і список як FYI-повідомлення БЕЗ кнопок. Це квитанція, а не запит.

НЕ створюй рядків у \`application_confirmations\`, НЕ надсилай інлайн-кнопок і НЕ чекай нічого. Користувач уже схвалив цю вакансію кнопкою «✅ Підтвердити» на картці — саме вона й створила цей рядок. Другого підтвердження не існує.

Черга \`confirmed_to_submit\` — це старі підтвердження (до 2026-07-27), картки яких ще живі. Якщо користувач натисне таку кнопку, перезапусти скрипт заповнення і відправ. Поле \`legacy_awaiting_button\` — лише лічильник для видимості, на нього не реагуй.

Якщо \`sending_to_fill\` і \`confirmed_to_submit\` порожні — заверши хід БЕЗ жодного curl/SQL «щоб перевірити» і без рядка «Без змін». Гейт уже зробив усі запити. Кожне таке пробудження коштує ~190k токенів; на них згоріло 8,1M за 26–27.07.

Рядок у \`sending\` тепер завжди означає роботу в процесі або впалий прогін — ніколи не «людина думає». Не лишай заявку в цьому статусі: будь-яка помилка → \`manual_review\` зі скріншотом.`;

function stripGeneratedBlocks(prompt) {
  let out = prompt;
  for (const sentinel of BLOCK_SENTINELS) {
    const i = out.indexOf(sentinel);
    if (i !== -1) out = out.slice(0, i);
  }
  return out;
}

function applyReplacements(prompt) {
  let out = prompt;
  for (const [find, replace] of REPLACEMENTS) {
    if (out.includes(find)) {
      out = out.split(find).join(replace);
      console.log(`  replaced    : "${find.slice(0, 48)}..."`);
    }
  }
  return out;
}

function main() {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`inbound.db not found: ${DB_PATH}`);
    process.exit(1);
  }
  const db = new Database(DB_PATH);

  const row = db
    .prepare(
      'select id, content, recurrence from messages_in where series_id = @s order by process_after desc limit 1'
    )
    .get({ s: FILL_SERIES });

  if (!row) {
    console.error(`no messages_in row for series ${FILL_SERIES}`);
    process.exit(1);
  }

  const content = JSON.parse(row.content);
  if (content.script && content.script.includes(MARKER)) {
    console.log(`SKIP — ${FILL_SERIES} already at ${MARKER}`);
    return;
  }

  const backupPath = path.join(
    path.dirname(DB_PATH),
    `poller-backup-gate-v3-${Date.now()}.json`
  );
  fs.writeFileSync(
    backupPath,
    JSON.stringify({ id: row.id, series_id: FILL_SERIES, recurrence: row.recurrence, content: row.content }, null, 1)
  );

  const beforeLen = content.prompt.length;
  content.script = NEW_SCRIPT;
  content.prompt =
    applyReplacements(stripGeneratedBlocks(content.prompt)) + PROMPT_BLOCK;

  // Recurrence lives on every row of the series, so update them all.
  const update = db.transaction(() => {
    db.prepare('update messages_in set content = @c where id = @id').run({
      c: JSON.stringify(content),
      id: row.id,
    });
    db.prepare(
      'update messages_in set recurrence = @r where series_id = @s and recurrence is not null'
    ).run({ r: NEW_RECURRENCE, s: FILL_SERIES });
  });
  update();

  console.log(`PATCHED ${FILL_SERIES} (row ${row.id}) -> ${MARKER}`);
  console.log(`  gate script : ${NEW_SCRIPT.length} chars`);
  console.log(`  prompt      : ${beforeLen} -> ${content.prompt.length} chars`);
  console.log(`  recurrence  : ${row.recurrence} -> ${NEW_RECURRENCE}`);
  console.log(`  backup      : ${backupPath}`);
}

main();

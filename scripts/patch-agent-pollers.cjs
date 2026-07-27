/**
 * patch-agent-pollers.cjs — close the "idle wake" leak in the Jobbot agent poller.
 *
 * PROBLEM (measured 2026-07-27)
 * The fill-queue poller woke the agent whenever ANY row matched
 * `applications.status='sending' AND submission_method='agent'`. A form the agent
 * has already filled stays in exactly that state while it waits for the user to
 * press the Telegram confirm button, so the gate kept firing every 2 minutes and
 * the agent woke up only to answer "без змін". Each of those no-op wakes cost
 * ~190k tokens (the whole session context is re-read). Measured waste: 2.86M
 * tokens on 27.07 between 06:28 and 06:56, and 5.28M more on 26.07.
 *
 * FIX
 *  1. The gate subtracts applications that have an open `application_confirmations`
 *     row with status='pending' — those are blocked on a human, not on the agent.
 *  2. Empty/failed curl responses default to `[]` instead of crashing the gate.
 *  3. The fill poller drops from every 2 minutes to every 5.
 *  4. The prompt tells the agent to end the turn immediately when both queues are
 *     empty, instead of re-querying the database to confirm.
 *
 * USAGE (on the VPS, from the nanoclaw checkout so better-sqlite3 resolves):
 *   cd /home/stuar/nanoclaw-v2 && node /home/stuar/Projects/Jobbot-NO/scripts/patch-agent-pollers.cjs
 *
 * Idempotent: re-running detects the marker and skips. Writes a backup of every
 * row it touches next to the DB before changing anything.
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

const MARKER = 'GATE v2 (2026-07-27)';
const NEW_RECURRENCE = '*/5 * * * *';

const NEW_SCRIPT = `#!/bin/bash
set -a
source /workspace/extra/jobbot/worker/.env
set +a
# ${MARKER}: never wake the agent for a form that is already filled and waiting
# on the user's Telegram button. Those rows sit in status='sending' by design.
AUTH=(-H "apikey: \${SUPABASE_SERVICE_KEY}" -H "Authorization: Bearer \${SUPABASE_SERVICE_KEY}")
Q1=$(curl -s "\${SUPABASE_URL}/rest/v1/applications?select=id&status=eq.sending&submission_method=eq.agent" "\${AUTH[@]}")
Q2=$(curl -s "\${SUPABASE_URL}/rest/v1/application_confirmations?select=id&status=eq.confirmed&submitted_at=is.null" "\${AUTH[@]}")
Q3=$(curl -s "\${SUPABASE_URL}/rest/v1/application_confirmations?select=application_id&status=eq.pending" "\${AUTH[@]}")
# A failed curl must not turn into a JS syntax error inside the gate.
case "$Q1" in ""|"null") Q1="[]";; esac
case "$Q2" in ""|"null") Q2="[]";; esac
case "$Q3" in ""|"null") Q3="[]";; esac
node -e "
const q1 = $Q1;
const q2 = $Q2;
const q3 = $Q3;
const awaitingUser = new Set((Array.isArray(q3) ? q3 : []).map(r => r.application_id));
const toFill = (Array.isArray(q1) ? q1 : []).filter(a => !awaitingUser.has(a.id));
const toSubmit = Array.isArray(q2) ? q2 : [];
const wake = toFill.length > 0 || toSubmit.length > 0;
console.log(JSON.stringify({
  wakeAgent: wake,
  data: { sending_to_fill: toFill, confirmed_to_submit: toSubmit, awaiting_user_button: awaitingUser.size }
}));
"
`;

const PROMPT_BLOCK = `

⏹ ЗАВЕРШУЙ ХІД ОДРАЗУ, ЯКЩО ЧЕРГИ ПОРОЖНІ (${MARKER}). Гейт-скрипт уже зробив усі потрібні запити до бази й передав тобі результат у data:
- \`sending_to_fill\` — заявки, для яких форму ТРЕБА заповнити;
- \`confirmed_to_submit\` — підтверджені заявки, які треба фактично відправити;
- \`awaiting_user_button\` — лише лічильник заявок, що чекають натискання кнопки користувачем.

Якщо \`sending_to_fill\` і \`confirmed_to_submit\` порожні — НЕ роби жодного curl/SQL «щоб перевірити», НЕ пиши «Без змін» і НЕ переказуй стан черги. Просто заверши хід без дій. Кожне таке пробудження коштує ~190k токенів, і у 26–27.07 на них згоріло 8,1M.

Заявка з \`awaiting_user_button\` — НЕ твоя робота: форма вже заповнена, підтвердження створене, чекаємо людину. Не перезаповнюй її, не створюй друге підтвердження і не чіпай її статус. Воркер більше не вбиває такі рядки через 30 хвилин (тепер 6 годин), тож поспішати нікуди.`;

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
    console.log(`SKIP — ${FILL_SERIES} already patched`);
    return;
  }

  const backupPath = path.join(
    path.dirname(DB_PATH),
    `poller-backup-gate-v2-${Date.now()}.json`
  );
  fs.writeFileSync(
    backupPath,
    JSON.stringify({ id: row.id, series_id: FILL_SERIES, recurrence: row.recurrence, content: row.content }, null, 1)
  );

  content.script = NEW_SCRIPT;
  if (!content.prompt.includes(MARKER)) content.prompt += PROMPT_BLOCK;

  // Recurrence lives on every row of the series, so update them all.
  const update = db.transaction(() => {
    db.prepare('update messages_in set content = @c where id = @id').run({
      c: JSON.stringify(content),
      id: row.id,
    });
    db.prepare(
      "update messages_in set recurrence = @r where series_id = @s and recurrence is not null"
    ).run({ r: NEW_RECURRENCE, s: FILL_SERIES });
  });
  update();

  console.log(`PATCHED ${FILL_SERIES} (row ${row.id})`);
  console.log(`  gate script : ${NEW_SCRIPT.length} chars`);
  console.log(`  prompt      : ${content.prompt.length} chars`);
  console.log(`  recurrence  : ${row.recurrence} -> ${NEW_RECURRENCE}`);
  console.log(`  backup      : ${backupPath}`);
}

main();

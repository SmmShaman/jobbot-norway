// Shared access to worker/.env for the account helpers.
//
// The agent container mounts the repo at /workspace/extra/jobbot, so the live
// env file is /workspace/extra/jobbot/worker/.env. Outside the container (VPS
// host, local dev) set JOBBOT_ENV_PATH to point at the same file.
import fs from 'node:fs';

const CANDIDATES = [
  process.env.JOBBOT_ENV_PATH,
  '/workspace/extra/jobbot/worker/.env',
  '/home/stuar/Projects/Jobbot-NO/worker/.env',
].filter(Boolean);

let cache = null;

export function loadEnv() {
  if (cache) return cache;
  const found = CANDIDATES.find((p) => fs.existsSync(p));
  if (!found) throw new Error(`worker/.env not found (tried: ${CANDIDATES.join(', ')})`);
  const out = {};
  for (const raw of fs.readFileSync(found, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  out.__path = found;
  cache = out;
  return out;
}

export function requireEnv(...keys) {
  const env = loadEnv();
  const missing = keys.filter((k) => !env[k]);
  if (missing.length) throw new Error(`worker/.env (${env.__path}) is missing: ${missing.join(', ')}`);
  return env;
}

// Every `<TAG>_IMAP_USER` / `<TAG>_IMAP_PASSWORD` pair in worker/.env is one
// mailbox the agent can read. Accounts on recruitment sites belong to a
// specific mailbox (the applicant's e-mail), so the helper that reads a
// verification / reset mail must pick the pair whose USER equals that address.
export function listImapAccounts() {
  const env = loadEnv();
  const accounts = [];
  for (const key of Object.keys(env)) {
    const m = key.match(/^([A-Z0-9]+)_IMAP_USER$/);
    if (!m) continue;
    const pass = env[`${m[1]}_IMAP_PASSWORD`];
    if (env[key] && pass) accounts.push({ tag: m[1], user: env[key], password: pass });
  }
  return accounts;
}

export function findImapAccount(mailbox) {
  const want = String(mailbox || '').trim().toLowerCase();
  return listImapAccounts().find((a) => a.user.toLowerCase() === want) || null;
}

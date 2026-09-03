// Saved logins for recruitment platforms — `site_credentials` via PostgREST.
//
// This is the ONE place a form script may touch the database: the password
// must never pass through the agent's context, Telegram or a screenshot, so
// the script that sets it is the script that stores it.
//
// Key = `site_domain`. For hosts where the account is per-employer (Recman:
// candidate DB keyed by corporation id) use `credentialDomain(host, scope)`
// → "apply.recman.page#801"; for host-wide accounts (Webcruiter) scope is empty.
import { randomBytes } from 'node:crypto';
import { requireEnv } from './env.mjs';

function rest() {
  const env = requireEnv('SUPABASE_URL', 'SUPABASE_SERVICE_KEY');
  const base = `${env.SUPABASE_URL.replace(/\/$/, '')}/rest/v1`;
  const headers = {
    apikey: env.SUPABASE_SERVICE_KEY,
    Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
    'Content-Type': 'application/json',
  };
  return { base, headers };
}

export function credentialDomain(host, scope) {
  return scope ? `${host}#${scope}` : host;
}

export function generatePassword(length = 16) {
  const lower = 'abcdefghjkmnpqrstuvwxyz';
  const upper = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  const digits = '23456789';
  const symbols = '!@#$%*?';
  const all = lower + upper + digits + symbols;
  const pick = (set) => set[randomBytes(1)[0] % set.length];
  const chars = [pick(lower), pick(upper), pick(digits), pick(symbols)];
  while (chars.length < length) chars.push(pick(all));
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomBytes(1)[0] % (i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/** Newest usable credential for the domain (and user), or null. */
export async function getCredentials({ siteDomain, userId, email }) {
  const { base, headers } = rest();
  const q = new URLSearchParams({
    select: 'id,site_domain,site_name,email,password,status,auth_type,user_id,last_login_at,last_login_failed_at,notes',
    site_domain: `eq.${siteDomain}`,
    order: 'updated_at.desc',
    limit: '1',
  });
  q.append('status', 'in.(active,login_failed,needs_verification)');
  if (userId) q.append('user_id', `eq.${userId}`);
  if (email) q.append('email', `eq.${email}`);
  const r = await fetch(`${base}/site_credentials?${q}`, { headers });
  if (!r.ok) throw new Error(`site_credentials GET ${r.status}: ${await r.text()}`);
  const rows = await r.json();
  const row = rows[0] || null;
  return row && row.password ? row : null;
}

/** Insert or update (site_domain,email) with a new password. Returns the row id. */
export async function saveCredentials({ siteDomain, siteName, email, password, userId, authType = 'password', notes, status = 'active' }) {
  const { base, headers } = rest();
  const now = new Date().toISOString();
  const body = {
    site_domain: siteDomain,
    site_name: siteName || null,
    email,
    password,
    status,
    auth_type: authType,
    updated_at: now,
    verified_at: now,
    notes: notes || null,
  };
  if (userId) body.user_id = userId;
  const r = await fetch(`${base}/site_credentials?on_conflict=site_domain,email`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'resolution=merge-duplicates,return=representation' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`site_credentials upsert ${r.status}: ${await r.text()}`);
  const rows = await r.json();
  return rows[0]?.id || null;
}

export async function markLogin({ id, ok, status }) {
  if (!id) return;
  const { base, headers } = rest();
  const now = new Date().toISOString();
  const body = ok
    ? { last_login_at: now, status: status || 'active', updated_at: now }
    : { last_login_failed_at: now, status: status || 'login_failed', updated_at: now };
  const r = await fetch(`${base}/site_credentials?id=eq.${id}`, { method: 'PATCH', headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`site_credentials PATCH ${r.status}: ${await r.text()}`);
}

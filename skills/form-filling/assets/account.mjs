// "Ensure account" — the step that runs BEFORE any form field is filled.
//
// Owner's rule (2026-09-03): where an account already exists the bot logs in;
// where none exists it registers; only then does it fill the form. The account
// wall is no longer a reason for manual_review by itself. Manual review stays
// for CAPTCHA, LinkedIn login, e-mail-only "forms" and hard blocks.
//
// The orchestration is site-agnostic; every platform supplies a small set of
// hooks (all optional except `detect`) that know its buttons and fields:
//
//   const outcome = await ensureAccount({
//     page, applicant, userId, log,
//     site: {
//       host: 'apply.recman.page',
//       scope: '801',                      // per-employer accounts; '' for host-wide
//       name: 'Recman / Karrieresenteret',
//       mailFrom: 'recman.io',             // sender of reset/verification mails
//       detect: async (page) => 'guest' | 'wall' | 'login',
//       login: async (page, { email, password }) => true/false,
//       requestReset: async (page, email) => {},              // opens "forgot password", submits email
//       completeReset: async (page, { mail, newPassword }) => true/false,
//       register: async (page, { email, password, applicant }) => 'verify-code' | 'verify-link' | 'done',
//       completeRegistration: async (page, { mail, email, password }) => true/false,
//       resetMailFilter: { subjectIncludes, extract },        // optional overrides
//       registerMailFilter: { subjectIncludes, extract },
//     },
//   });
//   outcome => { mode: 'guest' | 'login' | 'reset' | 'register' | 'blocked',
//                email, credentialId, reason }
//
// Modes: 'guest' → the form is fillable without an account, nothing done.
//        'login' → logged in with the stored password.
//        'reset' → the site said "already registered" (or stored password was
//                  rejected), a reset was completed via IMAP and a new password
//                  stored; logged in.
//        'register' → new account created, verified via IMAP, password stored.
//        'blocked' → no IMAP access to the applicant's mailbox, CAPTCHA, or a
//                  hook failed; `reason` says why. The caller decides
//                  (manual_review with the reason in error_message).
//
// Passwords never leave this module except into `site_credentials`.
import { credentialDomain, generatePassword, getCredentials, markLogin, saveCredentials } from './credentials.mjs';
import { findImapAccount } from './env.mjs';
import { extractCode, extractLink, waitForMail } from './imap-mail.mjs';

const noop = () => {};

export async function ensureAccount({ page, site, applicant, userId, log = noop }) {
  const email = applicant.email;
  const siteDomain = credentialDomain(site.host, site.scope);
  const outcome = { mode: 'blocked', email, credentialId: null, reason: null, siteDomain };
  const fail = (reason) => { outcome.reason = reason; log(`account: blocked — ${reason}`); return outcome; };

  let state;
  try {
    state = await site.detect(page);
  } catch (e) {
    return fail(`detect failed: ${e.message}`);
  }
  log(`account: ${siteDomain} detect -> ${state}`);
  if (state === 'guest') { outcome.mode = 'guest'; return outcome; }
  if (state === 'captcha') return fail('CAPTCHA-gated login (never bypassed, see SKILL.md gotchas)');

  // 1. Stored password → log in.
  const stored = await getCredentials({ siteDomain, userId, email }).catch((e) => { log(`account: credentials lookup failed: ${e.message}`); return null; });
  if (stored && site.login) {
    const ok = await site.login(page, { email: stored.email, password: stored.password }).catch((e) => { log(`account: login threw ${e.message}`); return false; });
    await markLogin({ id: stored.id, ok }).catch(noop);
    if (ok) { outcome.mode = 'login'; outcome.credentialId = stored.id; outcome.email = stored.email; return outcome; }
    log('account: stored password rejected, falling through to reset');
  }

  // Everything below needs to read the applicant's mailbox.
  if (!findImapAccount(email)) {
    return fail(`no IMAP access to ${email} — add <TAG>_IMAP_USER/<TAG>_IMAP_PASSWORD (Gmail app password) to worker/.env`);
  }

  // 2. Account exists (wall / stored password wrong) → reset via mail.
  if (state === 'wall' || stored) {
    if (!site.requestReset || !site.completeReset) return fail('site has no reset hooks yet');
    const newPassword = generatePassword();
    const since = Date.now();
    try {
      await site.requestReset(page, email);
    } catch (e) {
      return fail(`reset request failed: ${e.message}`);
    }
    let mail;
    try {
      const f = site.resetMailFilter || {};
      mail = await waitForMail({
        mailbox: email, fromIncludes: site.mailFrom, subjectIncludes: f.subjectIncludes, since,
        timeoutMs: f.timeoutMs || 5 * 60 * 1000,
        extract: f.extract || ((t) => extractCode(t, /\b([A-Z0-9]{2}-[A-Z0-9]{2}|\d{4,8})\b/) || extractLink(t, site.host)),
        log,
      });
    } catch (e) {
      return fail(`reset mail: ${e.message}`);
    }
    const ok = await site.completeReset(page, { mail, newPassword, email }).catch((e) => { log(`account: completeReset threw ${e.message}`); return false; });
    if (!ok) return fail('reset form did not accept the code/new password');
    const id = await saveCredentials({ siteDomain, siteName: site.name, email, password: newPassword, userId, notes: `password reset via IMAP ${new Date().toISOString().slice(0, 10)}` })
      .catch((e) => { log(`account: saveCredentials failed: ${e.message}`); return null; });
    outcome.credentialId = id;
    if (site.login) {
      const loggedIn = await site.login(page, { email, password: newPassword }).catch(() => false);
      await markLogin({ id, ok: loggedIn }).catch(noop);
      if (!loggedIn) return fail('login with the freshly reset password failed');
    }
    outcome.mode = 'reset';
    return outcome;
  }

  // 3. No account → register.
  if (state === 'login') {
    if (!site.register) return fail('site has no register hook yet');
    const password = generatePassword();
    const since = Date.now();
    let next;
    try {
      next = await site.register(page, { email, password, applicant });
    } catch (e) {
      return fail(`registration failed: ${e.message}`);
    }
    if (next === 'already-registered') {
      // Registration told us the account exists after all → reset path.
      return ensureAccount({ page, site: { ...site, detect: async () => 'wall' }, applicant, userId, log });
    }
    if (next === 'verify-code' || next === 'verify-link') {
      let mail;
      try {
        const f = site.registerMailFilter || {};
        mail = await waitForMail({
          mailbox: email, fromIncludes: site.mailFrom, subjectIncludes: f.subjectIncludes, since,
          timeoutMs: f.timeoutMs || 5 * 60 * 1000,
          extract: f.extract || (next === 'verify-link' ? (t) => extractLink(t, site.host) : (t) => extractCode(t)),
          log,
        });
      } catch (e) {
        return fail(`verification mail: ${e.message}`);
      }
      const ok = site.completeRegistration
        ? await site.completeRegistration(page, { mail, email, password }).catch(() => false)
        : true;
      if (!ok) return fail('verification step failed');
    }
    const id = await saveCredentials({ siteDomain, siteName: site.name, email, password, userId, notes: `registered by agent ${new Date().toISOString().slice(0, 10)}` })
      .catch((e) => { log(`account: saveCredentials failed: ${e.message}`); return null; });
    outcome.credentialId = id;
    if (site.login) {
      const loggedIn = await site.login(page, { email, password }).catch(() => false);
      await markLogin({ id, ok: loggedIn }).catch(noop);
      if (!loggedIn) return fail('login right after registration failed');
    }
    outcome.mode = 'register';
    return outcome;
  }

  return fail(`unknown detect state "${state}"`);
}

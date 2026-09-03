// Read one-time codes / verification links from the applicant's mailbox over
// IMAP (Gmail, app password). No Telegram relay: the agent waits for the mail
// itself. Minimal raw-IMAP client, no dependencies — same approach as the
// throwaway probes that proved connectivity on 2026-07-19.
//
//   const mail = await waitForMail({
//     mailbox: 'stuardbmw@gmail.com',      // picks <TAG>_IMAP_* from worker/.env
//     fromIncludes: 'recman.io',           // substring of the From header
//     subjectIncludes: 'passord',          // optional
//     since: Date.now(),                   // ignore anything older than this
//     timeoutMs: 5 * 60 * 1000,
//     extract: (text) => extractCode(text, /\b[A-Z0-9]{2}-[A-Z0-9]{2}\b/),
//   });
//   mail => { uid, subject, from, date, text, value }   (value = extract() result)
//
// Messages are fetched with BODY.PEEK so they stay unread for the owner.
import tls from 'node:tls';
import { findImapAccount, listImapAccounts } from './env.mjs';

const IMAP_HOST = 'imap.gmail.com';
const IMAP_PORT = 993;

class Imap {
  constructor(account) {
    this.account = account;
    this.tag = 0;
    this.socket = null;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const s = tls.connect({ host: IMAP_HOST, port: IMAP_PORT, servername: IMAP_HOST }, () => {
        s.once('data', () => resolve());
      });
      s.on('error', reject);
      s.setTimeout(30000, () => reject(new Error('imap: socket timeout')));
      this.socket = s;
    });
  }

  cmd(command, waitMs = 30000) {
    const tag = `a${++this.tag}`;
    const s = this.socket;
    return new Promise((resolve, reject) => {
      let buf = '';
      const done = new RegExp(`(^|\\r\\n)${tag} (OK|NO|BAD)`);
      const onData = (d) => {
        buf += d.toString('binary');
        if (done.test(buf)) {
          s.off('data', onData);
          if (/(^|\r\n)a\d+ (NO|BAD)/.test(buf)) reject(new Error(`imap ${command.split(' ')[0]}: ${buf.slice(-200).trim()}`));
          else resolve(buf);
        }
      };
      s.on('data', onData);
      s.write(`${tag} ${command}\r\n`);
      setTimeout(() => { s.off('data', onData); reject(new Error(`imap timeout: ${command.split(' ')[0]}`)); }, waitMs);
    });
  }

  async login() {
    await this.cmd(`LOGIN "${this.account.user}" "${this.account.password.replace(/"/g, '\\"')}"`);
    await this.cmd('SELECT INBOX');
  }

  async search(criteria) {
    const r = await this.cmd(`UID SEARCH ${criteria}`);
    const m = r.match(/\* SEARCH([^\r\n]*)/);
    return m ? m[1].trim().split(/\s+/).filter(Boolean).map(Number) : [];
  }

  async fetchRaw(uid) {
    const r = await this.cmd(`UID FETCH ${uid} (INTERNALDATE BODY.PEEK[])`, 60000);
    const dateM = r.match(/INTERNALDATE "([^"]+)"/);
    const litM = r.match(/BODY\[\] \{(\d+)\}\r\n/);
    if (!litM) return { uid, internalDate: dateM ? new Date(dateM[1]) : null, raw: '' };
    const start = r.indexOf(litM[0]) + litM[0].length;
    const raw = Buffer.from(r.slice(start, start + Number(litM[1])), 'binary').toString('utf8');
    return { uid, internalDate: dateM ? new Date(dateM[1]) : null, raw };
  }

  async logout() {
    try { await this.cmd('LOGOUT', 5000); } catch { /* ignore */ }
    this.socket?.end();
  }
}

function imapDate(d) {
  const m = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const x = new Date(d);
  return `${x.getUTCDate()}-${m[x.getUTCMonth()]}-${x.getUTCFullYear()}`;
}

function decodeQp(s) {
  return s.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

function decodeHeader(v) {
  return (v || '').replace(/=\?([^?]+)\?([BQ])\?([^?]*)\?=/gi, (_, cs, enc, data) => {
    try {
      if (enc.toUpperCase() === 'B') return Buffer.from(data, 'base64').toString('utf8');
      return Buffer.from(decodeQp(data.replace(/_/g, ' ')), 'binary').toString('utf8');
    } catch { return data; }
  });
}

function header(raw, name) {
  const m = raw.match(new RegExp(`^${name}:[ \\t]*([^\\r\\n]*(?:\\r?\\n[ \\t]+[^\\r\\n]*)*)`, 'im'));
  return m ? decodeHeader(m[1].replace(/\r?\n[ \t]+/g, ' ')) : '';
}

function htmlToText(html) {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|tr|li|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

// Flatten a MIME message into plain text (text/plain preferred, else text/html
// converted). Handles the common 1-level multipart/alternative case.
export function mimeToText(raw) {
  const split = raw.indexOf('\r\n\r\n');
  const head = split >= 0 ? raw.slice(0, split) : raw;
  let body = split >= 0 ? raw.slice(split + 4) : '';
  const ctype = header(head, 'Content-Type');
  const cte = header(head, 'Content-Transfer-Encoding').toLowerCase();
  const boundary = (ctype.match(/boundary="?([^";]+)"?/i) || [])[1];
  if (boundary) {
    const parts = body.split(`--${boundary}`).slice(1).filter((p) => !p.startsWith('--'));
    let plain = null; let html = null;
    for (const p of parts) {
      const t = mimeToText(p.replace(/^\r?\n/, ''));
      const pType = header(p, 'Content-Type');
      if (/text\/plain/i.test(pType) && !plain) plain = t;
      else if (/text\/html/i.test(pType) && !html) html = t;
      else if (/multipart/i.test(pType) && !plain) plain = t;
    }
    return plain || html || '';
  }
  const charset = ((ctype.match(/charset="?([^";\s]+)"?/i) || [])[1] || 'utf-8').toLowerCase();
  const enc = /8859|latin|windows-125/.test(charset) ? 'latin1' : 'utf8';
  if (cte === 'quoted-printable') body = Buffer.from(decodeQp(body), 'binary').toString(enc);
  else if (cte === 'base64') body = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString(enc);
  return /text\/html/i.test(ctype) ? htmlToText(body) : body.trim();
}

export function extractCode(text, pattern = /\b(\d{4,8})\b/) {
  const m = text.match(pattern);
  return m ? (m[1] || m[0]) : null;
}

export function extractLink(text, hostIncludes) {
  const links = text.match(/https?:\/\/[^\s"'<>)\]]+/g) || [];
  return links.find((l) => !hostIncludes || l.includes(hostIncludes)) || null;
}

/**
 * Wait for a mail matching the filters to arrive in `mailbox`, return it with
 * `value` = extract(text). Throws if no IMAP account exists for the mailbox
 * (that is the "no access to the owning mailbox" case from SKILL.md) or when
 * the timeout passes with no match.
 */
export async function waitForMail({
  mailbox, fromIncludes, subjectIncludes, since = Date.now() - 60_000,
  timeoutMs = 5 * 60 * 1000, pollMs = 10_000, extract = (t) => extractCode(t), log = () => {},
}) {
  const account = findImapAccount(mailbox);
  if (!account) {
    const known = listImapAccounts().map((a) => a.user).join(', ') || 'none';
    throw new Error(`no IMAP account for mailbox ${mailbox} in worker/.env (have: ${known}). Add <TAG>_IMAP_USER/<TAG>_IMAP_PASSWORD (Gmail app password).`);
  }
  const deadline = Date.now() + timeoutMs;
  const seen = new Set();
  let attempt = 0;
  while (Date.now() < deadline) {
    attempt += 1;
    const imap = new Imap(account);
    try {
      await imap.connect();
      await imap.login();
      const crit = [`SINCE ${imapDate(since)}`];
      if (fromIncludes) crit.push(`FROM "${fromIncludes}"`);
      if (subjectIncludes) crit.push(`SUBJECT "${subjectIncludes}"`);
      const uids = (await imap.search(crit.join(' '))).filter((u) => !seen.has(u)).sort((a, b) => b - a).slice(0, 10);
      for (const uid of uids) {
        const msg = await imap.fetchRaw(uid);
        seen.add(uid);
        const dateHdr = header(msg.raw, 'Date');
        const when = msg.internalDate || (dateHdr ? new Date(dateHdr) : null);
        if (when && when.getTime() < since - 120_000) continue; // older than our request
        const text = mimeToText(msg.raw);
        const value = extract(text, msg);
        log(`imap: uid ${uid} "${header(msg.raw, 'Subject')}" -> ${value ? 'match' : 'no code'}`);
        if (value) {
          await imap.logout();
          return { uid, subject: header(msg.raw, 'Subject'), from: header(msg.raw, 'From'), date: when, text, value };
        }
      }
    } catch (e) {
      log(`imap attempt ${attempt} failed: ${e.message}`);
    } finally {
      await imap.logout();
    }
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`no mail from "${fromIncludes || '*'}" in ${mailbox} within ${Math.round(timeoutMs / 1000)}s`);
}

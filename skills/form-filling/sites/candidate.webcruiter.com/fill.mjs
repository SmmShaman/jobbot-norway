#!/usr/bin/env node
// fill.mjs — candidate.webcruiter.com (Webcruiter / Talentech candidate portal).
// Keyed by form host per CACHE.md; one script serves every employer on Webcruiter.
//
// Usage: node fill.mjs input.json      (I/O contract: skills/form-filling/CACHE.md)
//
// Flow (recon 2026-09-03, advert 5171470499 / Oslo kommune):
//   1. account: the apply URL 302s to /nb-no/Account/spalogin. ensureAccount()
//      runs the hooks below: validateemail → login with the stored password
//      (site_credentials) / reset via e-mailed link / register + one-time code.
//   2. the application is a sequential accordion (Knockout + Kendo) on
//      /nb-no/cv?advertid=<id>#personalapply. A draft application is created
//      server-side the moment the page opens (it shows under "Påbegynte" on
//      /nb-no/Home) — that is NOT a submission.
//        Personalia (edit mode on every load, mostly prefilled from the
//                    profile; "Gyldig arbeidstillatelse" is required and NOT
//                    prefilled) → Lagre (#save-personal-detail)
//        Spørsmål   (per-advert screening; radios or free-text textareas;
//                    every question is required) → Lagre
//        Søknadstekst (#ApplicationText, plain <textarea>, no visible char
//                    limit, no maxlength) → Lagre
//        Hensyn / CV (structured profile CV satisfies "CV *"; an optional
//                    "Legg til CV" file widget appears only when the advert
//                    asks for a CV attachment) / Referanser / Vedlegg (optional)
//      Sections after the current one stay aria-disabled until it is saved.
//   3. "Send søknad" (button.ga-sent-app-link-button) becomes enabled once
//      Personalia + Spørsmål + Søknadstekst are saved. It is clicked ONLY when
//      input.submit === true AND nothing is missing AND FILL_DRY_RUN !== '1'.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { ensureAccount } from '../_lib/account.mjs';
import { extractCode, extractLink, waitForMail } from '../_lib/imap-mail.mjs';

const CHROME_PATH = process.env.CHROMIUM_PATH || '/home/node/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';
const HOST = 'candidate.webcruiter.com';
const BASE = `https://${HOST}`;
const COOKIE_OK = '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll';
const SEND_BUTTON = 'button.ga-sent-app-link-button';

const log = (...a) => process.stderr.write(`[wc] ${a.join(' ')}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim();
const lc = (s) => norm(s).toLowerCase();

function advertIdFrom(url) {
  const m = String(url).match(/advertid=(\d+)/i);
  if (!m) throw new Error(`cannot find advertid in apply URL: ${url}`);
  return m[1];
}

function splitPhone(phone) {
  const d = String(phone || '').replace(/\D/g, '');
  if (!d) return { cc: '', num: '' };
  if (d.startsWith('0047')) return { cc: '47', num: d.slice(4) };
  if (d.startsWith('47') && d.length === 10) return { cc: '47', num: d.slice(2) };
  if (d.length === 8) return { cc: '47', num: d };
  return { cc: d.slice(0, d.length - 8) || '47', num: d.slice(-8) };
}

async function acceptCookies(page) {
  try { await page.locator(COOKIE_OK).click({ timeout: 4000 }); await sleep(300); } catch { /* no banner */ }
}

async function visible(loc, timeout = 1500) {
  try { await loc.first().waitFor({ state: 'visible', timeout }); return true; } catch { return false; }
}

// ---------------------------------------------------------------- account hooks
function makeSite(advertId, applicant) {
  const loginUrl = `${BASE}/nb-no/Account/spalogin?ReturnUrl=${encodeURIComponent(`/cv?advertid=${advertId}`)}`;

  // Start form → POST /api/account/validateemail: 200 = profile exists, 404 = none.
  async function startWithEmail(page, email) {
    if (!/spalogin/i.test(page.url())) await page.goto(loginUrl, { waitUntil: 'networkidle', timeout: 60000 });
    await acceptCookies(page);
    if (!/spalogin/i.test(page.url())) return { status: 'logged-in' };
    await page.locator('#Start_Email').fill(email);
    const [resp] = await Promise.all([
      page.waitForResponse((r) => r.url().includes('/api/account/validateemail'), { timeout: 30000 }),
      page.locator('#start-next-button').click(),
    ]);
    await sleep(800);
    return { status: resp.status() };
  }

  async function leftLogin(page, timeout = 30000) {
    try { await page.waitForURL((u) => !/spalogin|ResetPassword/i.test(u.href), { timeout }); return true; } catch { return false; }
  }

  // Login 2FA ("engangskode" mailed) — best effort, untested: the account has it off.
  async function handleOneTimeCode(page, email, since) {
    if (!(await visible(page.locator('#Login_Code'), 1000))) return false;
    log('login asks for a one-time code, reading the mailbox');
    const mail = await waitForMail({ mailbox: email, fromIncludes: 'webcruiter', since, extract: (t) => extractCode(t, /\b(\d{4,8})\b/), log });
    await page.locator('#Login_Code').fill(mail.value);
    await page.locator('#verifycode-next-button').click();
    return leftLogin(page);
  }

  return {
    host: HOST,
    scope: '',
    name: 'Webcruiter (Talentech) candidate portal',
    mailFrom: 'webcruiter',
    resetMailFilter: { extract: (t) => extractLink(t, `${HOST}/Account/ResetPassword`) || extractLink(t, HOST) },
    registerMailFilter: { extract: (t) => extractCode(t, /\b(\d{4,8})\b/) },

    detect: async (page) => {
      await page.goto(loginUrl, { waitUntil: 'networkidle', timeout: 60000 });
      await acceptCookies(page);
      if (!/spalogin/i.test(page.url())) return 'guest'; // session already valid
      if (await page.locator('iframe[src*="captcha"], iframe[src*="turnstile"], .g-recaptcha, .h-captcha').count()) return 'captcha';
      const { status } = await startWithEmail(page, applicant.email);
      if (status === 'logged-in') return 'guest';
      if (status === 200) return 'wall';   // profile exists → password login / reset
      if (status === 404) return 'login';  // no profile → register
      throw new Error(`validateemail returned ${status}`);
    },

    login: async (page, { email, password }) => {
      const since = Date.now();
      if (!(await visible(page.locator('#Login_Password_show'), 1000))) {
        const { status } = await startWithEmail(page, email);
        if (status === 'logged-in') return true;
        if (status !== 200) return false;
        await page.waitForSelector('#Login_Password_show', { timeout: 15000 });
      }
      await page.locator('#Login_Password_show').fill(password);
      await page.locator('#login-next-button').click();
      const ok = await leftLogin(page, 20000);
      if (ok) return true;
      if (await handleOneTimeCode(page, email, since)) return true;
      const msg = norm(await page.locator('#login-form .validation-summary-errors, #login-form .field-validation-error').allInnerTexts().then((a) => a.join(' ')).catch(() => ''));
      log(`login rejected${msg ? `: ${msg}` : ''}`);
      return false;
    },

    requestReset: async (page, email) => {
      if (!(await visible(page.locator('a[href="#forgot-view"]'), 1000))) {
        const { status } = await startWithEmail(page, email);
        if (status !== 200) throw new Error(`no profile for ${email} (validateemail ${status})`);
      }
      await page.locator('a[href="#forgot-view"]').first().click();
      await page.waitForSelector('#RecoveryByEmail_Email', { timeout: 15000 });
      await page.locator('#RecoveryByEmail_Email').fill(email);
      await page.locator('#forgot-next-button').click();
      await sleep(2500);
    },

    // mail.value = https://candidate.webcruiter.com/Account/ResetPassword?code=…
    completeReset: async (page, { mail, newPassword }) => {
      await page.goto(mail.value, { waitUntil: 'networkidle', timeout: 60000 });
      await acceptCookies(page);
      await page.locator('#Password_show').fill(newPassword);
      await page.locator('a#reset-button').click();
      await sleep(1500);
      return leftLogin(page, 30000); // lands logged-in on /nb-no/Home
    },

    // Register view is shown after validateemail 404. Untested end-to-end
    // (the applicant already has a profile); selectors from the SPA templates.
    register: async (page, { email, password, applicant: a }) => {
      if (!(await visible(page.locator('#Register_Password_show'), 1000))) {
        const { status } = await startWithEmail(page, email);
        if (status === 200) return 'already-registered';
        await page.waitForSelector('#Register_Password_show', { timeout: 15000 });
      }
      const { cc, num } = splitPhone(a.phone);
      await page.locator('#Register_FullName').fill(`${a.firstName || ''} ${a.lastName || ''}`.trim());
      await page.locator('#Register_MobilePhone_CountryCode').fill(cc);
      await page.locator('#Register_MobilePhone').fill(num);
      await page.locator('#Register_Password_show').fill(password);
      const terms = page.locator('form#register-form input[type=checkbox]');
      if (await terms.count() && !(await terms.first().isChecked())) await terms.first().check({ force: true });
      await page.locator('#register-next-button').click();
      await sleep(2500);
      if (await visible(page.locator('#Login_Code'), 3000)) return 'verify-code';
      if (!/spalogin/i.test(page.url())) return 'done';
      const txt = lc(await page.locator('form#register-form').innerText().catch(() => ''));
      if (/allerede|already/.test(txt)) return 'already-registered';
      throw new Error(`register: unexpected state after submit: ${txt.slice(0, 200)}`);
    },

    completeRegistration: async (page, { mail }) => {
      await page.locator('#Login_Code').fill(String(mail.value));
      await page.locator('#verifycode-next-button').click();
      return leftLogin(page, 30000);
    },
  };
}

// ---------------------------------------------------------------- form helpers
const headingOf = (page, name) => page.locator('h2.element-header', { hasText: name }).first().locator('xpath=ancestor::div[contains(@class,"panel-heading")][1]');
const panelOf = (page, name) => page.locator('h2.element-header', { hasText: name }).first().locator('xpath=ancestor::div[contains(@class,"we-panel")][1]');

async function isExpanded(page, name) {
  const cls = (await panelOf(page, name).getAttribute('class').catch(() => '')) || '';
  return /we-panel-expanded/.test(cls);
}

async function expand(page, name) {
  if (await isExpanded(page, name)) return true;
  const h = headingOf(page, name);
  if ((await h.getAttribute('aria-disabled')) === 'true') return false;
  await h.click();
  await sleep(1500);
  return isExpanded(page, name);
}

async function waitSave(page, urlPart, action, timeout = 30000) {
  const [resp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes(urlPart) && r.request().method() !== 'GET', { timeout }).catch(() => null),
    action(),
  ]);
  await sleep(1200);
  if (!resp) return { status: 0, body: null };
  let body = null;
  try { body = await resp.json(); } catch { /* not json */ }
  return { status: resp.status(), body };
}

function modelStateErrors(body) {
  const out = [];
  const ms = body && body.ModelState;
  if (ms && typeof ms === 'object') for (const v of Object.values(ms)) for (const s of [].concat(v)) out.push(norm(s));
  return out;
}

// ---------------------------------------------------------------- main
async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) throw new Error('usage: node fill.mjs input.json');
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const { applyUrl, cvPath, applicant = {}, coverLetter = '', answers = {}, outDir, userId } = input;
  let submit = input.submit === true;
  if (process.env.FILL_DRY_RUN === '1' && submit) { log('FILL_DRY_RUN=1 — submit forced off'); submit = false; }
  if (!applicant.email) throw new Error('applicant.email is required (it is the Webcruiter username)');

  fs.mkdirSync(outDir, { recursive: true });
  const result = {
    ok: false, filled: [], prefilled: [], unmapped: [], required_missing: [],
    screenshot: null, submitted: false, submitReady: false, account: null, error: null,
  };
  const advertId = advertIdFrom(applyUrl);
  const applyPage = `${BASE}/nb-no/cv?advertid=${advertId}#personalapply`;

  const browser = await chromium.launch({ executablePath: CHROME_PATH, headless: true, args: ['--no-sandbox'] });
  let page;
  try {
    const context = await browser.newContext({ locale: 'nb-NO', viewport: { width: 1280, height: 900 } });
    page = await context.newPage();

    // ---- 0b. account (owner's rule: account first, form after)
    const site = makeSite(advertId, applicant);
    const account = await ensureAccount({ page, site, applicant, userId, log });
    result.account = { mode: account.mode, email: account.email, siteDomain: account.siteDomain, reason: account.reason };
    if (account.mode === 'blocked') throw new Error(`account blocked: ${account.reason}`);

    // ---- open the application
    if (!new RegExp(`/cv\\?advertid=${advertId}`, 'i').test(page.url())) {
      await page.goto(applyPage, { waitUntil: 'networkidle', timeout: 60000 });
    }
    await acceptCookies(page);
    await page.waitForSelector('h2.element-header', { timeout: 30000 });
    const bodyText = norm(await page.locator('body').innerText());
    if (/Vi fant ikke stillingsannonsen/i.test(bodyText)) throw new Error('advert not found (Vi fant ikke stillingsannonsen)');
    if (/søknadsfristen (er|har) (utløpt|gått ut)/i.test(bodyText)) throw new Error('application deadline has passed');
    const wcAppId = (bodyText.match(/Webcruiter-ID:\s*(\d{7,})(?!.*Webcruiter-ID:)/) || [])[1] || null;
    log(`application page open (draft Webcruiter-ID ${wcAppId || '?'})`);

    // ---- 1. Personalia — fill only empty fields, keep what the profile prefilled
    const saveBtn = page.locator('#save-personal-detail');
    if (await visible(saveBtn, 3000)) {
      await page.waitForFunction(() => { const n = document.querySelector('#Name'); return n && n.value; }, null, { timeout: 10000 }).catch(() => log('Personalia: #Name not prefilled'));
      const { cc, num } = splitPhone(applicant.phone);
      const textFields = [
        { label: 'Fornavn og etternavn', sel: '#Name', value: `${applicant.firstName || ''} ${applicant.lastName || ''}`.trim() },
        { label: 'Landskode', sel: '#MobilePhone_CountryCode', value: cc },
        { label: 'Mobilnummer', sel: '#MobilePhone', value: num },
        { label: 'Fødselsdato', sel: '#BirthDate', value: applicant.birthDate || '' },
        { label: 'Adresse', sel: '#Address', value: applicant.address || '' },
        { label: 'Postnummer', sel: '#ZipCode', value: applicant.postalCode || '' },
        { label: 'Poststed', sel: '#City', value: applicant.city || '' },
      ];
      for (const f of textFields) {
        const el = page.locator(f.sel);
        if (!(await el.count())) continue;
        const cur = await el.inputValue().catch(() => '');
        if (cur) { result.prefilled.push({ label: f.label, value: cur }); continue; }
        if (!f.value) { result.required_missing.push(`Personalia: ${f.label}`); continue; }
        await el.fill(f.value);
        result.filled.push({ label: f.label, value: f.value });
      }
      const country = page.locator('#CountryTwoLetterIsoCode');
      if (await country.count()) {
        const cur = await country.inputValue().catch(() => '');
        if (cur) result.prefilled.push({ label: 'Land', value: cur });
        else { await country.selectOption(applicant.countryCode || 'NO'); result.filled.push({ label: 'Land', value: applicant.countryCode || 'NO' }); }
      }
      if (!(await page.locator('input[name="Gender"]:checked').count())) {
        const g = lc(applicant.gender);
        const id = /^(m|male|mann)$/.test(g) ? '#genderMale' : /^(f|female|kvinne)$/.test(g) ? '#genderFemale' : null;
        if (id) { await page.locator(`label[for="${id.slice(1)}"]`).click(); result.filled.push({ label: 'Juridisk kjønn', value: g }); }
        else result.required_missing.push('Personalia: Juridisk kjønn (applicant.gender)');
      } else result.prefilled.push({ label: 'Juridisk kjønn', value: await page.locator('input[name="Gender"]:checked').first().getAttribute('id') });
      // "Gyldig arbeidstillatelse for Norge" — required, never prefilled (422 WorkingPermit må fylles ut)
      if (!(await page.locator('input[name="WorkingPermit"]:checked').count())) {
        const yes = applicant.workPermit !== false;
        await page.locator(`label:has(input[name="WorkingPermit"][value="${yes}"])`).click();
        result.filled.push({ label: 'Gyldig arbeidstillatelse for Norge', value: yes ? 'Ja' : 'Nei' });
      } else result.prefilled.push({ label: 'Gyldig arbeidstillatelse for Norge', value: await page.locator('input[name="WorkingPermit"]:checked').getAttribute('value') });
      const nat = page.locator('#NationalityId');
      if (await nat.count()) {
        const cur = await nat.inputValue().catch(() => '');
        if (cur) result.prefilled.push({ label: 'Nasjonalitet', value: await nat.locator('option:checked').innerText().catch(() => cur) });
        else if (applicant.nationality) { await nat.selectOption({ label: applicant.nationality }); result.filled.push({ label: 'Nasjonalitet', value: applicant.nationality }); }
        else result.required_missing.push('Personalia: Nasjonalitet (applicant.nationality)');
      }
      const r = await waitSave(page, '/api/personaldetail/', () => saveBtn.click());
      if (r.status === 422) {
        for (const e of modelStateErrors(r.body)) result.required_missing.push(`Personalia: ${e}`);
        log(`Personalia 422: ${modelStateErrors(r.body).join('; ')}`);
      } else if (r.status && r.status >= 400) {
        throw new Error(`Personalia save failed: HTTP ${r.status}`);
      } else {
        await saveBtn.waitFor({ state: 'hidden', timeout: 15000 }).catch(() => {});
        log('Personalia saved');
      }
    } else {
      log('Personalia already in summary mode');
    }

    // ---- 2. Spørsmål — per-advert screening; all questions are required
    const spHead = headingOf(page, 'Spørsmål');
    if (await spHead.count()) {
      if (!(await expand(page, 'Spørsmål'))) {
        result.required_missing.push('Spørsmål: section locked (Personalia not saved)');
      } else {
        const sp = panelOf(page, 'Spørsmål');
        // summary mode (answers saved earlier) → "Endre" (the visible one; a hidden mobile twin exists)
        if (!(await sp.locator('.mb-xl:visible').count())) {
          const edit = sp.locator('button:visible', { hasText: 'Endre' });
          if (await edit.count()) { await edit.first().click(); await sleep(1500); }
        }
        if (!(await sp.locator('.mb-xl:visible').count())) throw new Error('Spørsmål: no editable questions visible');
        const answerKeys = Object.keys(answers);
        const findAnswer = (label) => {
          const l = lc(label);
          const k = answerKeys.find((key) => l.includes(lc(key)));
          return k === undefined ? undefined : answers[k];
        };
        let allAnswered = true;
        for (const q of await sp.locator('.mb-xl:visible').all()) {
          const label = norm(await q.locator('span.h5').first().innerText().catch(() => ''));
          if (!label) continue;
          const radios = q.locator('label.k-radio-label:visible');
          const ta = q.locator('textarea:visible');
          const isRadio = (await radios.count()) > 0;
          const options = isRadio ? (await radios.allInnerTexts()).map(norm) : [];
          const already = isRadio ? await q.locator('input[type=radio]:checked').count() : (await ta.count() ? (await ta.first().inputValue()).trim().length : 0);
          const ans = findAnswer(label);
          if (ans === undefined || ans === null || ans === '') {
            if (already) { result.prefilled.push({ label, value: '(kept)' }); continue; }
            result.unmapped.push(isRadio ? `${label} [${options.join(' / ')}]` : label);
            result.required_missing.push(`Spørsmål: ${label}`);
            allAnswered = false;
            continue;
          }
          if (isRadio) {
            const want = lc(ans);
            let idx = options.findIndex((o) => lc(o) === want);
            if (idx < 0) idx = options.findIndex((o) => lc(o).startsWith(want) || want.startsWith(lc(o)));
            if (idx < 0) {
              result.unmapped.push(`${label} [${options.join(' / ')}] (answer "${ans}" matches no option)`);
              result.required_missing.push(`Spørsmål: ${label}`);
              allAnswered = false;
              continue;
            }
            await radios.nth(idx).click();
            result.filled.push({ label, value: options[idx] });
          } else if (await ta.count()) {
            await ta.first().fill(String(ans));
            result.filled.push({ label, value: String(ans) });
          } else {
            result.unmapped.push(`${label} (unknown widget)`);
            allAnswered = false;
          }
        }
        if (allAnswered) {
          const r = await waitSave(page, '/api/jobapplication/save_question/', () => sp.locator('button.btn-save', { hasText: 'Lagre' }).click());
          if (r.status === 422) {
            for (const e of modelStateErrors(r.body)) result.required_missing.push(`Spørsmål: ${e}`);
          } else if (r.status && r.status >= 400) throw new Error(`Spørsmål save failed: HTTP ${r.status}`);
          else log('Spørsmål saved');
        } else log('Spørsmål: not saved — unanswered questions');
      }
    }

    // ---- 3. Søknadstekst — plain textarea, no visible char limit (verified 2026-09-03)
    const clHead = headingOf(page, 'Søknadstekst');
    if (await clHead.count()) {
      if (!(await expand(page, 'Søknadstekst'))) {
        result.required_missing.push('Søknadstekst: section locked (Spørsmål not saved)');
      } else {
        const cl = panelOf(page, 'Søknadstekst');
        const ta = page.locator('#ApplicationText');
        if (!(await visible(ta, 1500))) {
          const edit = cl.locator('button:visible', { hasText: 'Endre' });
          if (await edit.count()) { await edit.first().click(); await sleep(1500); }
        }
        if (!(await visible(ta, 3000))) throw new Error('Søknadstekst: #ApplicationText not reachable (section locked while Spørsmål is unsaved?)');
        const tag = await ta.evaluate((e) => e.tagName);
        if (tag !== 'TEXTAREA') throw new Error(`Søknadstekst: expected <textarea>, got ${tag}`);
        const maxlen = Number(await ta.getAttribute('maxlength')) || null;
        const current = (await ta.inputValue()).trim();
        if (coverLetter) {
          if (maxlen && coverLetter.length > maxlen) throw new Error(`cover letter ${coverLetter.length} chars exceeds live maxlength ${maxlen}`);
          await ta.fill(coverLetter);
          const r = await waitSave(page, '/api/jobapplication/savecoverletter/', () => cl.locator('button.btn-save', { hasText: 'Lagre' }).click());
          const valMsg = norm(await page.locator('[data-valmsg-for="ApplicationText"]').innerText().catch(() => ''));
          if (r.status === 422 || valMsg) throw new Error(`Søknadstekst rejected: ${modelStateErrors(r.body).join('; ') || valMsg}`);
          if (r.status && r.status >= 400) throw new Error(`Søknadstekst save failed: HTTP ${r.status}`);
          result.filled.push({ label: 'Søknadstekst', value: `${coverLetter.length} chars` });
          log('Søknadstekst saved');
        } else if (current) {
          result.prefilled.push({ label: 'Søknadstekst', value: `${current.length} chars (kept)` });
        } else {
          result.required_missing.push('Søknadstekst (coverLetter)');
        }
      }
    }

    // ---- 4. CV — the structured profile CV satisfies "CV *". A file widget
    // ("Legg til CV", #attachCVfile inside .k-upload-button) is shown only when
    // the advert wants a CV attachment; upload there, never via
    // "Opprett CV automatisk" (that rewrites the master CV).
    if (await headingOf(page, 'CV').count() && await expand(page, 'CV')) {
      const cv = panelOf(page, 'CV');
      const cvText = norm(await cv.innerText());
      const uploader = cv.locator('.k-upload-button:visible input#attachCVfile, input#attachCVfile:visible');
      const attached = cv.locator('#attachment-list-view-jobapplication:visible');
      if (await attached.count()) {
        result.prefilled.push({ label: 'CV-vedlegg', value: norm(await attached.innerText()).slice(0, 80) });
      } else if (await uploader.count()) {
        if (!cvPath || !fs.existsSync(cvPath)) result.required_missing.push('CV: attachment requested but cvPath missing');
        else {
          const r = await waitSave(page, '/api/attachment', () => uploader.first().setInputFiles(cvPath), 60000);
          if (r.status && r.status >= 400) throw new Error(`CV upload failed: HTTP ${r.status}`);
          result.filled.push({ label: 'Legg til CV', value: path.basename(cvPath) });
        }
      } else {
        const hasWork = /Arbeidserfaring/.test(cvText) && (await cv.locator('button', { hasText: 'Endre' }).count()) > 0;
        if (hasWork) result.prefilled.push({ label: 'CV', value: 'structured profile CV (no upload requested)' });
        else result.required_missing.push('CV: profile has no Arbeidserfaring/Utdanning and the advert has no CV upload');
      }
      await headingOf(page, 'CV').click().catch(() => {}); await sleep(600);
    }

    // ---- screenshot of the whole application
    const screenshotPath = path.join(outDir, 'filled.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    result.screenshot = screenshotPath;

    const sendBtn = page.locator(SEND_BUTTON).first();
    result.submitReady = (await sendBtn.count()) > 0 && !(await sendBtn.isDisabled());

    // ---- 5. submit — guarded three ways: input.submit, nothing missing, no dry-run
    if (submit && result.required_missing.length === 0 && result.unmapped.length === 0) {
      if (!result.submitReady) throw new Error('submit requested but "Send søknad" is disabled');
      await sendBtn.click();
      await sleep(2000);
      // untested branch (2026-09-03): a confirm dialog may follow; accept the obvious one only
      const confirm = page.locator('.modal:visible button, [role=dialog]:visible button').filter({ hasText: /^Send( søknad)?$|^Ja$|^OK$/ });
      if (await confirm.count()) await confirm.first().click();
      await page.waitForFunction(() => /Takk for søknaden|Søknaden er sendt/i.test(document.body.innerText), null, { timeout: 30000 })
        .catch(() => { throw new Error('clicked "Send søknad" but no confirmation text appeared'); });
      result.submitted = true;
      const afterPath = path.join(outDir, 'submitted.png');
      await page.screenshot({ path: afterPath, fullPage: true });
      result.screenshot = afterPath;
    } else if (submit) {
      log('submit requested but skipped: required_missing/unmapped not empty');
    }

    result.ok = true;
  } catch (err) {
    result.ok = false;
    result.error = String(err && err.message ? err.message : err);
    log(err && err.stack ? err.stack : err);
    try {
      const errPath = path.join(outDir, 'error.png');
      await page?.screenshot({ path: errPath, fullPage: true });
      result.screenshot = errPath;
    } catch { /* best effort */ }
  } finally {
    await browser.close().catch(() => {});
  }
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}

main().catch((e) => { console.log(JSON.stringify({ ok: false, error: String(e.message || e) })); process.exit(1); });

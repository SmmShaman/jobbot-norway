#!/usr/bin/env node
// fill.mjs — apply.recman.page (Recman ATS), keyed by host per CACHE.md.
// Usage: node fill.mjs input.json
//
// Account step (POLICY v11, 2026-09-03): Recman keeps a candidate DB per
// employer (corporation id). The first application to an employer goes
// through as a guest and silently creates an account on the applicant's
// e-mail; every later posting from the same employer shows «Denne
// e-postadressen er allerede registrert» and offers only «Logg inn». The
// login and the forgot-password pages are gated by invisible reCAPTCHA
// Enterprise (site key 6LePxkkl…, action reset_password / login) — a
// headless run gets HTTP 422 «Invalid Recaptcha» on BOTH (measured 03.09.2026
// with a wrong password and with a reset request). So ensureAccount() reports
// `captcha` for a walled employer and the agent hands the row over with that
// exact reason; nothing is retried or bypassed. If Recman ever drops the
// CAPTCHA, the hooks below already implement login + 4-step reset
// (email → code → new password) and the flow activates by itself.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { ensureAccount } from '../_lib/account.mjs';
import { extractCode } from '../_lib/imap-mail.mjs';

const CHROME_PATH = process.env.CHROMIUM_PATH || '/home/node/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';

async function fillContentEditable(page, locator, text) {
  await locator.click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await locator.pressSequentially(text, { delay: 3 });
}

function employerScope(applyUrl) {
  try {
    const u = new URL(applyUrl);
    return u.searchParams.get('sub_id') || u.hostname.split('.')[0];
  } catch { return ''; }
}

// The SPA injects the reCAPTCHA script after first paint, so poll briefly
// instead of trusting a single count right after networkidle.
async function hasRecaptcha(page, waitMs = 8000) {
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const found = await page.evaluate(() => (
      typeof window.grecaptcha !== 'undefined'
      || !!document.querySelector('textarea[name="g-recaptcha-response"], iframe[src*="recaptcha"], script[src*="recaptcha"], .grecaptcha-badge')
    )).catch(() => false);
    if (found) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

// Site hooks for assets/account.mjs. `page` is the wizard tab; login/reset
// open their own tab so the wizard state survives.
function recmanSite(applyUrl, log) {
  const scope = employerScope(applyUrl);
  const jobId = (applyUrl.match(/[?&]id=(\d+)/) || [])[1];
  let base = null; // https://<employer>.recman.page, learnt from the redirect
  const origin = (page) => base || new URL(page.url()).origin;

  return {
    host: 'apply.recman.page',
    scope,
    name: `Recman (sub_id ${scope})`,
    mailFrom: 'recman.io',
    resetMailFilter: { subjectIncludes: 'passord', extract: (t) => extractCode(t, /\b([A-Z0-9]{2}-[A-Z0-9]{2}|\d{4,8})\b/) },

    // Called with the wizard on «Profil» after the e-mail was typed.
    async detect(page) {
      base = new URL(page.url()).origin;
      await page.waitForTimeout(1200);
      const wall = (await page.locator('.ErrorMessageDuplicate').count())
        || (await page.getByText('allerede registrert', { exact: false }).count());
      if (!wall) return 'guest';
      const tab = await page.context().newPage();
      try {
        await tab.goto(`${origin(page)}/login?email=${encodeURIComponent('')}&postId=${jobId || ''}`, { waitUntil: 'networkidle', timeout: 30000 });
        if (await hasRecaptcha(tab)) {
          log('recman: login page carries reCAPTCHA Enterprise → captcha');
          return 'captcha';
        }
        return 'wall';
      } finally {
        await tab.close();
      }
    },

    async login(page, { email, password }) {
      const tab = await page.context().newPage();
      try {
        await tab.goto(`${origin(page)}/login?email=${encodeURIComponent(email)}&postId=${jobId || ''}`, { waitUntil: 'networkidle', timeout: 30000 });
        try { await tab.getByText('Aksepter alle', { exact: false }).first().click({ timeout: 3000 }); } catch { /* no banner */ }
        await tab.locator('input[name="email"]').fill(email);
        await tab.locator('input[name="password"]').fill(password);
        const resp = tab.waitForResponse((r) => /\/api\/login$/.test(r.url()), { timeout: 20000 }).catch(() => null);
        await tab.locator('button[type="submit"]', { hasText: 'Logg inn' }).click();
        const r = await resp;
        if (!r || r.status() >= 400) {
          const body = r ? (await r.text().catch(() => '')).slice(0, 200) : 'no response';
          log(`recman: login rejected (${r ? r.status() : '-'}: ${body})`);
          return false;
        }
        // Session cookie is shared with the wizard tab; reload it so the
        // profile step re-renders for the logged-in candidate.
        await page.reload({ waitUntil: 'domcontentloaded' });
        return true;
      } finally {
        await tab.close();
      }
    },

    async requestReset(page, email) {
      const tab = await page.context().newPage();
      try {
        await tab.goto(`${origin(page)}/forgot-password`, { waitUntil: 'networkidle', timeout: 30000 });
        try { await tab.getByText('Aksepter alle', { exact: false }).first().click({ timeout: 3000 }); } catch { /* no banner */ }
        await tab.locator('input[name="email"]').fill(email);
        const resp = tab.waitForResponse((r) => /reset-password\/init/.test(r.url()), { timeout: 20000 }).catch(() => null);
        await tab.locator('button[type="submit"]', { hasText: 'Send kode' }).click();
        const r = await resp;
        if (!r || r.status() >= 400) {
          throw new Error(`reset init rejected (${r ? r.status() : '-'}: ${r ? (await r.text().catch(() => '')).slice(0, 120) : 'no response'})`);
        }
        page._recmanResetTab = tab; // keep it open for completeReset
        return;
      } catch (e) {
        await tab.close();
        throw e;
      }
    },

    async completeReset(page, { mail, newPassword }) {
      const tab = page._recmanResetTab;
      if (!tab) return false;
      try {
        // Step 2: one-time code (OTP inputs or a single field).
        const otp = tab.locator('input[autocomplete="one-time-code"], input[name="code"], input[inputmode="numeric"]');
        const code = String(mail.value).replace(/[^A-Z0-9]/gi, '');
        if ((await otp.count()) > 1) {
          for (let i = 0; i < code.length && i < (await otp.count()); i += 1) await otp.nth(i).fill(code[i]);
        } else {
          await otp.first().fill(mail.value);
        }
        const next = tab.getByRole('button', { name: /Neste|Bekreft|Valider/i });
        if (await next.count()) await next.first().click();
        await tab.waitForSelector('input[name="password"]', { timeout: 20000 });
        await tab.locator('input[name="password"]').fill(newPassword);
        await tab.locator('input[name="repeatPassword"]').fill(newPassword);
        const resp = tab.waitForResponse((r) => /reset-password\/reset/.test(r.url()), { timeout: 20000 }).catch(() => null);
        await tab.locator('button[type="submit"]').first().click();
        const r = await resp;
        return !!r && r.status() < 400;
      } finally {
        await tab.close();
        delete page._recmanResetTab;
      }
    },
  };
}

async function main() {
  const inputPath = process.argv[2];
  const input = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
  const {
    applyUrl, cvPath, applicant, coverLetter,
    answers = {}, submit = false, outDir, userId,
  } = input;

  fs.mkdirSync(outDir, { recursive: true });
  const logLines = [];
  const log = (m) => { logLines.push(m); process.stderr.write(`${m}\n`); };

  const result = {
    ok: false, filled: [], unmapped: [], required_missing: [],
    screenshot: null, submitted: false, error: null, account: null,
  };

  const browser = await chromium.launch({
    executablePath: CHROME_PATH,
    headless: true,
    args: ['--no-sandbox'],
  });

  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(applyUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Entry flow: cookie banner + open apply wizard
    try {
      await page.getByText('Aksepter alle', { exact: false }).click({ timeout: 5000 });
    } catch { /* banner not present on this load */ }

    await page.getByText('Søk nå', { exact: false }).first().click({ timeout: 15000 });

    // Step 1: Last opp CV — the native input is visually hidden behind a styled
    // uploader button, so wait for it merely attached, not visible.
    await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 15000 });
    await page.locator('input[type="file"]').setInputFiles(cvPath);
    result.filled.push({ label: 'Last opp CV', value: path.basename(cvPath) });
    await page.getByRole('button', { name: 'Neste' }).click();

    // Step 2: Profil — the e-mail is the account probe, so it goes in first.
    await page.waitForSelector('input[name="firstName"]', { timeout: 15000 });
    await page.locator('input[name="firstName"]').fill(applicant.firstName);
    result.filled.push({ label: 'Fornavn', value: applicant.firstName });
    await page.locator('input[name="lastName"]').fill(applicant.lastName);
    result.filled.push({ label: 'Etternavn', value: applicant.lastName });
    await page.locator('input[name="email"]').fill(applicant.email);
    result.filled.push({ label: 'E-post', value: applicant.email });
    await page.locator('input[name="email"]').blur();

    // Account step — BEFORE anything else is filled (SKILL.md phase 0b).
    result.account = await ensureAccount({ page, site: recmanSite(applyUrl, log), applicant, userId, log });
    if (result.account.mode === 'blocked') {
      throw new Error(`account: ${result.account.reason}`);
    }
    if (result.account.mode !== 'guest') {
      // Logged in: the wizard re-rendered; make sure we are still on Profil.
      await page.waitForSelector('input[name="firstName"]', { timeout: 15000 });
      if (!(await page.locator('input[name="firstName"]').inputValue())) await page.locator('input[name="firstName"]').fill(applicant.firstName);
      if (!(await page.locator('input[name="lastName"]').inputValue())) await page.locator('input[name="lastName"]').fill(applicant.lastName);
    }

    const digits = (applicant.phone || '').replace(/\D/g, '');
    await page.locator('input[name="mobilePhone.number"]').click();
    await page.keyboard.press('Control+A');
    await page.keyboard.press('Delete');
    await page.locator('input[name="mobilePhone.number"]').pressSequentially(digits, { delay: 5 });
    result.filled.push({ label: 'phone', value: digits });
    await page.waitForTimeout(1200);
    if (await page.locator('.ErrorMessageDuplicate').count()) {
      throw new Error('recman: phone number already registered with this employer and login is CAPTCHA-gated');
    }

    // Profil fields vary per employer: Karrieresenteret (sub 801) asks only
    // name/e-mail/phone, others add birth date and address. Fill what exists.
    if (applicant.birthDate && (await page.locator('[name="dateOfBirth.day"]').count())) {
      const [year, month, day] = applicant.birthDate.split('-');
      const dayField = page.locator('[name="dateOfBirth.day"]');
      const monthField = page.locator('[name="dateOfBirth.month"]');
      const yearField = page.locator('[name="dateOfBirth.year"]');
      const monthTag = await monthField.evaluate((el) => el.tagName).catch(() => 'INPUT');
      if (monthTag === 'SELECT') {
        await dayField.selectOption(String(Number(day)));
        await monthField.selectOption(String(Number(month)));
        await yearField.selectOption(year);
      } else {
        await dayField.fill(day);
        await monthField.fill(month);
        await yearField.fill(year);
      }
      result.filled.push({ label: 'Fødselsdato', value: applicant.birthDate });
    }

    const addressAlreadyResolved = await page.locator('.ApplyV2AddressSelect__input__single-value').count();
    if (!addressAlreadyResolved && applicant.address && (await page.locator('#address').count())) {
      await page.locator('#address').click();
      await page.locator('#address').pressSequentially(applicant.address, { delay: 20 });
      await page.waitForTimeout(1500);
      result.filled.push({ label: 'Adresse', value: applicant.address });
    }

    await page.getByRole('button', { name: 'Neste' }).click();

    // Step 3: Spørsmål — dynamic per-job custom questions
    await page.waitForTimeout(1000);
    const questionInputs = await page.locator('input[name^="text_"]').all();
    for (const input_ of questionInputs) {
      const name = await input_.getAttribute('name');
      let labelText = null;
      try {
        const forId = await input_.getAttribute('id');
        if (forId) {
          labelText = await page.locator(`label[for="${forId}"]`).innerText({ timeout: 2000 });
        }
      } catch { /* no label found via for= */ }
      if (!labelText) {
        try {
          labelText = await input_.locator('xpath=ancestor::*[self::div][1]/preceding-sibling::label[1]').innerText({ timeout: 2000 });
        } catch { /* leave null */ }
      }

      const matchKey = Object.keys(answers).find((k) => labelText && labelText.includes(k));
      if (matchKey) {
        await input_.fill(answers[matchKey]);
        result.filled.push({ label: labelText || name, value: answers[matchKey] });
      } else {
        result.unmapped.push(labelText || name);
      }
    }

    const nextOnQuestions = page.getByRole('button', { name: 'Neste' });
    if (await nextOnQuestions.count()) {
      await nextOnQuestions.click();
    }

    // Step 4: Gjennomgå og søk — cover letter (contenteditable, not a real textarea)
    await page.waitForTimeout(1000);
    const letterBox = page.locator('.ApplyV2Textarea__textarea[contenteditable]').first();
    if (await letterBox.count() && coverLetter) {
      const limited = coverLetter.length > 1500 ? coverLetter.slice(0, 1500) : coverLetter;
      await fillContentEditable(page, letterBox, limited);
      result.filled.push({ label: 'Søknadsbrev', value: `${limited.length} chars` });
    }

    const screenshotPath = path.join(outDir, 'filled.png');
    await page.screenshot({ path: screenshotPath, fullPage: true });
    result.screenshot = screenshotPath;

    if (result.required_missing.length === 0 && submit) {
      await page.getByRole('button', { name: 'Søk' }).click();
      await page.waitForTimeout(2000);
      result.submitted = true;
      const afterSubmitPath = path.join(outDir, 'submitted.png');
      await page.screenshot({ path: afterSubmitPath, fullPage: true });
      result.screenshot = afterSubmitPath;
    }

    result.ok = true;
  } catch (err) {
    result.ok = false;
    result.error = String(err && err.message ? err.message : err);
    try {
      const errPath = path.join(outDir, 'error.png');
      await browser.contexts()[0]?.pages()[0]?.screenshot({ path: errPath, fullPage: true });
      result.screenshot = errPath;
    } catch { /* best effort */ }
  } finally {
    await browser.close();
  }

  fs.writeFileSync(path.join(outDir, 'fill.log'), logLines.join('\n'));
  console.log(JSON.stringify(result));
  process.exit(result.ok ? 0 : 1);
}

main();

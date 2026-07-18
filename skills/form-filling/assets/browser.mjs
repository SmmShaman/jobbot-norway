import { chromium } from 'playwright-core';

// Must match the playwright-core version pinned in package.json (see SKILL.md "Environment constants").
export const CHROMIUM_EXECUTABLE = '/home/node/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome';

export async function launchBrowser() {
  return chromium.launch({
    executablePath: CHROMIUM_EXECUTABLE,
    headless: true,
    args: ['--no-sandbox'],
  });
}

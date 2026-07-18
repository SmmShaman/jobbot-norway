// Cookie banners are the near-universal first obstacle. Try a list of known
// accept-button texts (Norwegian + English) and move on silently if none match
// (some sites don't show a banner on repeat visits / headless sessions).
export async function dismissCookieBanner(page, texts = ['Aksepter alle', 'Godta alle', 'Accept all', 'Godkjenn alle']) {
  for (const text of texts) {
    try {
      await page.getByText(text, { exact: false }).first().click({ timeout: 3000 });
      await page.waitForTimeout(500);
      return text;
    } catch (e) {
      // try next candidate
    }
  }
  return null;
}

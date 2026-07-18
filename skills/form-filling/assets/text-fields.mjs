// Some "textarea-looking" fields are actually contenteditable divs (e.g. recman's
// Søknadsbrev field, id-referenced by <label for="...">, tag DIV, contenteditable
// "plaintext-only"). A plain locator.fill() does not work on these — click to focus,
// then type via the keyboard.
export async function fillContentEditable(page, locator, text) {
  await locator.click();
  await page.keyboard.type(text, { delay: 1 });
}

// ALWAYS check length against the site's documented limit BEFORE inserting text —
// don't rely on typing and then reading the live counter to find out you overflowed.
export function assertWithinCharLimit(text, limit, fieldName = 'field') {
  if (text.length > limit) {
    throw new Error(`${fieldName} exceeds limit: ${text.length}/${limit} chars`);
  }
}

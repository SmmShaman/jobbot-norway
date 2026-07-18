// Gotcha: some phone-mask widgets have a decorative country-selector dropdown
// that has ZERO effect on the actual formatted value — the mask infers the
// calling code purely from the first digits typed into the number field.
// Bypass the dropdown entirely: type the calling code + national number as one
// digit string (no "+", no spaces) directly into the number input.
// Example (Norway): fillMaskedPhone(page, 'input[name="mobilePhone.number"]', '4792564334')
export async function fillMaskedPhone(page, selector, fullDigitsWithCallingCode) {
  await page.locator(selector).pressSequentially(fullDigitsWithCallingCode, { delay: 20 });
}

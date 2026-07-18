// Recon helpers: use these when mapping a NEW site's form for the first time,
// before writing its sites/<domain>.json profile.

// Dump every input/textarea/select/contenteditable on the page with its
// associated <label> text (matched via `for`, or nearest ancestor label).
export async function dumpFields(page) {
  return page.evaluate(() => {
    const labelFor = (el) => {
      if (el.id) {
        const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
        if (l) return l.innerText.trim();
      }
      const parentLabel = el.closest('label');
      if (parentLabel) return parentLabel.innerText.trim();
      return null;
    };
    const fields = Array.from(document.querySelectorAll('input, textarea, select, [contenteditable]'));
    return fields.map((el) => ({
      tag: el.tagName,
      type: el.getAttribute('type'),
      name: el.getAttribute('name'),
      id: el.id || null,
      contenteditable: el.getAttribute('contenteditable'),
      label: labelFor(el),
      placeholder: el.getAttribute('placeholder'),
    }));
  });
}

// Dump every visible button's text — use this to find step-navigation
// ("Neste"/"Next") and final-submit ("Søk"/"Send"/"Apply") button labels.
export async function dumpButtons(page) {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('button'))
      .map((b) => b.innerText.trim())
      .filter(Boolean)
  );
}

// Find the element whose visible innerText is an exact match (e.g. a field's
// label span), and return its parent's outerHTML for manual inspection —
// useful when a label's `for` attribute points to a non-obvious custom element.
export async function findByExactText(page, text, snippetLength = 800) {
  return page.evaluate(
    ({ text, snippetLength }) => {
      const all = Array.from(document.querySelectorAll('*'));
      const match = all.find((e) => e.children.length === 0 && e.innerText && e.innerText.trim() === text);
      if (!match) return null;
      return match.parentElement ? match.parentElement.outerHTML.slice(0, snippetLength) : null;
    },
    { text, snippetLength }
  );
}

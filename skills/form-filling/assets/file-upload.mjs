import fs from 'fs';

// Native setInputFiles works for plain <input type="file">. Some custom
// drag-and-drop widgets intercept/hide the real input and only react to a
// "drop" event carrying a DataTransfer — for those, fall back to constructing
// a File + DataTransfer in-page and dispatching change/drop manually.
export async function uploadFile(page, selector, filePath) {
  try {
    await page.locator(selector).setInputFiles(filePath, { timeout: 5000 });
    return 'setInputFiles';
  } catch (e) {
    const buffer = fs.readFileSync(filePath);
    const fileName = filePath.split('/').pop();
    await page.evaluate(
      ({ selector, base64, fileName }) => {
        const input = document.querySelector(selector);
        const byteChars = atob(base64);
        const byteNumbers = new Array(byteChars.length);
        for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
        const file = new File([new Uint8Array(byteNumbers)], fileName);
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      },
      { selector, base64: buffer.toString('base64'), fileName }
    );
    return 'dataTransfer';
  }
}

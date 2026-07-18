import { execSync } from 'child_process';

// Screenshots must NEVER be read at full size (a single 1920x1080 PNG can be
// ~300KB base64 and does not compress under auto-context-compaction — a few
// dozen full-size reads is enough to overflow the prompt). Always downscale
// before handing the path to the Read tool.
export async function captureAndDownscale(page, { pngPath, jpgPath, width = 700, quality = 6, fullPage = true }) {
  await page.screenshot({ path: pngPath, fullPage });
  execSync(`ffmpeg -y -i ${pngPath} -vf scale=${width}:-1 -q:v ${quality} ${jpgPath}`, { stdio: 'ignore' });
  return jpgPath;
}

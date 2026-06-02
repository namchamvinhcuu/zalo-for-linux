const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const APP_DIR = path.join(__dirname, '..', '..', 'app');

// Zalo's own tray (in main-dist/main.js) builds its icon from `favicon.ico`:
//   const Nt = p.createFromPath(c.join(te(), "favicon.ico"))
// On Linux, nativeImage.createFromPath() renders multi-resolution .ico files
// as an empty/broken image, so Zalo's native tray shows a broken icon next to
// the working one. favicon-512x512.png lives in the same pc-dist dir and
// renders correctly, so we point the tray at the PNG.
//
// In the current Zalo bundle "favicon.ico" appears exactly once — the tray
// image — so a literal string replace is safe. favicon-512x512.png is a valid
// drop-in (renders as tray icon and as a window icon) and lives in the same
// pc-dist dir, so only the filename changes. If a future Zalo version adds
// more "favicon.ico" references we warn so this patch can be re-reviewed.

const OLD = '"favicon.ico"';
const NEW = '"favicon-512x512.png"';

async function main() {
  const mainJsPath = path.join(APP_DIR, 'main-dist', 'main.js');

  if (!fs.existsSync(mainJsPath)) {
    logger.warn('main.js not present, skipping tray-icon patch');
    return;
  }

  let content = fs.readFileSync(mainJsPath, 'utf8');

  const count = content.split(OLD).length - 1;
  if (count === 0) {
    logger.dim('tray icon already patched (no "favicon.ico"), skipping');
    return;
  }
  if (count > 1) {
    logger.warn(`Found ${count} "favicon.ico" references (expected 1 = tray icon). Zalo layout may have changed — review patch-tray-icon.js.`);
  }

  content = content.split(OLD).join(NEW);
  fs.writeFileSync(mainJsPath, content, 'utf8');
  logger.dim('Patched main.js: tray icon favicon.ico -> favicon-512x512.png');
  logger.success('Tray icon fix applied');
}

if (require.main === module) {
  main();
}

module.exports = { main };

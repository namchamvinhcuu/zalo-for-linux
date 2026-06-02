const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const APP_DIR = path.join(__dirname, '..', '..', 'app');

// Show the unread-message count on the system-tray icon (Linux).
//
// Zalo's `updateBadgeCount(e,t,r,i,o)` handler runs on Linux with t=count and
// m=getTray(), but only calls app.setBadgeCount(t) (launcher badge) — the tray
// icon itself is updated only on Windows, and the renderer never sends the
// badge image (i) on Linux. We extend the Linux branch to paint the tray with
// Zalo's own pre-rendered count icons, whose paths the tray-badge plugin exposes
// on global.__zaloBadgeIcons (it has appDir; this minified handler doesn't).
//
// In-scope here: m=tray, t=count. The tray-badge plugin exposes two nativeImages
// on global: __zaloTrayDot (logo + red dot) and __zaloTrayDefault (plain logo).
// We show the dot when there are unread messages, the plain logo otherwise.

const ANCHOR = 'h.dock.bounce()}else if("win32"';
const INJECT =
  'h.dock.bounce();try{if("linux"===process.platform&&m&&global.__zaloTrayDefault){' +
  'var __zi=t>0?(global.__zaloTrayDot||global.__zaloTrayDefault):global.__zaloTrayDefault;' +
  'm.setImage(__zi)}}catch(__e){console.error("[tray-badge] patch err:",__e.message)}' +
  '}else if("win32"';
const MARKER = 'global.__zaloTrayDefault';

async function main() {
  const mainJsPath = path.join(APP_DIR, 'main-dist', 'main.js');

  if (!fs.existsSync(mainJsPath)) {
    logger.warn('main.js not present, skipping tray-badge patch');
    return;
  }

  let content = fs.readFileSync(mainJsPath, 'utf8');

  if (content.includes(MARKER)) {
    logger.dim('tray badge already patched, skipping');
    return;
  }
  if (!content.includes(ANCHOR)) {
    logger.warn('tray-badge anchor not found (Zalo badge handler may have changed), skipping');
    return;
  }

  content = content.replace(ANCHOR, INJECT);
  fs.writeFileSync(mainJsPath, content, 'utf8');
  logger.dim('Patched main.js: tray shows unread count icon on Linux');
  logger.success('Tray unread-badge patch applied');
}

if (require.main === module) {
  main();
}

module.exports = { main };

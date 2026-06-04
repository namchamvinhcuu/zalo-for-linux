const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const APP_DIR = path.join(__dirname, '..', '..', 'app');
const MAIN_DIST = path.join(APP_DIR, 'main-dist');

// Ported from realdtn2/zalo-linux-2026 (commits 5d5d633 + cc2bb18).
// Fixes "Can't paste images from clipboard" (issue #23) on the upstream
// build, which ships a current Zalo core but lacks this fix.
//
// Two parts:
//   1. Native helpers added to the $zelectronNative bridge in every preload.
//      Anchored on `getClipboardText:()=>r.clipboard.readText(),` — `r` is
//      the electron module (r.clipboard / r.nativeImage already used here).
//      getClipboardFilePath tries xclip first (X11) then wl-paste (Wayland).
//   2. A paste-event interceptor prepended to preload-render.js that turns a
//      clipboard image (bitmap or image file) into a synthetic drag-drop onto
//      Zalo's #dragOverlayInputbox, the same path a real drag-drop uses.

const PRELOADS = [
  'preload-render.js',
  'preload-noti.js',
  'preload-sqlite.js',
  'preload-shared-worker.js',
  'compact-app-preload.js',
];

const ANCHOR = 'getClipboardText:()=>r.clipboard.readText(),';

// Minified to match surrounding code style. `r` = electron module in scope.
const HELPERS =
  'getClipboardImagePNG:()=>{let e=r.clipboard.readImage();if(e.isEmpty()){try{const buf=r.clipboard.readBuffer("image/png");if(buf&&buf.length>0){e=r.nativeImage.createFromBuffer(buf)}}catch(_){}}if(e.isEmpty())return null;return e.toPNG().toString("base64")},' +
  'getClipboardFilePath:()=>{try{const{execSync}=require("child_process");let text="";try{text=execSync("xclip -selection clipboard -t text/uri-list -o 2>/dev/null",{timeout:1000}).toString().trim()}catch(_){}if(!text){try{text=execSync("wl-paste --type text/uri-list 2>/dev/null",{timeout:1000}).toString().trim()}catch(_){}}if(!text)return null;const uri=text.split("\\n")[0].trim();if(!uri.startsWith("file://"))return null;return decodeURIComponent(uri.replace("file://",""))}catch(_){return null}},' +
  'deleteFile:p=>{try{require("fs").unlinkSync(p)}catch(_){}},' +
  'saveClipboardImageToTemp:()=>{try{const _fs=require("fs"),_os=require("os"),_path=require("path");let e=r.clipboard.readImage();if(e.isEmpty()){try{const buf=r.clipboard.readBuffer("image/png");if(buf&&buf.length>0){e=r.nativeImage.createFromBuffer(buf)}}catch(_){}}if(e.isEmpty())return null;const tmpPath=_path.join(_os.tmpdir(),"zalo_clip_"+Date.now()+".png");_fs.writeFileSync(tmpPath,e.toPNG());return tmpPath}catch(err){return String(err)}},';

const INTERCEPTOR = `// CLIPBOARD IMAGE PASTE FIX (ported from realdtn2/zalo-linux-2026)
try {
    const _fs = require('fs'), _os = require('os'), _path = require('path');
    _fs.readdirSync(_os.tmpdir()).filter(f => f.startsWith('zalo_clip_')).forEach(f => {
        try { _fs.unlinkSync(_path.join(_os.tmpdir(), f)); } catch(_) {}
    });
} catch(_) {}
window.addEventListener('DOMContentLoaded', () => {
    async function tryPasteImage() {
        if (!window.$zelectronNative) return;
        try {
            let file = null;
            const b64 = window.$zelectronNative.getClipboardImagePNG && window.$zelectronNative.getClipboardImagePNG();
            if (b64) {
                const binary = atob(b64);
                const bytes = new Uint8Array(binary.length);
                for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
                file = new File([bytes], 'image.png', { type: 'image/png' });
            } else {
                const filePath = window.$zelectronNative.getClipboardFilePath && window.$zelectronNative.getClipboardFilePath();
                if (!filePath) return;
                const ext = filePath.split('.').pop().toLowerCase();
                const imageExts = ['png','jpg','jpeg','gif','webp','bmp','tiff','tif','avif','jxl'];
                if (!imageExts.includes(ext)) return;
                const res = await fetch('file://' + filePath);
                const blob = await res.blob();
                file = new File([blob], filePath.split('/').pop(), { type: blob.type || 'image/png' });
            }
            if (!file) return;
            const dt = new DataTransfer();
            dt.items.add(file);
            const target = document.getElementById('dragOverlayInputbox');
            if (!target) return;
            target.style.display = 'block';
            target.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dt, bubbles: true }));
            target.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true }));
            target.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
        } catch(err) {}
    }
    let _lastPaste = 0;
    document.addEventListener('paste', async (e) => {
        const now = Date.now();
        if (now - _lastPaste < 200) return;
        _lastPaste = now;
        await tryPasteImage();
    }, true);
});
`;

async function main() {
  if (!fs.existsSync(MAIN_DIST)) {
    logger.warn('main-dist not present, skipping clipboard-paste patch');
    return;
  }

  let helpersPatched = 0;
  for (const name of PRELOADS) {
    const p = path.join(MAIN_DIST, name);
    if (!fs.existsSync(p)) {
      logger.warn(`${name} not found, skipping`);
      continue;
    }
    let content = fs.readFileSync(p, 'utf8');

    if (content.includes('getClipboardImagePNG')) {
      logger.dim(`${name}: helpers already present, skipping`);
    } else if (content.includes(ANCHOR)) {
      content = content.replace(ANCHOR, HELPERS + ANCHOR);
      fs.writeFileSync(p, content, 'utf8');
      helpersPatched++;
      logger.dim(`Patched ${name}: added clipboard native helpers`);
    } else {
      logger.warn(`${name}: anchor not found, skipping (Zalo layout may have changed)`);
    }
  }

  // Paste interceptor — only in preload-render.js (runs in the chat renderer)
  const renderPath = path.join(MAIN_DIST, 'preload-render.js');
  if (fs.existsSync(renderPath)) {
    let content = fs.readFileSync(renderPath, 'utf8');
    if (content.includes('CLIPBOARD IMAGE PASTE FIX')) {
      logger.dim('preload-render.js: interceptor already present, skipping');
    } else {
      fs.writeFileSync(renderPath, INTERCEPTOR + content, 'utf8');
      logger.dim('Patched preload-render.js: added paste interceptor');
    }
  }

  logger.success(`Clipboard paste fix applied (${helpersPatched} preload file(s) patched)`);
}

if (require.main === module) {
  main();
}

module.exports = { main };

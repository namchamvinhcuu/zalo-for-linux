/**
 * plugins/tray-badge/index.js
 *
 * Unread-message indicators on Linux:
 *   - System tray: the Zalo logo with a small red dot (no number). The companion
 *     patch (scripts/patches/patch-tray-badge.js) calls tray.setImage() in Zalo's
 *     badge handler; this plugin generates the "logo + dot" icon (offscreen
 *     canvas) and a plain-logo icon and exposes them on global for the patch.
 *   - Dock/launcher: the numeric count. Zalo calls app.setBadgeCount(n), but on
 *     Linux Electron only updates it for Unity launchers; most other docks
 *     (KDE/Plank/Dash-to-Dock/Latte) still listen to the same D-Bus signal, so we
 *     emit com.canonical.Unity.LauncherEntry ourselves via gdbus.
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');

const DESKTOP_ID = 'zalo.desktop';

// --- Dock numeric badge (Unity LauncherEntry over D-Bus) ---
function emitDockBadge(count) {
  const visible = count > 0 ? 'true' : 'false';
  const props = `{'count': <int64 ${count | 0}>, 'count-visible': <${visible}>}`;
  const cmd =
    'gdbus emit --session --object-path /com/canonical/Unity/LauncherEntry ' +
    '--signal com.canonical.Unity.LauncherEntry.Update ' +
    `"application://${DESKTOP_ID}" "${props}"`;
  exec(cmd, (err) => {
    if (err) console.error('[tray-badge] gdbus emit failed:', err.message);
  });
}

// --- Tray "logo + red dot" icon (drawn once, offscreen) ---
function generateDotIcon(appDir) {
  const { BrowserWindow, nativeImage } = require('electron');
  const faviconPath = path.join(appDir, 'pc-dist', 'favicon-512x512.png');

  global.__zaloTrayDefault = nativeImage.createFromPath(faviconPath);
  global.__zaloTrayDot = null;

  let faviconDataUrl;
  try {
    faviconDataUrl = global.__zaloTrayDefault.toDataURL();
  } catch (e) {
    console.error('[tray-badge] favicon read failed:', e.message);
    return;
  }

  const win = new BrowserWindow({ show: false, width: 64, height: 64 });
  win.webContents.once('did-finish-load', async () => {
    try {
      const url = await win.webContents.executeJavaScript(
        'new Promise(function(res){' +
          'var cv=document.createElement("canvas");cv.width=512;cv.height=512;' +
          'var x=cv.getContext("2d");var img=new Image();' +
          'img.onload=function(){' +
            'x.drawImage(img,0,0,512,512);' +
            'x.beginPath();x.arc(388,124,108,0,Math.PI*2);x.fillStyle="#fa3e3e";x.fill();' +
            'x.lineWidth=34;x.strokeStyle="#ffffff";x.stroke();' +
            'res(cv.toDataURL("image/png"));' +
          '};' +
          'img.onerror=function(){res(null)};' +
          'img.src=' + JSON.stringify(faviconDataUrl) + ';' +
        '})'
      );
      if (url) {
        global.__zaloTrayDot = nativeImage.createFromDataURL(url);
        console.error('[tray-badge] dot icon ready');
      } else {
        console.error('[tray-badge] dot draw returned null');
      }
    } catch (e) {
      console.error('[tray-badge] dot gen failed:', e.message);
    }
    try { win.destroy(); } catch (_) {}
  });
  win.loadURL('data:text/html,<html><body></body></html>');
}

function register({ app, appDir }) {
  try { generateDotIcon(appDir); } catch (e) { console.error('[tray-badge] dot setup failed:', e.message); }

  // Hook app.setBadgeCount (Zalo calls it) to drive the dock badge.
  try {
    const orig = app.setBadgeCount.bind(app);
    Object.defineProperty(app, 'setBadgeCount', {
      value: (count) => {
        emitDockBadge(count || 0);
        return orig(count);
      },
      writable: true,
      configurable: true,
    });
    console.error('[tray-badge] dock badge hook installed');
  } catch (e) {
    console.error('[tray-badge] setBadgeCount hook failed:', e.message);
  }
}

module.exports = { register };

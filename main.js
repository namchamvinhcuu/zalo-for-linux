const { app, BrowserWindow, Menu, globalShortcut, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const appDir = fs.existsSync(path.join(__dirname, 'app'))
  ? path.join(__dirname, 'app')
  : path.join(path.dirname(process.execPath), 'app');

const iconPath = path.join(appDir, 'pc-dist', 'favicon-512x512.png');

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

let mainWindow = null;
let isAppQuitting = false;

// ---------------------------------------------------------------------------
// Plugins
// ---------------------------------------------------------------------------

const zaluxPlugin = require('./plugins/zalux');
const screenshotPlugin = require('./plugins/screenshot');
const zadarkCssPlugin = require('./plugins/zadark-css');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toggleDevTools() {
  try {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    if (win && win.webContents) {
      if (win.webContents.isDevToolsOpened()) {
        win.webContents.closeDevTools();
      } else {
        win.webContents.openDevTools({ mode: 'detach' });
      }
    }
  } catch (e) {
    console.error('Toggle DevTools failed', e);
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------

app.on('before-quit', () => {
  isAppQuitting = true;
  try { globalShortcut.unregisterAll(); } catch (_) { }
});

app.on('browser-window-created', (_evt, win) => {
  try {
    if (fs.existsSync(iconPath)) {
      win.setIcon(iconPath);
    }

    win.setMenuBarVisibility(false);
    if (win.removeMenu) win.removeMenu();
    win.autoHideMenuBar = true;

    // Track the main Zalo window (for the screenshot plugin + minimize-to-tray)
    if (!mainWindow && win.getTitle() !== 'Shared Worker') {
      mainWindow = win;
      screenshotPlugin.setMainWindow(win);
    }

    // Minimize to tray instead of closing — restore via Zalo's own tray menu
    win.on('close', (event) => {
      if (!isAppQuitting) {
        event.preventDefault();
        win.hide();
      }
    });
  } catch (e) {
    console.error('Error in browser-window-created:', e);
  }
});

// ---------------------------------------------------------------------------
// Ready
// ---------------------------------------------------------------------------

app.once('ready', () => {
  try { Menu.setApplicationMenu(null); } catch (_) { }

  // DevTools shortcut (the tray menu is provided by Zalo's own tray)
  try {
    globalShortcut.register('CommandOrControl+Shift+I', toggleDevTools);
  } catch (e) {
    console.error('DevTools shortcut registration failed:', e);
  }

  // Register plugins
  zaluxPlugin.register({ app, ipcMain, BrowserWindow, appDir });
  screenshotPlugin.register({ ipcMain });
  zadarkCssPlugin.register({ app, appDir });
});

// ---------------------------------------------------------------------------
// Bootstrap Zalo
// ---------------------------------------------------------------------------

function bootstrap() {
  const bootstrapPath = path.join(appDir, 'bootstrap.js');
  if (!fs.existsSync(bootstrapPath)) {
    console.error('Zalo bootstrap.js not found at:', bootstrapPath);
    return;
  }
  process.chdir(appDir);
  try {
    require(bootstrapPath);
  } catch (e) {
    console.error('Error loading Zalo:', e);
  }
}

bootstrap();

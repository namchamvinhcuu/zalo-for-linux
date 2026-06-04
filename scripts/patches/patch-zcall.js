// scripts/patches/patch-zcall.js
//
// Voice/video call support on Linux (route B — Wine bridge).
//
// Two independent, anchor-based, idempotent, skip-safe edits:
//   1. Un-gate the call buttons in the renderer (pc-dist) — see patchCallUiGate().
//   2. Wire the main-process engine spawn (W() in main-dist/main.js) to our route-B
//      bridge — see patchEngineSpawn(). On Linux W() currently falls into the macOS
//      branch and points at ZaloHelper.app/Contents/MacOS/ZaloCall, which doesn't exist
//      (the engine lives outside app.asar and is Mach-O anyway), so verifyMd5 rejects and
//      no engine spawns. We inject a `linux` branch pointing at app/zcall-bridge/
//      bridge-daemon.js, which talks the unix-socket control protocol Electron already
//      serves and relays it to a Wine-hosted ZaloCall.exe. See .obsidian-vault
//      Architecture/ZCall-Bridge-Recon + ZCall-Native-Engine-IPC.
//
// The md5 gate needs no handling on Linux: the spawn code is
//   p(e,u).then(t => { if (b && !t) return DID_LOAD_FAIL; ... spawn(e,[g,y]) })
// with b = ("win32"===platform) && !R, so b is false on Linux and it never bails on a
// hash mismatch — the bridge file only has to exist (verifyMd5 reads it, resolves false).
//
// NOTE (2026-06-03): an earlier revision of this patch also built an N-API
// "tracing scaffold" (nativelibs/zcall + trace.js) and wired a Linux branch
// into the app's binding.js, on the assumption that v26 drives the call engine
// through the `vcmac` / zcall_mac.node N-API surface. RE of the IPC handler
// disproved that: v26's engine is a *separate native executable* (`ZaloCall`,
// inside ZaloHelper.app) spawned by the main process and driven over two
// Unix-domain sockets — see .obsidian-vault Architecture/ZCall-Native-Engine-IPC.
// The vcmac path is legacy and never on the call path, so the tracing scaffold
// was wrong-layer and has been removed from this patch. nativelibs/zcall is
// kept in the repo only as a reference (servers/token sample in testConnect()).

const fs = require('fs-extra');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const logger = require('../utils/logger');

const ROOT = path.join(__dirname, '..', '..');
const APP_DIR = path.join(ROOT, 'app');
const BRIDGE_SRC = path.join(ROOT, 'nativelibs', 'zcall-bridge');

// The renderer hides the voice/video call buttons behind a capability check
//   isSupport() === enable_mac_call && enableCall && ie
// where `ie = Number($znode.os.release().split('.')[0]) >= 17` — a macOS Darwin
// kernel-version gate (Darwin 17 = macOS 10.13). On Linux os.release() is the
// Linux kernel (e.g. "6.14.0-..."), so 6 < 17 → ie === false → calls are hidden
// regardless of the engine. Neutralise the version comparison so `ie` is true
// on Linux too (account-level enable_call / enable_mac_call still apply).
const UI_GATE_ANCHOR = 'Number(e.split(".")[0])<17';
const UI_GATE_PATCHED = 'Number(e.split(".")[0])<0/*zfl-zcall*/';

// Master call-capability gate in the renderer:
//   isSupport() === enable_mac_call && enableCall && ie
// enable_mac_call / enableCall are server feature flags (settings.chat.enable_call
// + features.enable_mac_call) and may be off for this account/build, so fixing
// `ie` alone isn't enough. Force isSupport() true on Linux — the header still
// won't show the button for self-chat / OA / non-friends (those are separate
// checks: g===sendToMeId, isOAType, u.isFr). Minified var names are tolerated.
const IS_SUPPORT_RE =
  /isSupport\(\)\{return!!\w+\.default\.enable_mac_call&&\(\w+\.default\.enableCall&&\w+\)\}/g;
const IS_SUPPORT_PATCHED = 'isSupport(){return!0/*zfl-zcall*/}';

// Voice-call header button (audio-only, Stage 0). Its render guard is
//   if(canShowVideoCall && !isGroup){ ...render voice button... }
// where canShowVideoCall (T) further requires isSupport() && u.isFr etc. Drop
// the canShowVideoCall term so the voice button shows for any 1:1 conversation,
// independent of the capability/friend gates above.
const VOICE_GUARD_ANCHOR = 'let a=null;if(t&&!n){';
const VOICE_GUARD_PATCHED = 'let a=null;if(!n){/*zfl-zcall*/';

// chatController.makeCall bails early unless canUseIpcCall() === enable_ipc_call
// && ne(true). If the server disabled enable_ipc_call, the click is a no-op
// ("makeCall: not supported", logged to file not console). Force it true.
const IPC_CALL_RE =
  /canUseIpcCall\(\)\{return \w+\.default\.enable_ipc_call&&\w+\}/g;
const IPC_CALL_PATCHED = 'canUseIpcCall(){return!0/*zfl-zcall*/}';

// --- (2) Engine spawn: inject a Linux branch into W()'s binary-path picker. ---
// The picker is an IIFE:  return "win32"===process.platform ? <win path> : <mac path>, e
// We prepend a `"linux"===` branch that resolves `e` to the bridge daemon (sibling of
// main-dist, so `o.join(__dirname,"..","zcall-bridge","bridge-daemon.js")`). `o` (path) and
// `__dirname` are already in scope (the win32 branch uses them). The trailing `,e` of the
// IIFE still returns the final `e`. Electron then spawns it with [g,y] = [recvSock,sendSock].
const ENGINE_ANCHOR =
  '"win32"===process.platform?e=l()?o.join(__dirname,"..","native","qt-call-and-cap","ZaloCall.exe")';
const ENGINE_MARKER = '/*zfl-zcall-engine*/';
const ENGINE_LINUX_BRANCH =
  '"linux"===process.platform?e=o.join(__dirname,"..","zcall-bridge","bridge-daemon.sh")' +
  ENGINE_MARKER + ':';

async function main() {
  logger.info('Un-gating call buttons on Linux...');
  patchCallUiGate();
  logger.info('Wiring call engine spawn to the route-B bridge...');
  patchEngineSpawn();
}

function patchCallUiGate() {
  const pcDist = path.join(APP_DIR, 'pc-dist');
  if (!fs.existsSync(pcDist)) {
    logger.warn('pc-dist not found, skipping call-UI un-gate');
    return;
  }
  // The call-button code lives in different bundles per window: compact-app-pc.js
  // (compact window) and a lazy chunk under pc-dist/lazy/ (main window). Walk
  // pc-dist recursively so every copy gets patched.
  const jsFiles = walkJs(pcDist);
  let touched = 0;
  let anyAnchor = false;
  let alreadyDone = false;
  for (const p of jsFiles) {
    const f = path.relative(pcDist, p);
    let content = fs.readFileSync(p, 'utf8');
    let changed = false;

    // All edits below are applied together on a freshly-extracted bundle, so if
    // ANY marker is present this file is already done — skip to stay idempotent
    // (several patched forms still contain their own anchor and would re-apply).
    if (
      content.includes(UI_GATE_PATCHED) ||
      content.includes(IS_SUPPORT_PATCHED) ||
      content.includes(VOICE_GUARD_PATCHED) ||
      content.includes(IPC_CALL_PATCHED)
    ) {
      alreadyDone = true;
      continue;
    }
    // (a) macOS-version platform gate (ie).
    if (content.includes(UI_GATE_ANCHOR)) {
      anyAnchor = true;
      content = content.split(UI_GATE_ANCHOR).join(UI_GATE_PATCHED);
      changed = true;
    }
    // (b) master isSupport() capability gate.
    if (IS_SUPPORT_RE.test(content)) {
      anyAnchor = true;
      content = content.replace(IS_SUPPORT_RE, IS_SUPPORT_PATCHED);
      changed = true;
    }
    // (c) voice-call button render guard.
    if (content.includes(VOICE_GUARD_ANCHOR)) {
      anyAnchor = true;
      content = content.split(VOICE_GUARD_ANCHOR).join(VOICE_GUARD_PATCHED);
      changed = true;
    }
    // (d) canUseIpcCall gate.
    if (IPC_CALL_RE.test(content)) {
      anyAnchor = true;
      content = content.replace(IPC_CALL_RE, IPC_CALL_PATCHED);
      changed = true;
    }

    if (changed) {
      fs.writeFileSync(p, content, 'utf8');
      logger.dim(`Un-gated call support in pc-dist/${f}`);
      touched++;
    }
  }
  if (touched > 0) {
    logger.success('Call buttons un-gated on Linux');
    return;
  }
  if (alreadyDone) {
    logger.dim('Call-UI gates already patched, skipping');
  } else if (!anyAnchor) {
    logger.warn('Call-UI gate anchors not found — Zalo layout may have changed, skipping');
  }
}

// Inject the Linux engine-spawn branch into main-dist/main.js and stage the bridge files
// next to it (app/zcall-bridge/). Skip-safe: warns and returns on any missing piece.
function patchEngineSpawn() {
  const mainJs = path.join(APP_DIR, 'main-dist', 'main.js');
  if (!fs.existsSync(mainJs)) {
    logger.warn('main-dist/main.js not found, skipping engine-spawn wiring');
    return;
  }
  let content = fs.readFileSync(mainJs, 'utf8');

  if (content.includes('bridge-daemon.sh")' + ENGINE_MARKER)) {
    logger.dim('Engine spawn already wired to bridge (launcher), skipping');
  } else if (content.includes('bridge-daemon.js")' + ENGINE_MARKER)) {
    // Migrate an earlier injection that pointed straight at the .js (needs system node)
    // to the .sh launcher (node | Electron-as-node).
    content = content.replace('bridge-daemon.js")' + ENGINE_MARKER, 'bridge-daemon.sh")' + ENGINE_MARKER);
    fs.writeFileSync(mainJs, content, 'utf8');
    logger.success('Engine spawn migrated to bridge-daemon.sh launcher');
  } else if (!content.includes(ENGINE_ANCHOR)) {
    logger.warn('Engine-spawn anchor not found in main.js — Zalo layout may have changed, skipping');
    return;
  } else {
    content = content.replace(ENGINE_ANCHOR, ENGINE_LINUX_BRANCH + ENGINE_ANCHOR);
    fs.writeFileSync(mainJs, content, 'utf8');
    logger.success('Engine spawn wired to route-B bridge (linux branch in W())');
  }

  // Stage the bridge files where the injected path expects them: app/zcall-bridge/.
  stageBridgeFiles();
}

// Copy bridge-daemon.js (+ bridge-shim.exe, built on demand) into app/zcall-bridge/.
function stageBridgeFiles() {
  const destDir = path.join(APP_DIR, 'zcall-bridge');
  const daemonSrc = path.join(BRIDGE_SRC, 'bridge-daemon.js');
  if (!fs.existsSync(daemonSrc)) {
    logger.warn(`bridge-daemon.js missing at ${daemonSrc} — calls will not connect`);
    return;
  }
  fs.ensureDirSync(destDir);

  const daemonDest = path.join(destDir, 'bridge-daemon.js');
  fs.copySync(daemonSrc, daemonDest);
  fs.chmodSync(daemonDest, 0o755);
  logger.dim('Staged app/zcall-bridge/bridge-daemon.js');

  // Launcher W() actually spawns (no system Node required): sh wrapper -> node | Electron-as-node.
  const launchSrc = path.join(BRIDGE_SRC, 'bridge-daemon.sh');
  if (fs.existsSync(launchSrc)) {
    const launchDest = path.join(destDir, 'bridge-daemon.sh');
    fs.copySync(launchSrc, launchDest);
    fs.chmodSync(launchDest, 0o755);
    logger.dim('Staged app/zcall-bridge/bridge-daemon.sh');
  } else {
    logger.warn('bridge-daemon.sh missing — W() launch will need system node');
  }

  const shim = ensureShim();
  if (shim) {
    fs.copySync(shim, path.join(destDir, 'bridge-shim.exe'));
    logger.dim('Staged app/zcall-bridge/bridge-shim.exe');
  } else {
    logger.warn('bridge-shim.exe unavailable (need gcc-mingw-w64-i686) — Wine engine bridge disabled');
  }

  stageBundle(destDir);
}

// Stage the self-contained pieces (approach A) into app/zcall-bridge/: a portable Wine and
// the trimmed call engine. Sources are env-overridable (defaults match dev1-pc). Big copies,
// so idempotent (skip if already staged unless ZCALL_BUNDLE_FORCE). Best-effort: if a source
// is missing, the daemon falls back at runtime (system wine / prefix engine), so the pipeline
// never breaks.
function stageBundle(destDir) {
  const force = !!process.env.ZCALL_BUNDLE_FORCE;
  const wineSrc = process.env.ZCALL_BUNDLE_WINE ||
    path.join(os.homedir(), 'Namchamvinhcuu-Wine-Apps', '_wine-bundle', 'wine-11.10-amd64-wow64');
  const engineSrc = process.env.ZCALL_BUNDLE_ENGINE ||
    path.join(os.homedir(), 'Namchamvinhcuu-Wine-Apps', 'Zalo', 'drive_c', 'zalo-engine');

  // Portable Wine.
  const wineDest = path.join(destDir, 'wine');
  if (fs.existsSync(path.join(wineSrc, 'bin', 'wine'))) {
    if (force || !fs.existsSync(path.join(wineDest, 'bin', 'wine'))) {
      logger.info('Staging bundled Wine (~800MB, one-time)...');
      fs.removeSync(wineDest);
      // Preserve symlinks — Wine's bin/ tools are symlinks to the loader (argv[0] dispatch)
      // and lib/ has version symlinks; dereferencing breaks the tree.
      fs.copySync(wineSrc, wineDest, { dereference: false });
      logger.dim('Staged app/zcall-bridge/wine');
    } else {
      logger.dim('Bundled Wine already staged, skipping');
    }
  } else {
    logger.warn(`Bundled Wine not found at ${wineSrc} — AppImage falls back to system wine`);
  }

  // Call engine, trimmed: drop meeting/screen-capture binaries + PDBs (not needed for 1:1 calls).
  const engineDest = path.join(destDir, 'engine');
  const ENGINE_SKIP = new Set(['ZaviMeet.exe', 'ZaloCap.exe', 'Zalo.exe', 'pdbs']);
  if (fs.existsSync(path.join(engineSrc, 'ZaloCall.exe'))) {
    if (force || !fs.existsSync(path.join(engineDest, 'ZaloCall.exe'))) {
      logger.info('Staging bundled call engine (trimmed)...');
      fs.removeSync(engineDest);
      fs.copySync(engineSrc, engineDest, { filter: (src) => !ENGINE_SKIP.has(path.basename(src)) });
      logger.dim('Staged app/zcall-bridge/engine (trimmed)');
    } else {
      logger.dim('Bundled engine already staged, skipping');
    }
  } else {
    logger.warn(`Bundled engine not found at ${engineSrc} — AppImage falls back to prefix engine`);
  }
}

// Return path to bridge-shim.exe, building it via mingw if absent. null if unbuildable.
function ensureShim() {
  const shim = path.join(BRIDGE_SRC, 'bridge-shim.exe');
  if (fs.existsSync(shim)) return shim;
  try {
    execFileSync('i686-w64-mingw32-gcc',
      ['-O2', '-Wall', '-static', '-o', 'bridge-shim.exe', 'bridge-shim.c', '-lkernel32'],
      { cwd: BRIDGE_SRC, stdio: 'pipe' });
    if (fs.existsSync(shim)) { logger.dim('Built bridge-shim.exe via mingw'); return shim; }
  } catch (_) { /* mingw missing or build failed */ }
  return null;
}

// Recursively collect *.js paths under dir.
function walkJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJs(p));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

if (require.main === module) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}

module.exports = { main };

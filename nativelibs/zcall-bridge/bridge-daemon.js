#!/usr/bin/env node
// bridge-daemon.js — Linux-side half of the route-B call bridge.
//
// Spawned by zalo-for-linux's Electron from W() exactly like the native engine would be:
//   spawn(<this>, [recvSocketPath, sendSocketPath])   // argv[2]=g (recv), argv[3]=y (send)
// Electron has already created the two unix-socket SERVERS at those paths and is the
// server; we connect to them as the client (the role the native engine plays).
//
// It then launches the Wine half (bridge-shim.exe -> ZaloCall.exe) and translates between
// the two transports. The translation is NOT a raw forward — the two ends differ:
//
//   Electron unix socket (send, y): chunked `buildListMsgs` + stop-and-wait flow control.
//     We must REASSEMBLE chunks (payload#id#total#idx#$) into whole frames AND write a
//     byte back after every chunk so Electron's `x=!1, G(e)` drains the next one. (The
//     Windows engine never sends these acks — Windows uses the raw `z` path — so we
//     synthesize them.)  Single-chunk messages arrive as a plain `hex$` token.
//   Electron unix socket (recv, g): we WRITE whole `hex$` event frames; Electron's Y
//     splits on `$` per data event, so we only ever write complete frames.
//   Engine (via shim stdio): raw `hex$` both directions.
//
// See ZCall-Native-Engine-IPC §"SEND path" and ZCall-Bridge-Recon §"Bước 5".
//
// Config via env (sensible dev defaults for dev1-pc):
//   ZCALL_WINEPREFIX  Wine prefix (default ~/Wine-Apps/zalo-2112)
//   ZCALL_ENGINE_DIR  dir holding ZaloCall.exe + DLLs (default <prefix>/drive_c/zalo-engine)
//   ZCALL_SHIM_EXE    path to bridge-shim.exe (default alongside this script)
//   ZCALL_WINE        wine binary (default "wine")
//   ZCALL_DEBUG       if set, verbose stderr logging

const net = require('net');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');

const HOME = os.homedir();
const WINEPREFIX = process.env.ZCALL_WINEPREFIX || path.join(HOME, 'Namchamvinhcuu-Wine-Apps', 'Zalo');
const SHIM_EXE   = process.env.ZCALL_SHIM_EXE   || path.join(__dirname, 'bridge-shim.exe');
const DEBUG      = !!process.env.ZCALL_DEBUG;
const BUNDLE_WINE_DIR = path.join(__dirname, 'wine'); // shipped portable Wine, if bundled

// Wine + engine resolve to copies bundled alongside this script (shipped in the AppImage
// under app/zcall-bridge/{wine,engine}) when present; else env override; else system/prefix.
function resolveWine() {
  const bundled = path.join(BUNDLE_WINE_DIR, 'bin', 'wine');
  return fs.existsSync(bundled) ? bundled : (process.env.ZCALL_WINE || 'wine');
}
function resolveEngineDir() {
  const bundled = path.join(__dirname, 'engine');
  if (fs.existsSync(path.join(bundled, 'ZaloCall.exe'))) return bundled;
  return process.env.ZCALL_ENGINE_DIR || path.join(WINEPREFIX, 'drive_c', 'zalo-engine');
}
const WINE = resolveWine();
const ENGINE_DIR = resolveEngineDir();

// Env for every Wine invocation: dedicated prefix + (if bundled) the bundled wineserver/
// loader, so we never touch the user's system Wine. LD_LIBRARY_PATH is left untouched — the
// kron4ek loader resolves its own libs — to avoid leaking into other child processes.
function wineEnv(extra) {
  const env = { ...process.env, WINEPREFIX, WINEDEBUG: process.env.WINEDEBUG || '-all', ...extra };
  if (fs.existsSync(path.join(BUNDLE_WINE_DIR, 'bin', 'wineserver'))) {
    env.WINESERVER = path.join(BUNDLE_WINE_DIR, 'bin', 'wineserver');
    env.WINELOADER = WINE;
  }
  return env;
}

// First run: initialize the dedicated prefix (wineboot -i), skipping gecko/mono (the engine
// is Qt, not .NET/HTML) so it doesn't hang. Detected as done by system.reg presence.
function ensurePrefix() {
  return new Promise((resolve) => {
    const reg = path.join(WINEPREFIX, 'system.reg');
    if (fs.existsSync(reg)) {
      // Stale-arch guard: the bundled Wine is wow64 and needs a win64 prefix. A win32 prefix
      // (e.g. left by an older/system-wine setup) makes the 32-bit engine fail to load
      // (kernel32 c0000135) — recreate it. The engine lives in the bundle, never the prefix,
      // so wiping prefix state is safe.
      const usingBundledWine = fs.existsSync(path.join(BUNDLE_WINE_DIR, 'bin', 'wine'));
      let staleArch = false;
      if (usingBundledWine) {
        try { staleArch = /#arch=win32/.test(fs.readFileSync(reg, 'utf8').slice(0, 256)); } catch (_) {}
      }
      if (!staleArch) return resolve();
      log('prefix is win32 but bundled Wine needs win64 — recreating...');
      try { fs.rmSync(WINEPREFIX, { recursive: true, force: true }); } catch (_) {}
    }
    log('initializing wine prefix (first run, ~30-60s)...');
    const wb = spawn(WINE, ['wineboot', '-i'], {
      env: wineEnv({ WINEDLLOVERRIDES: 'mscoree,mshtml=' }), stdio: 'ignore',
    });
    wb.on('exit', () => { log('prefix initialized'); resolve(); });
    wb.on('error', (e) => { log('prefix init error (continuing):', e.message); resolve(); });
  });
}

// Pipe names handed to the Windows engine. Arbitrary (the engine takes them via argv);
// kept identical to the Windows defaults for familiarity.
const PIPE_RECV = '\\\\.\\pipe\\PipeZCallRecv';
const PIPE_SEND = '\\\\.\\pipe\\PipeZCallSend';

const recvPath = process.argv[2]; // g: engine -> Electron (we WRITE events here)
const sendPath = process.argv[3]; // y: Electron -> engine (we READ commands, WRITE acks)

// When Electron spawns us its stdio is piped into Zalo's own logger, so console output is
// hard to observe. ZCALL_LOG (a file path) gives a direct, always-on trace channel.
const LOG_FILE = process.env.ZCALL_LOG || null;
function emit(line) {
  if (DEBUG) console.error(line);
  if (LOG_FILE) { try { fs.appendFileSync(LOG_FILE, new Date().toISOString() + ' ' + line + '\n'); } catch (_) {} }
}
function log(...a) { emit('[zcall-bridge] ' + a.join(' ')); }
function fatal(...a) { emit('[zcall-bridge] FATAL ' + a.join(' ')); process.exit(1); }

if (!recvPath || !sendPath) fatal('need argv: <recvSocketPath> <sendSocketPath>');

log('recv(g)=', recvPath, 'send(y)=', sendPath);
log('WINEPREFIX=', WINEPREFIX, 'ENGINE_DIR=', ENGINE_DIR, 'SHIM=', SHIM_EXE);

let shim = null;

// After the prefix is ready, launch the Wine half and wire both sockets.
function start() {
  // --- Launch the Wine half: shim spawns ZaloCall.exe and pumps raw hex$ over stdio. ---
  // Wine's own stderr (page faults etc.) -> ZCALL_WINE_LOG if set, else inherit.
  const wineErr = process.env.ZCALL_WINE_LOG ? fs.openSync(process.env.ZCALL_WINE_LOG, 'a') : 'inherit';
  shim = spawn(WINE, [SHIM_EXE, PIPE_RECV, PIPE_SEND], {
    cwd: ENGINE_DIR,
    env: wineEnv(),
    stdio: ['pipe', 'pipe', wineErr], // stdin=commands->shim, stdout=events<-shim
  });
  shim.on('error', (e) => fatal('cannot launch wine shim:', e.message));
  shim.on('exit', (code, sig) => { log('shim exited', code, sig); process.exit(code || 0); });

  // --- Electron recv socket (g): we write whole event frames the engine emitted. ---
  const recvSock = net.connect(recvPath);
  recvSock.on('error', (e) => fatal('recv socket:', e.message));
  recvSock.on('connect', () => log('connected recv socket (g)'));

  // shim stdout = raw hex$ event stream from engine. Split on `$` and forward WHOLE frames
  // to Electron (Y reassembles nothing, so a frame must arrive in one piece).
  let evtBuf = Buffer.alloc(0);
  shim.stdout.on('data', (d) => {
    evtBuf = Buffer.concat([evtBuf, d]);
    let i;
    while ((i = evtBuf.indexOf(0x24)) !== -1) { // 0x24 = '$'
      const frame = evtBuf.subarray(0, i + 1);  // include the '$'
      evtBuf = evtBuf.subarray(i + 1);
      log('EVT ->Electron', frame.length, 'bytes');
      recvSock.write(frame);
    }
  });

  // --- Electron send socket (y): read chunked commands, reassemble, ack, forward. ---
  const sendSock = net.connect(sendPath);
  sendSock.on('error', (e) => fatal('send socket:', e.message));
  sendSock.on('connect', () => log('connected send socket (y)'));

  // After consuming each chunk/frame, write a byte so Electron's serverSend `e.on("data")`
  // fires `x=!1, G(e)` and releases the next queued chunk. Content is ignored by Electron.
  const ack = () => { try { sendSock.write(Buffer.from([0x06])); } catch (_) {} };

  const pending = Object.create(null); // id -> { total, parts:[], count }
  // Chunk token (after stripping the `$`): <hexpayload>#<id>#<total>#<idx>#
  const CHUNK_RE = /^([0-9a-fA-F]*)#(\d+)#(\d+)#(\d+)#$/;

  let cmdBuf = '';
  sendSock.on('data', (chunk) => {
    cmdBuf += chunk.toString('latin1');
    let i;
    while ((i = cmdBuf.indexOf('$')) !== -1) {
      const tok = cmdBuf.slice(0, i);
      cmdBuf = cmdBuf.slice(i + 1);
      if (tok.length === 0) { ack(); continue; }

      const m = CHUNK_RE.exec(tok);
      if (m) {
        const payload = m[1], id = m[2], total = +m[3], idx = +m[4];
        let p = pending[id] || (pending[id] = { total, parts: new Array(total).fill(null), count: 0 });
        if (p.parts[idx] === null) { p.parts[idx] = payload; p.count++; }
        ack();
        if (p.count === p.total) {
          const whole = p.parts.join('');
          delete pending[id];
          log('CMD ->engine (reassembled', total, 'chunks)', whole.length, 'hex');
          shim.stdin.write(whole + '$');
        }
      } else {
        // Plain single-frame command (buildListMsgs i<=1 path: [hex+"$"]).
        log('CMD ->engine (single)', tok.length, 'hex');
        shim.stdin.write(tok + '$');
        ack();
      }
    }
  });
}

process.on('SIGINT', () => { try { shim && shim.kill('SIGINT'); } catch (_) {} process.exit(0); });
process.on('SIGTERM', () => { try { shim && shim.kill('SIGTERM'); } catch (_) {} process.exit(0); });

log('wine=', WINE, 'engine=', ENGINE_DIR);
ensurePrefix().then(start);

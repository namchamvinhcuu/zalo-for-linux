#!/usr/bin/env node
// mock-electron.js — test rig for the route-B bridge (step b), standalone.
//
// Replicates exactly what zalo-for-linux's Electron does in W() on Linux, so we can
// exercise bridge-daemon.js + bridge-shim.exe + the real engine WITHOUT patching the app
// or logging into Zalo:
//   - creates the two unix-socket SERVERS (recv g, send y),
//   - spawns the bridge-daemon with [g, y] (the native-engine spawn contract),
//   - reads engine events via the real read path Y (split `$`, AES-128-CBC decrypt),
//   - sends commands via the real send path V (buildListMsgs chunking + stop-and-wait),
//   - on native-ready, fires a small command and a large (multi-chunk) command to
//     exercise reassembly + the synthesized ack loop.
//
// Pass/fail is printed at the end. Run:
//   node mock-electron.js
// (uses the same env knobs as bridge-daemon.js for prefix/engine/shim paths)

const net = require('net');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const G = '/tmp/socketzalorecv2021'; // recv: engine -> Electron (we READ via Y)
const Y_PATH = '/tmp/socketzalosend2021'; // send: Electron -> engine (we WRITE via V)
const DAEMON = path.join(__dirname, 'bridge-daemon.js');

// --- crypto: identical to Electron module vqv6 ---
const KEY = Buffer.from('yjAF9oqMWl6XfXYJn9mA7w==', 'base64');
const IV = Buffer.alloc(16, 0);
function encrypt(json) {
  const c = crypto.createCipheriv('aes-128-cbc', KEY, IV);
  return Buffer.concat([c.update(json, 'utf8'), c.final()]).toString('hex');
}
function decrypt(hex) {
  const d = crypto.createDecipheriv('aes-128-cbc', KEY, IV);
  return Buffer.concat([d.update(Buffer.from(hex, 'hex')), d.final()]).toString('utf8').replace(/\0/g, '');
}

// --- buildListMsgs: identical to Electron module 4KIH ---
let seq = 1;
function buildListMsgs(e) {
  const n = 4000;
  const i = Math.floor((e.length + n - 1) / n);
  const o = (seq = Math.max(seq + 1, Date.now()), seq);
  if (i <= 1) return [e + '$'];
  const t = [];
  for (let r = 0; r < i; r++) { t.push(e.slice(0, n) + `#${o}#${i}#${r}#$`); cut(); }
  function cut() { e = e.slice(n); }
  return t;
}

// --- send path V/G/$ with stop-and-wait flow control (Electron non-win32) ---
let sendConn = null, F = false, x = false;
const k = []; // chunk queue
function G_drain() {
  if (!F) return;
  if (x) return;
  if (k.length) { const t = k.shift(); x = true; sendConn.write(t); }
}
function V(obj) {
  const r = buildListMsgs(encrypt(JSON.stringify(obj)));
  k.push(...r);
  G_drain();
}

// --- test state ---
let gotNativeReady = false, sentSmall = false, sentLarge = false;
const results = [];
function done(ok, msg) { results.push([ok, msg]); console.log(ok ? 'PASS' : 'FAIL', '-', msg); }

// --- read path Y (engine -> Electron events) ---
function Y(buf) {
  const parts = buf.toString('latin1').split(/\$/gm);
  for (const r of parts) {
    if (!r) continue;
    try {
      const obj = JSON.parse(decrypt(r));
      console.log('  EVT from engine:', JSON.stringify(obj));
      if (obj.type === 'update' && obj.command === 'native-ready' && !gotNativeReady) {
        gotNativeReady = true;
        done(true, 'engine reached native-ready through the bridge');
        runCommandTests();
      }
    } catch (e) {
      console.log('  EVT (undecryptable token, len ' + r.length + ')');
    }
  }
}

function runCommandTests() {
  // Single-frame command (buildListMsgs i<=1 -> [hex+"$"]). Use a benign unknown command
  // so the engine's dispatch doesn't enter a field-dereferencing handler (e.g. updateLocal
  // with empty data null-derefs and page-faults — that crash separately CONFIRMED that the
  // send path delivers fully decryptable/parsable frames to the live engine).
  console.log('-> sending small command (single frame)');
  V({ type: 'update', command: 'bridge-selftest-small', data: {} });
  sentSmall = true;

  // Large command forcing multi-chunk (>4000 hex). Exercises buildListMsgs chunking +
  // the synthesized per-chunk ack (stop-and-wait). Unknown command keeps the engine alive.
  setTimeout(() => {
    const blob = 'A'.repeat(6000); // ~6000B plaintext -> ~12000 hex -> 4 chunks
    const obj = { type: 'update', command: 'bridge-selftest-large', data: { filler: blob } };
    const hex = encrypt(JSON.stringify(obj));
    const nChunks = Math.floor((hex.length + 3999) / 4000);
    console.log(`-> sending large command: ${hex.length} hex -> ${nChunks} chunks (watch daemon log for "reassembled ${nChunks} chunks ${hex.length} hex")`);
    V(obj);
    sentLarge = true;
  }, 500);

  // verdict after the flow has had time to drain
  setTimeout(finish, 3500);
}

let finished = false;
function finish() {
  if (finished) return; finished = true;
  // If the chunk queue fully drained, every chunk was acked by the daemon (stop-and-wait
  // worked). x should be false and k empty.
  done(sentLarge && k.length === 0 && !x, `send-path drained (queue empty, x=${x}) — multi-chunk + stop-and-wait acks worked`);
  const allPass = results.every(([ok]) => ok);
  console.log('\n=== ' + (allPass ? 'ALL PASS' : 'SOME FAILED') + ' ===');
  cleanup();
  process.exit(allPass ? 0 : 1);
}

let daemon = null;
function cleanup() {
  try { daemon && daemon.kill('SIGINT'); } catch (_) {}
  try { fs.unlinkSync(G); } catch (_) {}
  try { fs.unlinkSync(Y_PATH); } catch (_) {}
}

// --- set up servers, then spawn the daemon (the W() contract) ---
for (const p of [G, Y_PATH]) { try { fs.unlinkSync(p); } catch (_) {} }

const recvServer = net.createServer((conn) => {
  console.log('recv(g): daemon connected');
  conn.on('error', () => {});
  conn.on('data', Y);
});
const sendServer = net.createServer((conn) => {
  console.log('send(y): daemon connected');
  sendConn = conn; F = true; x = false;
  conn.on('error', () => {});
  conn.on('data', () => { x = false; G_drain(); }); // ack from daemon -> drain next chunk
});

const WINE_LOG = '/tmp/zcall-wine.log';
recvServer.listen(G, () => {
  sendServer.listen(Y_PATH, () => {
    console.log('servers listening; spawning daemon (wine stderr -> ' + WINE_LOG + ')');
    daemon = spawn(process.execPath, [DAEMON, G, Y_PATH], {
      env: { ...process.env, ZCALL_DEBUG: '1', ZCALL_WINE_LOG: WINE_LOG },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    daemon.on('exit', (code) => {
      if (!gotNativeReady) { done(false, 'daemon exited before native-ready (code ' + code + ')'); finish(); }
    });
  });
});

setTimeout(() => { if (!gotNativeReady) { done(false, 'timeout: no native-ready in 20s'); finish(); } }, 20000);

// nativelibs/zcall/trace.js
//
// Stage-0 instrumentation wrapper for the zcall Linux scaffold.
//
// Wraps the native `{ MainApp }` export so every N-API method call the JS layer
// (app/native/nativelibs/zcall/vcmac.js) makes is logged WITH its arguments
// before being forwarded to the (stub) native instance.
//
// Goal: capture the real engine inputs the HTTPS signaling layer feeds the
// engine during a real outgoing call on Linux — the `servers` list, `callId`,
// `genSession`, token material and `config` blob — even though the stub never
// actually connects. (Historical recon helper; the working call path is the
// route-B Wine bridge in ../zcall-bridge.)
//
// Dependency-free (must run inside the packaged Electron app). Writes a JSONL
// trace file plus a short line to stderr per call. Activated only when the app
// is launched with ZCALL_LINUX set (see scripts/patches/patch-zcall.js); the
// log path can be overridden with ZCALL_TRACE_FILE.

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

// The engine may load in a child/utility process that does NOT inherit our env
// (ZCALL_TRACE_FILE) and whose os.tmpdir() differs, so default to a fixed,
// env-independent path under the user's home dir. Override with ZCALL_TRACE_FILE
// only takes effect in processes that actually carry it.
const LOG_FILE =
  process.env.ZCALL_TRACE_FILE || path.join(os.homedir(), 'zcall-trace.jsonl');

// Render one argument for the trace. JS strings here are frequently JSON
// (config / servers list) — parse them so the dump is structured, not escaped.
function serializeArg(a) {
  const t = typeof a;
  if (t === 'function') return '[Function]';
  if (t === 'undefined') return '[undefined]';
  if (a === null) return null;
  if (Buffer.isBuffer(a)) return `[Buffer ${a.length}B]`;
  if (t === 'string') {
    const s = a.trim();
    if (
      (s.startsWith('{') && s.endsWith('}')) ||
      (s.startsWith('[') && s.endsWith(']'))
    ) {
      try {
        return JSON.parse(s);
      } catch (e) {
        /* not JSON after all — keep the raw string */
      }
    }
    return a;
  }
  return a;
}

let seq = 0;
function record(method, args) {
  const entry = {
    seq: seq++,
    t: new Date().toISOString(),
    method,
    args: Array.prototype.map.call(args, serializeArg),
  };
  let line;
  try {
    line = JSON.stringify(entry);
  } catch (e) {
    line = JSON.stringify({
      seq: entry.seq,
      t: entry.t,
      method,
      args: '[unserializable]',
    });
  }
  try {
    fs.appendFileSync(LOG_FILE, line + '\n');
  } catch (e) {
    /* never let tracing break the call path */
  }
  try {
    process.stderr.write(`[zcall-trace] #${entry.seq} ${method}(${entry.args.length} args)\n`);
  } catch (e) {
    /* ignore */
  }
}

// Proxy the native ObjectWrap instance: log on every method invocation, then
// forward to the real (stub) implementation so the JS layer keeps running.
function wrapInstance(inst) {
  return new Proxy(inst, {
    get(target, prop) {
      const val = target[prop];
      if (typeof prop === 'symbol' || typeof val !== 'function') {
        return val;
      }
      return function (...args) {
        record(String(prop), args);
        return val.apply(target, args);
      };
    },
  });
}

module.exports = function traceNative(native) {
  // Fresh log per app start so a capture run is self-contained.
  try {
    fs.writeFileSync(LOG_FILE, `# zcall trace ${new Date().toISOString()}\n`);
  } catch (e) {
    /* ignore */
  }
  try {
    process.stderr.write(`[zcall-trace] active — logging N-API calls to ${LOG_FILE}\n`);
  } catch (e) {
    /* ignore */
  }
  return {
    MainApp() {
      return wrapInstance(native.MainApp());
    },
  };
};

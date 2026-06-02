/**
 * plugins/tray-badge/dbus-launcher.js
 *
 * Minimal, zero-dependency D-Bus session-bus client whose only job is to emit
 * the Unity LauncherEntry "Update" signal (the dock/launcher unread badge).
 *
 * Why not just `gdbus emit`? Plank (and most LauncherEntry receivers) tie a
 * launcher entry to the *lifetime of the D-Bus connection that emitted it*.
 * `gdbus emit` spawns a throwaway process that disconnects from the bus
 * immediately, so the receiver drops the entry the instant it appears — the
 * badge never shows. We therefore keep ONE persistent connection open for the
 * whole app lifetime and re-emit on it whenever the count changes.
 *
 * We speak just enough of the wire protocol to: SASL EXTERNAL auth, send Hello,
 * then emit a single SIGNAL message with body signature `sa{sv}`. Everything is
 * little-endian. Incoming traffic is drained and ignored.
 */

'use strict';

const net = require('net');

const PATH = '/com/canonical/Unity/LauncherEntry';
const IFACE = 'com.canonical.Unity.LauncherEntry';
const MEMBER = 'Update';

// --- alignment-aware little-endian writer -----------------------------------
// Offsets are tracked from the buffer's own start. Callers guarantee that a
// buffer's start corresponds to an 8-byte boundary in the message stream, so
// buffer-relative alignment equals stream alignment.
class W {
  constructor() { this.chunks = []; this.len = 0; }
  _push(buf) { this.chunks.push(buf); this.len += buf.length; }
  pad(align) {
    const m = this.len % align;
    if (m) this._push(Buffer.alloc(align - m));
  }
  byte(v) { this._push(Buffer.from([v & 0xff])); }
  u32(v) { this.pad(4); const b = Buffer.alloc(4); b.writeUInt32LE(v >>> 0, 0); this._push(b); }
  i64(v) { this.pad(8); const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v), 0); this._push(b); }
  str(s) { const sb = Buffer.from(s, 'utf8'); this.u32(sb.length); this._push(sb); this.byte(0); }
  sig(s) { const sb = Buffer.from(s, 'utf8'); this.byte(sb.length); this._push(sb); this.byte(0); }
  buffer() { return Buffer.concat(this.chunks, this.len); }
}

// One header field: STRUCT(BYTE code, VARIANT value), struct aligned to 8.
function headerField(w, code, sigChar, value) {
  w.pad(8);
  w.byte(code);
  w.sig(sigChar);
  if (sigChar === 'g') w.sig(value);   // SIGNATURE
  else w.str(value);                   // OBJECT_PATH ('o') and STRING ('s') marshal alike
}

// Marshal a complete message; returns a Buffer.
function message({ type, flags, serial, fields, body }) {
  const bodyBuf = body || Buffer.alloc(0);

  // Header fields array content. Its first element sits at message offset 16
  // (8-aligned), so a writer starting at virtual-0 aligns identically.
  const fw = new W();
  for (const f of fields) headerField(fw, f.code, f.sig, f.value);
  const fieldsBuf = fw.buffer();

  const h = new W();
  h.byte(0x6c);            // 'l' little-endian
  h.byte(type);
  h.byte(flags);
  h.byte(1);               // protocol version
  h.u32(bodyBuf.length);   // body length
  h.u32(serial);           // serial (nonzero)
  h.u32(fieldsBuf.length); // header fields array byte length
  h.pad(8);                // pad to first array element (excluded from length)
  h._push(fieldsBuf);
  h.pad(8);                // pad whole header to 8 before body
  return Buffer.concat([h.buffer(), bodyBuf]);
}

function helloMessage(serial) {
  return message({
    type: 1, flags: 0, serial,
    fields: [
      { code: 1, sig: 'o', value: '/org/freedesktop/DBus' },      // PATH
      { code: 6, sig: 's', value: 'org.freedesktop.DBus' },        // DESTINATION
      { code: 2, sig: 's', value: 'org.freedesktop.DBus' },        // INTERFACE
      { code: 3, sig: 's', value: 'Hello' },                       // MEMBER
    ],
  });
}

function updateSignal(serial, appUri, count, visible) {
  // body: s a{sv}  →  app_uri, { count: <int64>, count-visible: <bool> }
  const body = new W();
  body.str(appUri);

  const dict = new W();          // starts 8-aligned in the stream (see message())
  dict.pad(8); dict.str('count');         dict.sig('x'); dict.i64(count);
  dict.pad(8); dict.str('count-visible'); dict.sig('b'); dict.u32(visible ? 1 : 0);
  const dictBuf = dict.buffer();

  body.u32(dictBuf.length);      // array byte length
  body.pad(8);                   // align first element (excluded from length)
  body._push(dictBuf);

  return message({
    type: 4, flags: 1, serial,   // SIGNAL, NO_REPLY_EXPECTED
    fields: [
      { code: 1, sig: 'o', value: PATH },
      { code: 2, sig: 's', value: IFACE },
      { code: 3, sig: 's', value: MEMBER },
      { code: 8, sig: 'g', value: 'sa{sv}' },   // SIGNATURE
    ],
    body: body.buffer(),
  });
}

function busPath() {
  const addr = process.env.DBUS_SESSION_BUS_ADDRESS || '';
  const m = /unix:path=([^,;]+)/.exec(addr) || /unix:abstract=([^,;]+)/.exec(addr);
  if (m) return m[0].startsWith('unix:abstract=') ? '\0' + m[1] : m[1];
  return `/run/user/${process.getuid()}/bus`;
}

class DockBadge {
  constructor(appUri) {
    this.appUri = appUri;
    this.sock = null;
    this.ready = false;
    this.serial = 1;       // Hello uses 1; signals start at 2
    this.pending = null;   // latest {count} to flush once ready
    this.connect();
  }

  connect() {
    let sock;
    try { sock = net.createConnection(busPath()); }
    catch (e) { console.error('[tray-badge] dbus connect failed:', e.message); return; }
    this.sock = sock;
    let phase = 'auth';
    let rxText = '';

    sock.on('error', (e) => { console.error('[tray-badge] dbus socket error:', e.message); });
    sock.on('close', () => { this.ready = false; this.sock = null; });

    sock.on('connect', () => {
      const uidHex = Buffer.from(String(process.getuid()), 'ascii').toString('hex');
      sock.write('\0AUTH EXTERNAL ' + uidHex + '\r\n');
    });

    sock.on('data', (buf) => {
      if (phase === 'binary') return;            // drain & ignore binary replies
      rxText += buf.toString('latin1');
      const nl = rxText.indexOf('\r\n');
      if (nl === -1) return;
      const line = rxText.slice(0, nl);
      rxText = rxText.slice(nl + 2);
      if (line.startsWith('OK')) {
        sock.write('BEGIN\r\n');
        phase = 'binary';
        sock.write(helloMessage(1));
        this.ready = true;
        if (this.pending != null) { const c = this.pending; this.pending = null; this.setCount(c); }
      } else {
        console.error('[tray-badge] dbus auth rejected:', line);
        sock.end();
      }
    });
  }

  setCount(count) {
    const n = count | 0;
    if (!this.ready || !this.sock) { this.pending = n; if (!this.sock) this.connect(); return; }
    try {
      this.serial += 1;
      this.sock.write(updateSignal(this.serial, this.appUri, n, n > 0));
    } catch (e) {
      console.error('[tray-badge] dbus emit failed:', e.message);
    }
  }
}

module.exports = { DockBadge };

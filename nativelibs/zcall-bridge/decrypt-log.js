#!/usr/bin/env node
// decrypt-log.js — parse pipe-mitm.log and decrypt each frame.
//
// Usage:
//   node decrypt-log.js ~/Wine-Apps/zalo/drive_c/users/namchamvinhcuu/Temp/pipe-mitm.log
//   node decrypt-log.js ~/Wine-Apps/zalo/drive_c/users/namchamvinhcuu/Temp/pipe-mitm.log --tail
//
// Frames in the log look like:
//   [HH:MM:SS.mmm] [CMD] 193 bytes:
//   fe851d60520d2931...$
//
// We split on '$' (the framing delimiter per vault) and decrypt each hex chunk
// with AES-128-CBC, key = base64('yjAF9oqMWl6XfXYJn9mA7w=='), IV = zeros.

const fs = require('fs');
const crypto = require('crypto');
const readline = require('readline');

const KEY = Buffer.from('yjAF9oqMWl6XfXYJn9mA7w==', 'base64');
const IV  = Buffer.alloc(16, 0);

function decryptFrame(hex) {
    try {
        const ct = Buffer.from(hex, 'hex');
        if (ct.length === 0 || ct.length % 16 !== 0) {
            return { error: `bad ct length ${ct.length}` };
        }
        const dec = crypto.createDecipheriv('aes-128-cbc', KEY, IV);
        const pt = Buffer.concat([dec.update(ct), dec.final()]);
        return { plaintext: pt.toString('utf8') };
    } catch (e) {
        return { error: e.message };
    }
}

function processChunk(timestamp, direction, payload) {
    // payload is one log line containing one or more "<hex>$<hex>$..." chunks
    const frames = payload.split('$').filter(s => s.length > 0);
    for (const hex of frames) {
        // The chunk may include escape sequences for non-printable chars (\xNN, \n, \r).
        // Real protocol bytes are ASCII hex; if we see any escape, it's noise — skip.
        if (!/^[0-9a-fA-F]+$/.test(hex)) {
            console.log(`${timestamp} [${direction}] (skip non-hex chunk, ${hex.length} chars: ${hex.slice(0, 60)}${hex.length>60?'...':''})`);
            continue;
        }
        const r = decryptFrame(hex);
        if (r.error) {
            console.log(`${timestamp} [${direction}] DECRYPT ERROR: ${r.error}  (hex ${hex.length} chars)`);
            continue;
        }
        // Pretty-print JSON
        let pretty = r.plaintext;
        try {
            pretty = JSON.stringify(JSON.parse(r.plaintext), null, 2);
        } catch { /* not JSON */ }
        console.log(`${timestamp} [${direction}]`);
        console.log(pretty);
        console.log();
    }
}

async function processFile(path, tail) {
    if (!tail) {
        // One-shot processing
        const lines = fs.readFileSync(path, 'utf8').split('\n');
        let currentTs = null, currentDir = null, currentPayload = null;
        for (const line of lines) {
            const m = line.match(/^\[(\d{2}:\d{2}:\d{2}\.\d{3})\] \[(CMD|EVT)\] \d+ bytes:$/);
            if (m) {
                // flush previous
                if (currentTs && currentPayload != null) processChunk(currentTs, currentDir, currentPayload);
                currentTs = m[1];
                currentDir = m[2];
                currentPayload = '';
            } else if (currentPayload !== null) {
                // continuation = the payload line right after the header
                currentPayload += line;
                processChunk(currentTs, currentDir, currentPayload);
                currentTs = currentDir = currentPayload = null;
            }
        }
    } else {
        // Tail mode using fs.watch + position tracking
        let lastSize = fs.statSync(path).size;
        console.log(`[tail] starting from offset ${lastSize}`);
        fs.watch(path, async () => {
            try {
                const stat = fs.statSync(path);
                if (stat.size > lastSize) {
                    const fd = fs.openSync(path, 'r');
                    const buf = Buffer.alloc(stat.size - lastSize);
                    fs.readSync(fd, buf, 0, buf.length, lastSize);
                    fs.closeSync(fd);
                    const text = buf.toString('utf8');
                    // Process new lines (simplistic: re-use logic)
                    const lines = text.split('\n');
                    let currentTs = null, currentDir = null;
                    for (let i = 0; i < lines.length; i++) {
                        const m = lines[i].match(/^\[(\d{2}:\d{2}:\d{2}\.\d{3})\] \[(CMD|EVT)\] \d+ bytes:$/);
                        if (m && i + 1 < lines.length) {
                            processChunk(m[1], m[2], lines[i+1]);
                        }
                    }
                    lastSize = stat.size;
                }
            } catch (e) { console.error('tail error:', e.message); }
        });
        // Keep alive
        await new Promise(() => {});
    }
}

const args = process.argv.slice(2);
if (args.length < 1) {
    console.error('Usage: node decrypt-log.js <pipe-mitm.log> [--tail]');
    process.exit(1);
}
const tail = args.includes('--tail');
const path = args.find(a => !a.startsWith('--'));
processFile(path, tail).catch(e => { console.error(e); process.exit(1); });

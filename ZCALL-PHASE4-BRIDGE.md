# zcall — Phase 4: Wine engine + pipe protocol (route B)

Reverse-engineering of the Zalo call control channel by intercepting the Windows
`ZaloCall.exe` engine running under Wine, plus the decision to bridge it (route B).

> Recon tooling lives in `nativelibs/zcall-bridge/` (C sources; `.exe` + captured
> `.log` are gitignored — logs contain personal data and must never be committed).
>
> Prior phases: [ZCALL-RECON.md](ZCALL-RECON.md) (Phase 1),
> [ZCALL-PHASE2-CAPTURE.md](ZCALL-PHASE2-CAPTURE.md),
> [ZCALL-PHASE3-PLAN.md](ZCALL-PHASE3-PLAN.md),
> [ZCALL-WIRE-FORMAT.md](ZCALL-WIRE-FORMAT.md) (media on UDP:4200).

## 0. What changed vs earlier phases

- Phase 2 concluded media was **cleartext Opus**. **That is wrong for the current
  build.** A fresh capture of Zalo Windows 26.1.10 (under Wine) shows audio payload
  is **SRTP-encrypted** (entropy 8.0); only the RTP header, RTCP, and binding packets
  stay cleartext. `srtpMode:1, srtcp:0` in the negotiated config confirms it.
- The call engine entry point is a **separate native executable** (`ZaloCall.exe`),
  spawned by Electron, talking over **two pipes** — *not* an N-API addon
  (`zcall_mac.node` / `vcmac` are legacy, off the real call path).

## 1. Pipe topology (verified)

From Electron `main-dist/main.js` (Windows build) and a live MITM run:

```js
E = "win32" === platform();
g = E ? "\\\\.\\pipe\\PipeZCallSend" : "/tmp/socketzalosend2021";   // Electron -> engine (commands)
y = E ? "\\\\.\\pipe\\PipeZCallRecv" : "/tmp/socketzalorecv2021";   // engine -> Electron (events)

C = net.createServer(sock => sock.on("data", Y));  C.listen(y);     // Electron is SERVER
A = net.createServer(...);                          A.listen(g);     // Electron is SERVER
O = spawn(enginePath, [y, g]);                                       // engine is CLIENT (argv pipes)
```

- **Electron is the SERVER on both pipes; the engine is the CLIENT.**
  (On Linux/macOS the same code uses unix sockets `/tmp/socketzalo{send,recv}2021`.)
- Pipe names are hardcoded, no PID/session suffix → one Zalo instance per host.
- Spawn passes the pipe names as `argv[1]`, `argv[2]`.

A spawn gate guards the engine: `verifyMd5(enginePath, CALL_NATIVE_HASH)` where
`CALL_NATIVE_HASH = "b2eb79ba09ccaedec659d7f7b7bfd59f"` (md5 of the stock
`ZaloCall.exe`). Replacing the engine requires neutralizing this check.

## 2. Wire framing

```
frame = AES-128-CBC( JSON_utf8, key, iv=zeros ).toString("hex") + "$"
key   = base64dec("yjAF9oqMWl6XfXYJn9mA7w==")   // hardcoded in main.js; = ca3005f6…980ef
        (PKCS#7 padding; Node crypto.createDecipheriv("aes-128-cbc", key, iv))
```

Same key both directions. The `$` byte delimits frames. Decryptor:
`nativelibs/zcall-bridge/decrypt-log.js`.

## 3. Message schema

`{ type: string, command: number|string, data: object|string }`

| `type`       | direction        | meaning / commands |
|--------------|------------------|--------------------|
| `update`     | both             | `updateLocal`, `init`, `native-ready`, `callState`, `bubble` |
| `request`    | both             | `makeCall` (→engine); `actionLog`, `uploadLog` (→Electron); `killMe` |
| `response`   | engine→Electron  | `show` (error/extendData) |
| `sendSignal` | engine→Electron  | engine asks Electron to send a signal upstream |
| `recvSignal` | Electron→engine  | Electron delivers a signal received from Zalo's server |
| `control`    | Electron→engine  | VoIP push: `ring_ring`, `answer` (`act_type:"voip"`) |

`sendSignal`/`recvSignal` are the symmetric halves relayed through Zalo's signaling
server (handled by Electron over its own HTTP/socket channel).

### Signal command codes
| code | meaning | key data |
|------|---------|----------|
| 401  | INVITE / call init | `recvSignal/401` = **full config** (servers, sessId, zrtc_config, fec, rtpIP) |
| 416  | accept + codec negotiation | codec `opus/16000/1` payload 112, serverResult, session |
| 408  | connected / established | |
| 409  | endCall (BYE) | |
| 406  | ACK / cleanup | empty data |

### Observed outgoing-voice flow (24 frames)
```
update/updateLocal → update/native-ready → update/init ×2 → request/makeCall
→ update/callState{incall} → response/show{error:0}
→ sendSignal/401 → recvSignal/401 (FULL CONFIG) → sendSignal/416 → recvSignal/416
→ control/ring_ring → control/answer
→ sendSignal/408 (connected) → … → sendSignal/409 (end) → recvSignal/409/406
```

## 4. SRTP key is NOT on the pipe

Across the full capture, the config carries only `srtpMode:1` (a flag) and `srtcp:0`
— **no `srtpKey`/`masterKey`/`crypto` field**. The actual SRTP key is therefore
**derived from `sessId`** (a long base64url token in `recvSignal/401`) or **negotiated
during the UDP binding handshake** (the `01 01` packets, see ZCALL-WIRE-FORMAT.md),
inside the engine.

Consequence: a from-scratch native engine (route A) must reverse this key
derivation/exchange — the hard remaining unknown. Route B (reuse the engine) sidesteps
it entirely.

### Config confirms the UDP capture
`recvSignal/401` config matches the pcap exactly:
`audioSampleRate:16000, audioChannel:1` (→ RTP ts +320/20ms wideband),
`opus/16000/1` payload 112, `srtpMode:1, srtcp:0` (→ SRTP audio + cleartext RTCP),
`fec:{enable:3}` (→ the 4-packet redundancy cycle on the inbound stream),
`servers:[7 relays :4200]` + `p2p` ICE candidates.

## 5. Recon tooling (`nativelibs/zcall-bridge/`)

PE32 programs built with `i686-w64-mingw32-gcc`, run under the user's Wine prefix.

- **`pipe-probe.c`** — connects to the live pipes as a client and dumps frames.
  Proved Electron is the server and decryption works.
- **`pipe-mitm.c`** — replaces `ZaloCall.exe`: connects to Electron's pipes (outer,
  client side), creates inner server pipes, spawns the renamed real engine
  (`ZaloCall-real.exe`) with the inner names, forwards bytes both ways and logs them.
  Needs: `argv[0]` basename = `"ZaloCall.exe"`, `cwd` = engine dir (Qt/OpenSSL DLLs),
  and the `verifyMd5` gate neutralized in the Wine Zalo's `app.asar`.
- **`decrypt-log.js`** — offline/`--tail` decryptor for the captured log.
- **`Makefile`** — `make`, `make run` (probe), `make install-mitm` / `uninstall-mitm`.

See `nativelibs/zcall-bridge/README.md` for the full procedure.

## 6. Route B plan (next)

Engine speaks Windows named pipes; Linux Electron speaks unix sockets. Both agree
Electron = server, engine = client. The only gap is transport. Plan:

```
Electron (zalo-for-linux) — unix socket servers /tmp/socketzalo{send,recv}2021
   │ W() linux branch (to patch in scripts/patches/patch-zcall.js) spawns:
   ▼  wine zcall-shim.exe /tmp/socketzalorecv2021 /tmp/socketzalosend2021
zcall-shim.exe (PE32, under Wine — reuse pipe-mitm)
   ├─ connects to the two Linux unix sockets (Wine 11 AF_UNIX)  ⟷ Electron
   ├─ creates named-pipe servers for the engine
   └─ spawns ZaloCall.exe [pipeRecv, pipeSend]
         ZaloCall.exe — does all SRTP / relay / Opus / RTP + mic/speaker (Wine→PipeWire)
```

The shim only forwards opaque bytes (both ends share the AES key), so the Electron
side needs no protocol changes — just the `linux` spawn branch.

**Open questions (go/no-go for route B):**
1. Can a Wine PE32 program connect to a host Linux unix-domain socket via AF_UNIX?
   (If not, fall back to TCP + a small Linux unix↔TCP shim.)
2. Does the engine need its own Zalo Windows login, or does it run purely off the
   `sessId`/config forwarded from the Linux Electron's signaling?
3. Audio routing when the engine runs without the Zalo.exe UI present.

**Packaging:** route B needs Wine + the Windows engine **only for calls** — everything
else runs natively. Likely model (matching the project's "bring your own official Zalo"
ethos): require the user to install Wine + Zalo Windows; the app detects and bridges to
it. Bundling the proprietary engine into the AppImage is the alternative (bigger,
licensing-murkier).

## 7. Parallel track — route A native (no Wine), via Mac mini

The macOS `ZaloCall` binary cannot run on Linux (Mach-O vs ELF; macOS frameworks;
Darling too immature). A Mac mini can't host the engine for a real call either (media
+ mic/speaker would be on the wrong machine). But it is the **cheapest place to RE the
SRTP key derivation** — MITM on the macOS unix sockets needs no hash patch, no shim, no
Wine. Cracking the key derivation would unblock a native Linux engine and drop the Wine
dependency entirely. Tracked as the long-term goal alongside route B.

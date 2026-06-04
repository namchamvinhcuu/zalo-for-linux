# zcall — Stage 0 deliverable: engine signaling inputs (capture template)

> ⚠️ **OUTDATED APPROACH (2026-06-03).** This template assumes the v26 app drives
> the engine through the `vcmac.js` N-API surface. RE proved it does NOT —
> `nativelibs.zcall()`/`vcmac`/`binding.js` are never called when making a call;
> the call goes through the `$zcall` IPC bridge and bails before any native code.
> The vcmac path is LEGACY. See `.obsidian-vault/Architecture/ZCall-CallFlow-And-UI-Gates.md`.
> Re-establish the real v26 engine entry before using this template.


Status: **scaffold instrumented, awaiting one real capture run.** This file is the
target deliverable of ZCALL-PHASE3-PLAN.md §Stage 0: the exact shape/values of
every input the JS signaling layer feeds the native engine during a real
outgoing call on Linux, plus the engine→JS event vocabulary.

The native stub never connects, so the call will not complete — Stage 0 only
needs the **inputs** captured before/at `makeCall()`. Everything downstream
(Stage 1 relay registration, GATE A) keys off the `servers` list + token here.

---

## 1. How the capture works

`scripts/patches/patch-zcall.js` (run as part of `npm run prepare-app`) wires a
tracing wrapper into the app:

- `nativelibs/zcall/trace.js` → copied to `app/native/nativelibs/zcall/zcall-trace.js`.
- The Linux branch in `app/native/nativelibs/zcall/binding.js` loads the traced
  scaffold **only when `ZCALL_LINUX` is set** — a normal build is unaffected
  (`getLib()` still returns `{error: 'not support'}`).
- The wrapper Proxies the native instance and logs every N-API call
  (`setConfig`, `setListServers`, `setConfigServer`, `makeCall`, …) with its
  arguments to a JSONL file, JSON-parsing string args so the dump is structured.

`vcmac.js` calls `check()` → `instance.test(123) == 123`; the stub returns 123,
so Zalo treats the engine as available and runs the full HTTPS signaling
(`authenication()` → login/genuid/config) then `setConfigData()` →
`setConfig`/`setListServers`/`setConfigServer` → `makeCall()`. All of those are
traced.

## 2. Capture procedure (do this on Linux)

```bash
# 1. (Re)generate app/ with the wiring patch applied
npm run prepare-app

# 2. Launch with the engine gate + a known log path, then place a REAL
#    outgoing 1:1 AUDIO call from the Zalo UI. Let it "ring/connect" ~10s,
#    then hang up. (It won't actually connect — expected.)
ZCALL_LINUX=1 ZCALL_TRACE_FILE=/tmp/zcall-trace.jsonl npm start

# 3. Inspect the captured inputs
node -e "require('fs').readFileSync('/tmp/zcall-trace.jsonl','utf8').split('\n').filter(Boolean).forEach(l=>{if(l[0]==='#')return console.log(l);console.log(JSON.stringify(JSON.parse(l),null,1))})"
```

Hand the JSONL path to Claude → it fills in §3–§5 below from the real values.

> If the call UI refuses to start on Linux even with the stub available, note
> that here — it means signaling has an additional platform gate to patch.

## 3. Engine inputs — TO FILL FROM CAPTURE

For each method, paste the real (redacted) args. Mark anything that looks
per-call / time-bound (likely the **token** — biggest Stage-1 risk).

### `setConfig(configJson, userId, partnerId, protocol, callId, genSession, config, enableChangeZRTP, isVideoCall, logPath, osInfo, clientVersion)`
- `configJson` (config.settings): _…_
- `userId` / `partnerId`: _…_
- `protocol`: _…_
- `callId`: _…_  ← per-call?
- `genSession` (sessId): _…_  ← per-call?
- `config` (zrtc_config or genuid `config` blob): _…_  ← **token material?**
- `enableChangeZRTP` / `isVideoCall` / `clientVersion`: _…_

### `setListServers(serversJson)`  ← relay candidates, the Stage-1 target
- Number of servers: _…_
- Per server fields (`rtpaddr`, `rtcpaddr`, `token`/`candId`/…): _…_
- Which IP:port matched the relay that carried media in the Phase-2 pcap? _…_

### `setConfigServer(rtcpIP, rtpIP)`  ← used only when no `servers` list
- _… (likely absent on the caller path)_

### `setMediaConfig(audioConfig, extendData)` (callee path only)
- _…_

### Call-control sequence observed
- Order + timing of `setCallback` / `makeCall` / `incomingCall` / `stop`: _…_

## 4. Event vocabulary (engine → JS) — TO FILL
The stub's `getEventMessage()` returns `""`, so events can't be captured on
Linux. Capture them by running the same tracing shim on **macOS/Windows** where
calls work (wrap `getEventMessage` return values too), OR infer from the JS that
consumes them. List each event string + when it fires (ringing, connected,
ended, …): _…_

## 5. Open questions resolved by this capture
- [ ] Token: per-call, time-bound, or signed by a native secret? (→ GATE A)
- [ ] Is the relay chosen from `servers` the same `:4200` host seen in Phase 2?
- [ ] Any input we can't reproduce without the native engine?

## 6. Links
- Plan: `ZCALL-PHASE3-PLAN.md` · Wire format: `ZCALL-WIRE-FORMAT.md` · Recon: `ZCALL-RECON.md`
- Vault: [[Feature-Voice-Video-Call]], [[ZCall-Wire-Format]], [[Skill-Protocol-Recon]]

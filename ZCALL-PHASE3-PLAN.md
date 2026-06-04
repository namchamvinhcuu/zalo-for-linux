# zcall — Phase 3 plan: audio-only Linux engine

Status: PLAN (no engine code yet). Scope: **audio call only** (1:1), send + receive.
Video, group calls, screen-share = Phase 4+. Builds on `ZCALL-RECON.md`,
`ZCALL-PHASE2-CAPTURE.md`, `ZCALL-WIRE-FORMAT.md`.

> Legal/scope: interop reimplementation for calls on your own account. Clean-room
> C++ in `nativelibs/zcall/` — no code copied from `zcall_mac.node`.

---

## 1. Key architectural decision — keep JS signaling, replace only the media engine

The shipped JS layer (`app/native/nativelibs/zcall/{vcmac,index}.js`) already does
**all signaling over HTTPS** and hands the native addon everything it needs via the
existing N-API surface (confirmed in `vcmac.js`):

```
setConfig(configJson, userId, partnerId, protocol, callId, genSession,
          config, enableChangeZRTP, isVideoCall, logPath, osInfo, clientVersion)
setMediaConfig(audioConfig, extendData)
setListServers(JSON.stringify(servers))     // ← relay candidate list from signaling
setConfigServer(rtcpIP, rtpIP)
makeCall() / incomingCall()
setCallback(cb) ; getEventMessage()          // ← engine → JS call-state events
```

**So we do NOT need to reverse the HTTPS signaling at all.** We reimplement only
the native engine behind this exact interface: it receives the server list + call
config as method arguments, then runs the UDP media protocol (binding → InitCall →
RTP audio → RTCP) decoded in Phase 2. This massively narrows scope and risk.

### Data flow (audio out + in)
```
mic → PulseAudio capture → Opus encode → build ZRTPPacket(type 03) → UDP → relay:4200
relay:4200 → UDP → parse ZRTPPacket(type 04) → jitter buffer → Opus decode → PulseAudio play
control: binding (01 01) register/keepalive ; InitCall→token ; RTCP (05) SR/RR
events: engine → getEventMessage()/callback → JS (ringing, connected, ended…)
```

---

## 2. Build & dependency strategy

- Extend the existing scaffold `nativelibs/zcall/` (replace stubs incrementally).
  Build via `node nativelibs/builder.js nativelibs/zcall` (Electron 22 N-API).
- **libopus** — vendor + static-link (AppImage portability; libopus 1.2.1 matches
  the original). Add as a git submodule or pinned source under `nativelibs/zcall/third_party/`.
- **Audio I/O** — PulseAudio `libpulse-simple` via **dlopen** (no hard link, so the
  AppImage still loads on boxes without it; degrade gracefully). ALSA fallback later.
- **No libwebrtc**, no libsrtp, no openssl — media is cleartext; we hand-roll the
  minimal RTP seq/timestamp + jitter buffer + send pacing.
- `.node` stays gitignored; built at pipeline time (per project rule).

---

## 3. Proposed source layout (`nativelibs/zcall/src/`)

```
main.cc            N-API surface (ZCall ObjectWrap) — maps JS methods to engine
engine.{h,cc}      CallController: state machine, owns transport+audio, event queue
transport.{h,cc}   UdpSocket + relay binding/registration + send/recv loops
zrtppacket.{h,cc}  build/parse ZRTPPacket (types 01 01 / 03 / 04 / 05) per wire-format
audio.{h,cc}       PulseAudio capture+playback (dlopen) + ring buffers
opus_codec.{h,cc}  libopus encode/decode wrappers
jitterbuffer.{h,cc} reorder + de-jitter incoming RTP before decode
rtcp.{h,cc}        minimal SR/RR build/parse for keepalive + stats
events.{h,cc}      thread-safe queue feeding getEventMessage()
```

---

## 4. Staged milestones (lowest-risk / highest-uncertainty first)

Each stage has a concrete VERIFY (no unit-test framework — observe real behavior)
and, where relevant, a GATE that must pass before investing in the next stage.

### Stage 0 — Capture the real engine inputs & event protocol  ⟵ do first, no C++
- Instrument the loadable scaffold: log every N-API call + JSON-dump all args
  (`setConfig`, `setListServers`, `setConfigServer`, `makeCall`, …). Wire the
  scaffold into the app in a dev-only branch and start a real outgoing call on
  **Linux** — JS does signaling, so we capture the real `servers` list, `callId`,
  `genSession`, `config`, token material, even though the stub never connects.
- If possible, also capture the **event strings** the real engine emits
  (`getEventMessage`) by running the logging shim on macOS/Windows where calls work.
- **Deliverable:** `ZCALL-SIGNALING-INPUTS.md` — exact shape/values of every
  engine input + the event vocabulary.
- **Verify:** we can print a full real `setConfig`/`setListServers` payload.

### Stage 1 — Relay registration replay  ⟵ GATE A (make-or-break)
- Standalone C++ harness: using inputs from Stage 0, open UDP, send the binding
  packets (`initP2PRequestBinding` → type `01 01`, seq, session id, **token**,
  candId) to each server in the list; expect binding responses (the `01 01` recv
  with response/ack we saw in the pcap).
- May need a freshly-triggered call (token likely per-call / time-bound) — drive
  via the JS signaling each run.
- **GATE A:** does a Zalo relay accept our registration (responds to binding)?
  - PASS → the token/binding is replicable → proceed.
  - FAIL → token is bound to something we can't reproduce → STOP, reassess.
- **Verify:** capture our harness traffic; relay sends back binding response/ack.

### Stage 2 — ZRTPPacket build/parse (offline, byte-exact)
- Implement `zrtppacket.cc` for types `01 01`, `03`, `04`, `05` per
  `ZCALL-WIRE-FORMAT.md` (audio header = 25B, Opus at off 25; seq/ts(+960)/SSRC).
- **Verify:** round-trip the captured pcap — parse each real packet, rebuild,
  assert identical bytes; parse audio → extract a valid Opus payload at off 25.

### Stage 3 — Opus + PulseAudio loopback (no network)
- `opus_codec.cc` + `audio.cc`: mic capture → Opus encode → Opus decode → speaker.
- **Verify:** local loopback — speak, hear yourself with ~one-frame latency; no
  glitches; bitrate/ptime match captured profile (20 ms, ~8-16 kbps NB/WB).

### Stage 4 — End-to-end media on a real call  ⟵ GATE B
- Combine Stages 1-3: after registration, send our Opus as type `03`, receive type
  `04`, jitter-buffer + decode + play. Add minimal RTCP (`05`) keepalive + pacing.
- **GATE B:** two-way audio on a real 1:1 call (Linux ↔ phone/desktop).
- **Verify:** hold a real call; both parties hear each other; pcap shows our
  type-03 stream + incoming type-04 decoded.

### Stage 5 — N-API surface + state machine + events
- Implement all `CallController` methods the JS calls; drive call states; feed
  `getEventMessage()`/callback with the Stage-0 event vocabulary so JS UI updates
  (ringing → connected → ended). Implement `mute`, `holdAudio`, `stop`.
- **Verify:** `npm start`, place/answer a call from the real Zalo UI; UI reflects
  state; audio works; hang-up clean.

### Stage 6 — Wire into the app (patch + pipeline)
- `scripts/patches/patch-zcall.js`: add a `linux` branch to
  `app/native/nativelibs/zcall/binding.js` (`require('./zcall-native.node')`);
  pipeline copies the built `.node` into `app/native/nativelibs/zcall/`.
- Update `nativelibs/zcall/{index.js,README.md}`; flip the scaffold to real.
- **Verify:** fresh AppImage build → install → real call works end-to-end.

### Stage 7 — Robustness & polish
- Jitter-buffer tuning, packet-loss/FEC (`onSendAudioFec`), AGC, device selection
  (`getListDevices`/`changeAudioDevice`), bitrate adaptation, reconnect, stats
  (`getJsonStats406`/`getCallInfo`). Edge cases: network change, hold, mute.

---

## 5. Decision gates (stop/continue)
- **Gate A (Stage 1):** relay accepts our binding/token. If not → core blocker.
- **Gate B (Stage 4):** real two-way audio. If only one-way → debug RTCP/SSRC/PT.

## 6. Top risks
- **Token semantics** — per-call, time-bound, or signed by a native secret? Stage 0/1
  settles this; it's the biggest unknown.
- **Undecoded header consts** (`90`, `be de 00`, `01 51`, `13`) — copy literally
  first; disasm `initZRTPPacketAudio`/`_parsePacketInternal` further if the relay
  rejects.
- **RTCP requirement** — relay may drop a stream without periodic RTCP; add early.
- **Audio realtime** on a generic Linux box (PulseAudio latency/underruns).
- **PT / Opus mode** — confirm the dynamic PT (≈113) and Opus config the peer expects.

## 7. Explicitly out of scope (Phase 4+)
- Video (VP8/VP9/H264 + V4L2 capture), screen-share, group calls, e2e — and there
  is **no media encryption** to implement (Phase-2 confirmed cleartext).

## 8. First concrete action when coding starts
Stage 0: add arg-logging to the scaffold + dev-wire it, then capture one real
outgoing-call attempt's engine inputs on Linux. Everything downstream keys off that.

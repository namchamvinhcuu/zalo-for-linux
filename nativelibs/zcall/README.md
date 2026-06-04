# zcall (Linux) — legacy / reference

Early Linux reimplementation attempt for Zalo's `zcall` voice/video native addon.

> **Legacy — not built or wired in.** This N-API scaffold was the wrong layer:
> Zalo v26 drives the call engine as a *spawned native executable*, not through
> an N-API addon. Voice calls now work via the **route-B Wine bridge**
> (`../zcall-bridge`) — see [ARCHITECTURE.md](../../ARCHITECTURE.md) → "Voice
> calls". This folder is kept only for the API-surface / signaling notes below.

## Why this exists

The shipped `zcall_mac.node` is a macOS Mach-O binary (a fork of Google WebRTC
called `zrtc`) and can't load on Linux. This folder documents the reconnaissance
that informed the working solution: API surface, signaling (exposed at the JS
layer), and media (server-relayed RTP/RTCP + ZRTP).

## Build (standalone, for development)

```bash
node nativelibs/builder.js nativelibs/zcall
# -> nativelibs/zcall/build/Release/zcall-native.node
```

The builder targets the Electron version from the root `package.json`.

## Roadmap

1. **Phase 2 — protocol capture (decision gate):** Wireshark a real call to the
   relay servers; confirm RTP/RTCP framing + ZRTP handshake are reversible.
2. **Phase 3 — audio-only:** libwebrtc base + ALSA/PulseAudio + Opus + RTP/RTCP
   to Zalo relay servers + ZRTP. Implement `setConfig`/`setState`/`makeCall`/
   `incomingCall`/`getEventMessage`/`mute`/`holdAudio`.
3. **Phase 4 — video:** VP8/VP9/H264 + V4L2 capture + `getVideoFrame*`.
4. **Phase 5 — devices/stats/screen share/FEC/AGC.**

Only after Phase 3 works should `binding.js` be patched (via a
`scripts/patches/patch-zcall.js`) to load this on Linux.

## API surface

See `src/main.cc` (mirrors `app/native/nativelibs/zcall/vcmac.js`).

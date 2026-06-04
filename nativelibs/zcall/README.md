# zcall (Linux) — WIP

Linux reimplementation of Zalo's `zcall` voice/video native addon.

**Status: scaffold.** Builds + loads + passes the JS availability check
(`test(123) === 123`); it does NOT place real calls yet. It is intentionally
**not wired into the app's `binding.js`** — the app still cleanly reports "calls
not supported" until the engine is functional, so users don't hit a fake button.

## Why this exists

The shipped `zcall_mac.node` is a macOS Mach-O binary (a fork of Google WebRTC
called `zrtc`) and can't load on Linux. See `ZCALL-RECON.md` (repo root) for the
full reconnaissance: API surface, signaling (exposed at the JS layer), media
(server-relayed RTP/RTCP + ZRTP), and the phased roadmap.

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

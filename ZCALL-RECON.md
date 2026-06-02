# zcall — Recon / Scoping (Phase 1)

Reconnaissance of Zalo's native calling module (`zcall`) to scope a possible
Linux implementation. **No code written** — this is a feasibility map.

> Source inspected: `app/native/nativelibs/zcall/` (regenerated each build, gitignored)
> and the macOS binary `zcall_mac.node`.

## 1. Architecture

```
app (main-dist, minified)  ──uses──>  ZVCMac (index.js)
                                          │
                                          ├─ VCMac (vcmac.js)  ──> binding.js ──> zcall_mac.node  (NATIVE engine)
                                          ├─ ZScreenObject / ZScreenCanvasObject (screen-object*.js)  ── render frames to <canvas>
```

- `binding.js` picks the native lib by platform: win32 → `zcall_x64/ia32.node`,
  darwin → `zcall_mac.node`, **else (Linux) → `{error:'not support'}`**.
  Zalo ships the engine for Windows + macOS, never Linux.
- The native binary is the whole media engine. The JS is a thin driver.

## 2. Native API surface (what a Linux `.node` must export)

`ZMacCall.MainApp()` returns an instance with ~30 methods (from vcmac.js):

| Group | Methods |
|-------|---------|
| Lifecycle | `MainApp()`, `test(123)→123`, `stop()` |
| Call setup | `setConfig(configJson,userId,partnerId,protocol,callId,genSession,config,enableChangeZRTP,isVideoCall,logPath,osInfo,clientVersion)` (12 args), `setMediaConfig(audioConfig,extendData)`, `setListServers(json)`, `setConfigServer(rtcpIP,rtpIP)`, `setState(session,peerId,config)`, `updateCallerInfo(audioConfig,extendData)` |
| Call control | `makeCall()`, `incomingCall()`, `mute(bool)`, `holdAudio(hold,local)`, `stopCapture(bool)` |
| Events | `setCallback(fn)` (native→JS), `getEventMessage()` (polled, returns JSON string) |
| Video | `getVideoFrame(buf)` / `getVideoFrameLocal(buf)` (decode into buffer, return {width,height}), `startDesktopCapture()`/`stopDesktopCapture()`, `changeMinMaxMobileBitrate()` |
| Devices | `getListDevices()`, `changeAudioDevice(in,out)`, `changeVideoDevice(id)`, `setAudioVolume(in,out)`, `setAgc(bool)` |
| Stats | `getCallInfo()`, `getJsonStats406(...)`, `getActiveAudioCodecs()`, `getExtendData()` |

## 3. Signaling — the GOOD news (not hidden in the binary)

Call setup is **plain data/HTTP at the JS layer**, not a secret binary protocol:

- Legacy auth path in `vcmac.js`:
  - `https://vlogin.zaloapp.com/login` → session
  - `http://api.conf.talk.zing.vn/genuid` → peer id
  - `http://api.conf.talk.zing.vn/zls?action=call_config` → config
- Real path: the **app passes a full `config` object** into `makeCall(config)` /
  `incomingCall(config)`. Its exact schema is exposed by the dev test artifact
  `testConnect()` in `index.js`:
  ```json
  { "fromId":…, "toId":…, "protocol":3, "callId":…, "sessId":"<token>",
    "rtpIP":"120.138.74.196:8019", "rtcpIP":"120.138.74.196:4003",
    "servers":[{"rtpaddr":"…:8020","rtcpaddr":"…:4004"}, …],   // Zalo media RELAY servers
    "changeZRTP":{"enable":1,"threshold":5},
    "fec":{"enable":2,"tableLookup":[…]},
    "settings":{ voip/bitrate/timeout knobs } }
  ```
  → `sessId`, `servers`, `callId` come from Zalo's call-initiation over the
  normal messaging channel. **This is the input contract** for the engine.

## 4. Media / transport (from binary strings)

- Engine = **`zrtc`** = Zalo's **fork of Google WebRTC** (namespaces `zrtc::`,
  `webrtc::`; classes `CallController`, `VideoRtpRtcp`, `AudioDeviceModuleImpl`).
- Codecs: **Opus** (audio, opus-1.2.1), **VP8/VP9/H264** (video). AEC, jitter
  buffer, AudioConferenceMixer, FEC.
- Transport: primarily **server-relayed RTP/RTCP** to explicit Zalo media servers
  (rtpaddr/rtcpaddr in config) — *not* pure P2P NAT-traversal. ICE/STUN/TURN/P2P
  symbols exist (secondary path), but the relay model is simpler to target.
- Encryption: **ZRTP** (RFC 6189; 177 string hits, `setOldZrtpVersion`,
  `changeZRTP`) — a documented key-exchange standard, with Zalo tweaks.
- Audio I/O on mac = `AudioDeviceMac` (CoreAudio). Linux needs ALSA/PulseAudio.
- Build provenance: `/Users/cpu11601/hanhnv/build_libs/opus-1.2.1_2/…` → built by
  a Zalo dev; `zrtc/webrtc/base/…` source layout. Binary ≈ **7.2 MB**.

## 5. Scope of a Linux implementation

| Component | Reusable open-source? | Effort |
|-----------|----------------------|--------|
| Media engine (RTP stack, codecs, AEC, jitter) | ✅ **libwebrtc builds on Linux** | Medium (build/integrate) |
| Audio I/O (ALSA/PulseAudio), video capture (V4L2), screen (X11/PipeWire) | ✅ in libwebrtc | Medium |
| N-API shim exporting the ~30 methods | n/a (write it) | Medium |
| **Zalo RTP/RTCP framing to relay servers** (`protocol:3`, packet format) | ❌ must reverse | **High** |
| **ZRTP variant** (handshake against Zalo servers, `changeZRTP`) | partial (open ZRTP libs exist) | High |
| Event JSON format (`getEventMessage`), FEC table semantics, 12-arg `setConfig` mapping | ❌ must reverse | High |

## 6. Feasibility verdict (revised)

Better than first feared, still large:
- ✅ Signaling/auth is **exposed** (JS HTTP + config object) — no opaque secret handshake.
- ✅ Media transport is **server-relayed RTP/RTCP + ZRTP + standard codecs** — analyzable by capturing a real call.
- ✅ The heavy engine (`zrtc`) is a **WebRTC fork → open-source base** for Linux.
- ❌ Must **reverse the wire format** (RTP framing to relay servers + ZRTP specifics + event/FEC) without Zalo's `zrtc` source.
- ❌ Real-time media engineering + matching a live, server-side protocol that can change.

→ **A serious multi-month project** for someone comfortable with WebRTC/native +
protocol RE — but **not the “impossible” it first looked**. The make-or-break
unknown is how reversible the RTP-to-relay framing + ZRTP handshake are.

## 7. Recommended Phase 2 (decision gate, before any C++)

**Capture and analyze one real call's wire protocol** (your own account = authorized):
1. Make a real Zalo call (mobile or Win/Mac client) and capture traffic
   (Wireshark) to the relay server IPs from the config.
2. Confirm: is it standard RTP/RTCP framing? Is the ZRTP handshake standard
   (RFC 6189) or customized? How is FEC applied?
3. Capture the `config` object the desktop client receives at call start (log it
   from the JS layer) + the `getEventMessage` JSON sequence during a call.

If the framing + ZRTP look standard/reversible → proceed to a libwebrtc-based
prototype (audio-only first). If heavily customized/obfuscated → reconsider.

## 8. Pragmatic alternative

Until/unless the above lands: keep using the phone or Zalo Web for calls.
Implementing zcall is independent of everything else — text, files, ZaDark,
tray all work without it.

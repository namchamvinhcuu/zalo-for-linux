# zcall — Phase 2: Protocol Capture Guide

**Goal:** capture ONE real Zalo call's wire traffic + call config, to decide
whether the media protocol is reversible — i.e. whether to proceed to a
libwebrtc-based engine (Phase 3) or stop.

> Legal: only capture **your own** calls / your own account. This is interop RE
> on traffic you are a party to.

---

## Round 1 — flow-level capture (DONE, 2026-06-02, PCAPdroid CSV)

A PCAPdroid **connections CSV** (flow summary, no payloads) of one Android audio
call already nailed the **topology**:

- **Media = server-relayed RTP over UDP, relay port `4200`.** Client opens one
  local UDP port and probes ~7 relay candidates on `:4200` (ICE-style), then the
  winner carries the call. Round-1 winner: `202.83.3.21:4200`
  (~232 KB up / ~226 KB down, 1672/1360 pkts over 32 s).
- **Cadence ≈ 52 pkt/s, ~58 kbps each way, ~111 B payload/pkt → Opus @ 20 ms,
  audio-only.** Symmetric RTP (send+recv on one port), likely rtcp-mux.
- **ICE then relay fallback:** direct attempts to the peer's host/srflx
  candidates (e.g. `10.52.9.156`, public IPs) got 0 bytes back (NAT) → fell back
  to the `:4200` relay. Very WebRTC-like (matches the `zrtc` = WebRTC-fork find).
- **Signaling domains (HTTPS/TLS, payload opaque):** `centralized.zaloapp.com`
  (call control), `zvoip-qos.zaloapp.com` (QoS), `log.api.zaloapp.com` (logs).
  Plus periodic `8.8.8.8:33434-33436` 0-byte UDP = traceroute RTT probes.

**Still open (needs payload bytes):** is `:4200` standard **RTP** header? is there
a **ZRTP** handshake? **SRTP** or cleartext? → that's Round 2 (full PCAP below).

---

## Round 2 — full PCAP (DONE, 2026-06-02, PCAPdroid PCAP file) ⚠️ DECISION

Full-payload PCAP of one audio call (relay `42.119.138.120:4200`, 3578 pkts).
**Verdict: the `:4200` transport is a fully PROPRIETARY Zalo protocol — NOT any
standard.** Confirmed absent across the whole capture: STUN magic `2112a442`
(0), `ZRTP` string (0), DTLS `16fefd` (0), standard RTP `0x80..` headers (none).
**→ the original recon's "ZRTP" hypothesis is DISPROVEN.**

Two channels share the one UDP port:

1. **Control / relay-registration** — packets prefixed `01 01`:
   `01 01 | seq(LE, increments) | sessionID 6597 3e00 | 3c83 2f01 | … |
   <base64url token> | ASCII status digits`. The base64url token
   (`GYTJvCFH33nB44FP-TyBEqKLC--RtHbjUIyLn…`, repeated) is the relay
   credential/ticket — almost certainly minted by the signaling channel
   (`centralized.zaloapp.com`). Zero-padded variants = keepalive / RTT probes.
   The multi-candidate `:4200` "probing" from Round 1 is THIS custom register,
   not STUN.

2. **Media** — packets prefixed with a type byte `03`/`05`:
   `03 | 66cdaf12 (constant stream id) | small header | <high-entropy payload>`.
   Payload is high-entropy → **either encrypted OR compressed Opus** (can't tell
   from framing alone). Rate/size match Round 1's Opus-@20ms audio profile.

### Feasibility re-assessment (this changes the plan)
This is the **custom/obfuscated** branch, not the easy one. There is NO
libwebrtc+ZRTP drop-in path: the relay speaks Zalo's own framing. A Linux engine
would have to reverse (a) the register handshake + how the token is derived from
signaling, (b) the media header format, (c) **the media crypto + key source IF
encrypted** — and the key is not on the wire (no ZRTP), so it comes from
signaling/native engine = the hard blocker.

### Pivotal open question
**Is the media payload encrypted, or cleartext Opus under a custom header?**
- cleartext Opus → feasible (reverse header, decode Opus).
- encrypted → large effort, gated on reversing the crypto/key derivation.

### Next step (no more captures needed)
The wire is opaque, so settle the question OFF the wire:
- **Reverse the native binary** (`zcall_x64.node` Win / `zcall_mac.node`) for the
  framing + crypto, or
- **Instrument the desktop JS** to dump the `config`/keys handed to the addon.
Both are doable without the user / without another call capture.

---

## Round 3 — binary RE of `zcall_mac.node` (DONE, 2026-06-02) ✅ MEDIA IS CLEARTEXT

Reversed `app/native/nativelibs/zcall/zcall_mac.node` (7.3 MB Mach-O x86_64,
strings + demangled C++ symbols; no Mach-O disassembler yet). The engine is a
**WebRTC fork in namespace `zrtc`** (libopus 1.2.1, `webrtc::` AGC/RTP/video,
CELT/SILK). **The pivotal question is settled: media is NOT encrypted.**

Evidence the media path has **no crypto**:
- No `libsrtp`/`openssl`/`boringssl`/`libcrypto` markers; no `webrtc::Srtp*`/
  `Dtls*`/`Crypto*` classes — the fork **stripped DTLS-SRTP entirely**.
- `zrtc::ZRTPPacket` has `buildPacket`/`parsePacket`/`init…` but **no
  encrypt/decrypt** method. `AudioRtpRtcp` path = plain RTP/RTCP + FEC.
- `"SRTP:%ld"` strings are just **stats counters**, not ciphering.
- → high-entropy payload = **compressed Opus**, not SRTP.

**"ZRTP" is Zalo's brand for its packet class, NOT the ZRTP key-agreement
protocol.** `zrtc::ZRTPPacket` packet types (map 1:1 to the wire capture):
- `initP2PRequestBinding/ResponseBinding/AckBinding/EchoPkt/SignalPkt` →
  the `01 01` + seq + **candId** packets = custom NAT-traversal (replaces STUN).
- `initZRTPPacketRequestInitCall/Ping/Forward/EndCall/ChangeAddress` → control;
  token obtained from server ("Init ZRTP successful token = %d from server").
- `initZRTPPacketAudio` / `initZRTPPacketVideo` → media (type byte `03`/`05`).
- Relay chosen via `zrtc::ZRTPServerInfo` + "caller/callee choose server".

Key classes: `zrtc::{Peer, CallController, ZRTPPacket, ZRTPServerInfo,
UdpIOThread, UdpNetworkIOThread, AudioRtpRtcp, VideoRtpRtcp, AudioDevice,
BandwidthProfile, QueuingManager}`.

### Verdict: FEASIBLE (large but tractable — no crypto wall)
Phase-3 path (all deterministic RE, no key-cracking):
1. Reverse `ZRTPPacket` byte layout (`buildPacket`/`_buildPacketInternal` /
   `parsePacket` cross-referenced with captured packets — already partly mapped:
   prefix, LE seq, candId, session IDs, base64url token, media type `03`/`05`).
2. Implement P2P binding + relay registration + token (token from signaling).
3. Opus encode/decode (libopus, open source) + RTP/RTCP + FEC.
4. Wire signaling (makeCall → relay list + token; exposed at the JS layer).

Hardest remaining = exact `ZRTPPacket` layout. A Mach-O disassembler
(rizin/radare2) on `buildPacket`/`parsePacket` would pin field offsets; the
pcap + symbol names already give most of it.

---

## 0. What we need to answer (decision criteria)

| Question | If "yes / standard" | If "no / custom" |
|----------|--------------------|------------------|
| Is media plain **RTP/RTCP** (Wireshark dissects headers)? | feasible | hard |
| Is the key exchange standard **ZRTP** (Wireshark `zrtp` dissector recognizes Hello/Commit/DHPart/Confirm)? | reuse a ZRTP lib | hard |
| Are payloads **SRTP** (encrypted after ZRTP) or cleartext RTP? | known path | analyze more |
| What **codecs / payload types** (Opus dyn PT, VP8/VP9/H264)? | map to libwebrtc | — |
| Is media **relayed via Zalo servers** (single UDP peer) or P2P? | simpler (relay) | ICE/TURN |

GREEN-light to Phase 3 = RTP + recognizable ZRTP. RED = custom/obfuscated framing.

---

## 1. Prerequisites

- A device where Zalo calling **works**: your **phone**, or a **Windows/macOS**
  Zalo desktop. (The Linux build can't call — that's the whole point.)
- **Wireshark** installed (`sudo apt install wireshark`; allow non-root capture).
- A second Zalo account (or a friend) to call.

---

## 2. Pick a capture method

### Method A — Win/Mac Zalo desktop (easiest, richest)
Run Wireshark **on the same machine** as the desktop Zalo, capture the active
network interface during a call. Bonus: you can also instrument the JS layer
(§5) on that machine.

### Method B — Phone call, capture via your Linux box as gateway
You're on Linux, so turn it into the phone's internet gateway and capture there:

1. Share Linux internet over Wi‑Fi/USB (GNOME Settings → Wi‑Fi → "Turn On
   Wi‑Fi Hotspot", or `nmcli device wifi hotspot`).
2. Connect the **phone** to that hotspot.
3. Capture the hotspot interface in Wireshark (the `ap*`/`wlan*` shared iface).
4. Make the call from the phone.

(Method B avoids installing anything on the phone. ARP-spoof / managed-switch
port-mirror also work if you prefer.)

### Method C — Android **PCAPdroid full PCAP** (no root, what we're using) ⭐

Round 1 used PCAPdroid's *connections CSV* (no payloads). Round 2 needs the same
tool in **full-packet PCAP** mode:

1. PCAPdroid → **Settings → Dump mode → `PCAP file`** (not "None"/CSV).
2. **App filter → Zalo** (`com.zing.zalo`) — keeps the capture clean.
3. Leave TLS decryption **off** (we don't need signaling payloads — see §5).
4. **Start capture FIRST**, then place a short **audio** call: ring → connect →
   talk ~20-30 s → hang up. (Starting first captures the handshake on the very
   first `:4200` packets — that's where ZRTP/STUN would be.)
5. **Stop** capture → share/export the **`.pcap`** (PCAPdroid: ⋮ → *Share PCAP*,
   or it's saved on device storage). Drop it in the same KDE-Connect Downloads
   folder and tell me the filename.

That single `.pcap` is all I need from you — I'll do the Wireshark analysis (§4)
myself. The relay IP differs per call; I'll just pick the high-volume `:4200`
UDP flow.

---

## 3. Capture the call

1. Start Wireshark capture on the right interface.
2. Make a **voice call** first (audio-only is simpler than video for round 1).
   Let it ring → connect → talk ~15s → hang up.
3. Stop capture, **Save As** `zcall-voice.pcapng`.
4. Repeat once for a **video call** → `zcall-video.pcapng` (for Phase 4 later).

---

## 4. Analyze in Wireshark

### 4a. Find the media server (the relay)
- Statistics → **Conversations** → UDP tab → sort by Bytes. The call's media is
  the **high-volume UDP conversation** to a Zalo/Zing IP. Note its **IP:port**
  (the recon config showed relay IPs like `120.138.74.196` and ports
  `8020/rtp`, `4004/rtcp`). One peer = relayed (good); many peers + STUN = P2P.

### 4b. Is it RTP/RTCP?
- Right-click a packet in that UDP stream → **Decode As… → RTP**. If Wireshark
  shows a valid RTP header (version 2, SSRC, seq, timestamp, payload type), it's
  standard RTP. Then Telephony → **RTP → RTP Streams** to see SSRCs + payload
  types + packet rate.
- Note the **payload type (PT)** numbers and whether RTCP appears on port+1.

### 4c. Is it ZRTP?
- In the display filter type **`zrtp`** and press Enter. If packets show up,
  Wireshark's ZRTP dissector recognized them → expand to see the message
  sequence: **Hello → HelloACK → Commit → DHPart1/2 → Confirm1/2 → Conf2ACK**.
  Standard ZRTP = reusable (GNU ZRTP / libzrtp). Note the **hash/cipher/auth/
  key-agreement/SAS** algorithm names in Hello.
- If `zrtp` shows nothing but there's an early handshake before media → it may be
  custom; export those first packets (hex) for inspection.

### 4d. Cleartext or SRTP?
- After ZRTP completes, are RTP payloads readable (e.g. Opus) or random
  (encrypted = SRTP)? ZRTP normally negotiates SRTP, so expect encrypted media.
  That's fine — libwebrtc + ZRTP handles SRTP keying.

---

## 5. Capture the call `config` + events (secondary, do if easy)

The `config` object (the makeCall input) + `getEventMessage` JSON come from the
JS layer. We already know the schema (see `ZCALL-RECON.md` §3 `testConnect()`),
but real values help. Options:

- **Easiest (Win/Mac desktop):** if a call's `config.settings.logDebug` is set,
  the engine writes `call.log` to the app's userData dir — grab it.
- **mitmproxy** on the API (`api.conf.talk.zing.vn`, `vlogin.zaloapp.com`):
  install the mitm CA on the device, proxy its traffic, read the `call_config`
  response. (TLS — needs cert trust.)
- Skip if hard; the Wireshark media analysis (§4) is the decisive part.

---

## 6. Report back (checklist)

Send me:
1. **§4a:** relay IP:port(s); single peer (relay) or many (P2P)?
2. **§4b:** Does it decode as RTP? payload type numbers? RTCP present?
3. **§4c:** Does `zrtp` filter dissect? the Hello message sequence + algorithm
   names; or "no ZRTP, custom handshake" + a hex dump of the first 5 packets.
4. **§4d:** payloads encrypted (SRTP) or cleartext?
5. Any anomalies (non-RTP framing, extra headers, unknown ports).
6. (Optional §5) the real `config` JSON.

From that I'll decide the engine architecture and write the Phase 3 plan
(libwebrtc integration + the exact codec/ZRTP/relay wiring).

---

## 7. Safety / scope

- Capture only your own calls. Don't publish full pcaps (they contain your
  IPs / SAS / metadata) — share only the specific fields above, redacting if
  needed.
- This is interop reverse-engineering for a client you legitimately use.

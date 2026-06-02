# zcall — Phase 2: Protocol Capture Guide

**Goal:** capture ONE real Zalo call's wire traffic + call config, to decide
whether the media protocol is reversible — i.e. whether to proceed to a
libwebrtc-based engine (Phase 3) or stop.

> Legal: only capture **your own** calls / your own account. This is interop RE
> on traffic you are a party to.

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

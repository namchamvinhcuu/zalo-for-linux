# zcall — ZRTPPacket wire format (DRAFT, reconstructed from PCAP)

Reconstructed 2026-06-02 from a real audio call PCAP (PCAPdroid full dump) +
demangled symbols of `zcall_mac.node` (`zrtc::ZRTPPacket`). **Media is cleartext
Opus — no SRTP/crypto** (see `ZCALL-PHASE2-CAPTURE.md` Round 3). This is the
engineering reference for the Phase-3 engine.

> Confidence: field *semantics* ~90% (types, SSRC, RTP seq/timestamp, RTCP, the
> binding header). The exact **Opus payload start offset** (~24-26) is ±1-2 bytes
> and the role of a few constant bytes is unconfirmed — pin these by
> disassembling `zrtc::ZRTPPacket::buildPacket` / `_buildPacketInternal` with a
> Mach-O disassembler (rizin/radare2). All offsets below are into the UDP payload.

Reference call: relay `42.119.138.120:4200`, client `…:41428`, SSRC `66cdaf12`.

## Packet types (UDP :4200)

| 1st byte(s) | type | dir seen | maps to `ZRTPPacket::` |
|---|---|---|---|
| `01 01` | P2P binding / control / keepalive (replaces STUN) | both | `initP2P{Request,Response,Ack}Binding`, `initZRTPPacketRequest*` |
| `03` | Audio RTP — client→relay (outgoing) | C→R | `initZRTPPacketAudio` |
| `04` | Audio RTP — relay→client (incoming) | R→C | `initZRTPPacketAudio` (relay-rewritten) |
| `05` | RTCP (SR `c8`/RR `c9`/feedback `cd`) | both | (RTCP path) |

(`02 01` also seen, n≈25 — likely a signal/echo control; not yet decoded.)

## Audio OUT — type `0x03` (client → relay)

```
off 0     : 03                  packet type (audio out)
off 1-4   : 66 cd af 12         SSRC (32-bit, per-stream constant)
off 5     : 90                  const flags
off 6     : f1 / 71             marker+PT  (PT=0x71=113 dynamic Opus; bit7 = RTP
                                marker, set on first packet of a talkspurt)
off 7-8   : 0e2d, 0e2e, …       RTP sequence number (BE16, +1 per packet)
off 9-12  : 2d9f34a5, +960…     RTP timestamp (BE32, +960/pkt = 48kHz × 20ms)  ★
off 13-16 : 1b 15 25 ec         secondary stream/session id (const)
off 17-19 : be de 00            const
off 20-21 : 01 51               const
off 22    : 00                  const
off 23    : 01,02,03,…          per-packet frame counter (+1)
off 24    : 00                  const (role TBD — header byte, NOT Opus TOC)
off ~25+  : <Opus payload>      cleartext, variable length   (exact start ±1-2B)
```

★ The +960 timestamp step is the decisive proof: standard Opus over a 48 kHz RTP
clock, 20 ms ptime.

## Audio IN — type `0x04` (relay → client)

Same fields, **different byte order** (the relay rewrites the header):
```
off 0     : 04                  type (audio in)
off 1     : 90
off 2     : f1 / 71             marker+PT
off 3     : 13                  const
off 4     : 66,67,68,…          RTP seq low byte (+1)
off 5-8   : 2d9f3865, +960…     RTP timestamp (BE32, +960)
off 9     : 0e
off 10-12 : 2b 20 42            SSRC-ish (incoming stream id)
off 13-15 : be de 00
off 16-17 : 01 51
off 18    : 00
off 19    : 01,02,…             frame counter
off 20    : 00
off ~21+  : <Opus payload>      cleartext
```

## RTCP — type `0x05`

Wraps a standard RTCP compound after the type + SSRC:
```
off 0     : 05
off 1-4   : SSRC (66cdaf12)  [C→R]   /  00 00 00 00  [R→C]
off 5     : 80/81/8f         RTCP V=2 + RC/FMT
off 6     : c8/c9/cd         RTCP PT (200 SR / 201 RR / 205 feedback)
off 7-8   : length
off 9+    : RTCP body (sender/receiver report, etc.)
```

## Binding / control — type `01 01`

```
off 0-1   : 01 01              type (P2P binding / control)
off 2-5   : 00 00 00 00
off 6-9   : seq (LE uint32, +1 per packet — e.g. 0x28,0x29,…)
off 10-13 : 65 97 3e 00        call/session id (const for the call)
off 14-17 : 3c 83 2f 01        secondary id (candidate/peer id)
off 18    : 05                 subcommand
off 19-20 : 00 00
off 21    : 03
off 22    : 00
off 23+   : ASCII decimal counter ("296","298"…300) on small keepalives;
            on large packets (len ~184) this region carries a base64url RELAY
            TOKEN (e.g. "GYTJvCFH33nB44FP-TyBEqKLC--RtHbjUIyLn…") — the relay
            credential, minted by signaling (centralized.zaloapp.com).
```

The multi-candidate `:4200` "probing" from Round 1 is these binding packets sent
to each `ZRTPServerInfo` candidate; the responsive relay wins.

## Phase-3 build order (from this format)

1. **Binding + relay register** (`01 01`): replicate seq/session-id/token packets;
   get token + relay list from signaling (`makeCall` config, JS layer).
2. **Audio send/recv** (`03`/`04`): build the header above around libopus frames;
   RTP seq/timestamp (+960) bookkeeping.
3. **RTCP** (`05`): SR/RR for keepalive + stats (relay may require it).
4. Pin exact Opus offset + the TBD constant bytes via disassembly before coding
   the parser, to avoid off-by-N bugs.

## Open items (need disassembly — option B)
- Exact Opus payload start (off 24 vs 25 vs 26) and the constant `00` at off24.
- Meaning of consts `90`, `be de 00`, `01 51`, `13`.
- `02 01` packet type.
- Whether the header has a checksum/auth field anywhere (none obvious; no crypto lib linked).

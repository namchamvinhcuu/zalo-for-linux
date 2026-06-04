# zcall-bridge — Wine pipe recon + bridge spike

Scratch workspace for the route B "bridge" between Linux Electron (zalo-for-linux)
and the Wine-hosted ZaloCall.exe engine. See vault `[[ZCall-Native-Engine-IPC]]`
+ `[[ZCall-Port-Feasibility]]` §B.

## Step 4a — pipe-probe (verify pipe role + capture first messages)

```bash
# 1. Install cross-compiler (one-time)
sudo apt install -y gcc-mingw-w64-i686

# 2. Build
cd /tmp/zcall-bridge
make
# -> pipe-probe.exe  (PE32 executable for Windows, runs under Wine)

# 3. Start Zalo Win and initiate a real call:
#    Terminal A:
#    WINEPREFIX=~/Wine-Apps/zalo wine \
#      ~/Wine-Apps/zalo/drive_c/users/namchamvinhcuu/AppData/Local/Programs/Zalo/Zalo-26.1.10/Zalo.exe &
#    -> click call button (ringing -> partner picks up)

# 4. WHILE the call is RINGING / CONNECTED, in Terminal B:
make run
# This runs pipe-probe.exe inside the same Wine prefix.
# Output goes to stdout + probe.log
```

### Expected outcomes

The probe tries `CreateFile` (client mode) first on each pipe:

- **`CreateFile success`** → ZaloCall.exe is SERVER, we just took Zalo.exe's
  client slot. Zalo.exe may bail/reconnect. We'll see real protocol bytes flowing
  through (AES-CBC framed JSON + `$` delimiter, per
  `[[ZCall-Native-Engine-IPC]]` §"Control-channel spec").

- **`err=2 FILE_NOT_FOUND`** → Pipe doesn't exist. Probe falls back to
  `CreateNamedPipe` (server mode). If ZaloCall then connects as client, ZaloCall
  is the CLIENT and Zalo.exe is normally the server. **Re-launch ZaloCall.exe
  with our argv to test this** — see "Standalone ZaloCall test" below.

- **`err=5 ACCESS_DENIED`** or **`err=231 PIPE_BUSY`** → Pipe exists, but max
  instances reached / single-client. ZaloCall is server, Zalo.exe already
  attached. Kill Zalo.exe first then re-probe.

### Standalone ZaloCall test (if needed)

Force-launch ZaloCall.exe directly with our argv, to test pipe creation timing:

```bash
WINEPREFIX=~/Wine-Apps/zalo wine \
  ~/Wine-Apps/zalo/drive_c/users/namchamvinhcuu/AppData/Local/Programs/Zalo/Zalo-26.1.10/plugins/capture/ZaloCall.exe \
  '\\.\pipe\PipeZCallRecv' \
  '\\.\pipe\PipeZCallSend'

# Then in another terminal, immediately run pipe-probe to test connection.
```

ZaloCall.exe may exit quickly if no client connects. Pair launches tightly.

## Step 4b — pipe-mitm (capture protocol verbatim)

```bash
# Build (already happens via `make`)
make

# Install MITM (Zalo Win must NOT be running)
pkill -f Zalo.exe; pkill -f ZaloCall
make install-mitm

# Launch Zalo Win normally, make a call -> MITM logs all bytes
WINEPREFIX=~/Wine-Apps/zalo wine \
  ~/Wine-Apps/zalo/drive_c/users/namchamvinhcuu/AppData/Local/Programs/Zalo/Zalo-26.1.10/Zalo.exe &

# In another terminal, tail the log (raw hex):
make mitm-log

# When done, decrypt the log offline:
LOG=$(find ~/Wine-Apps/zalo -name pipe-mitm.log | head -1)
node decrypt-log.js "$LOG"

# Live decrypt (during call):
node decrypt-log.js "$LOG" --tail

# Restore real engine:
pkill -f Zalo.exe; pkill -f ZaloCall
make uninstall-mitm
```

The MITM:
- Sits at `<...>/plugins/capture/ZaloCall.exe` (replacing the renamed real engine).
- When Zalo.exe spawns it with `\\.\pipe\PipeZCallRecv` + `\\.\pipe\PipeZCallSend`,
  it creates those pipes (as server) and then spawns `ZaloCall-real.exe` with
  `\\.\pipe\PipeZCallMitmRecv` + `\\.\pipe\PipeZCallMitmSend`.
- Forwards bytes both ways, logging each chunk to `%TEMP%/pipe-mitm.log`.
- CMD direction = Zalo.exe → real engine (includes `initCall` with SRTP key!).
- EVT direction = real engine → Zalo.exe (events like `recvSignal`).

Unlocks: (a) full vocabulary + command code table, (b) SRTP key per call,
(c) decryption of `/tmp/zcall-capture.pcap` post-hoc, (d) all the info needed
to build the bridge daemon for route B.

## Final bridge (when route B PoC ready)

Replace the role of Zalo.exe entirely:
- Linux `bridge-daemon` (Node.js): listens on `/tmp/socketzalo{send,recv}2021`
  (matches Electron's `W()` spawn-and-pipe handshake from
  `[[ZCall-Native-Engine-IPC]]`).
- Spawns `wine ZaloCall.exe \\.\pipe\PipeZCallRecv \\.\pipe\PipeZCallSend` under
  the zalo-for-linux's own Wine prefix (bundled inside the AppImage, ideally).
- Bridge piece (PE32 under Wine) forwards named pipe ↔ Linux unix socket
  (Wine 11 supports AF_UNIX, so the bridge can directly write to the daemon's
  unix sockets without a separate TCP hop).
- Electron sees the exact same protocol it expects, no changes to main-dist.

Patch in `scripts/patches/patch-zcall.js`: add a `linux` branch in `W()` of
main.js to spawn the bridge-daemon instead of the macOS binary.

#!/bin/sh
# bridge-daemon.sh — launcher so the bridge runs without a system Node install.
#
# W() spawns this (not the .js directly) with [recvSock, sendSock]. A plain sh script
# needs no Node to *start*; it then picks a JS runtime:
#   1. system `node` (dev / machines that have it), else
#   2. the bundled Electron run as Node (ELECTRON_RUN_AS_NODE) — always present in the
#      AppImage at $APPDIR/zalo-for-linux (executableName), with a relative fallback
#      $DIR/../../zalo-for-linux for when $APPDIR isn't set.
# argv reaches the daemon as argv[2]=recv, argv[3]=send in all cases.

DIR="$(cd "$(dirname "$0")" && pwd)"
DAEMON="$DIR/bridge-daemon.js"

if command -v node >/dev/null 2>&1; then
  exec node "$DAEMON" "$@"
fi

for E in "$APPDIR/zalo-for-linux" "$DIR/../../zalo-for-linux"; do
  if [ -x "$E" ]; then
    exec env ELECTRON_RUN_AS_NODE=1 "$E" "$DAEMON" "$@"
  fi
done

echo "zcall-bridge: no Node runtime found (no system node, no bundled Electron)" >&2
exit 1

# Build the PE32 tools (32-bit Windows, run under Wine).
# Requires: gcc-mingw-w64-i686  (apt install)
#   sudo apt install -y gcc-mingw-w64-i686

CC := i686-w64-mingw32-gcc
CFLAGS := -O2 -Wall -static
LDFLAGS := -lkernel32

# Wine prefix + engine dir. Defaults match dev1-pc (Zalo Win 21.12.1 engine extracted into
# a portable prefix). Override on the command line for other machines/versions:
#   make bridge-test WINEPREFIX=~/Wine-Apps/zalo ENGINE_DIR=.../plugins/capture
WINEPREFIX ?= $(HOME)/Namchamvinhcuu-Wine-Apps/Zalo
ENGINE_DIR ?= $(WINEPREFIX)/drive_c/zalo-engine
# Legacy MITM target (nam-laptop layout, Zalo Win 26.1.10 installed in-place)
ZALO_CAP_DIR := $(HOME)/Wine-Apps/zalo/drive_c/users/$(USER)/AppData/Local/Programs/Zalo/Zalo-26.1.10/plugins/capture

.PHONY: all run clean install-mitm uninstall-mitm mitm-log bridge-test

all: pipe-probe.exe pipe-mitm.exe engine-probe.exe bridge-shim.exe

%.exe: %.c
	$(CC) $(CFLAGS) -o $@ $< $(LDFLAGS)
	@file $@

# End-to-end route-B bridge self-test: mock-electron spawns bridge-daemon -> wine
# bridge-shim -> ZaloCall.exe, verifies native-ready + multi-chunk command flow.
# Needs the engine present at ENGINE_DIR and gcc-mingw + wine installed.
bridge-test: bridge-shim.exe
	WINEPREFIX=$(WINEPREFIX) ZCALL_ENGINE_DIR=$(ENGINE_DIR) node mock-electron.js

# Run probe under Wine. ZaloCall.exe must already be spawned (initiate a call first).
# Pipe paths are kept literal in single-quotes — Make/shell don't transform backslashes
# inside single-quotes, so argv reaches the PE32 as `\\.\pipe\PipeZCall...`.
run: pipe-probe.exe
	WINEPREFIX=$(WINEPREFIX) wine ./pipe-probe.exe '\\.\pipe\PipeZCallRecv' '\\.\pipe\PipeZCallSend' 2>&1 | tee probe.log

# Install MITM in place of the real ZaloCall.exe.
# Stashes real engine as ZaloCall-real.exe.
install-mitm: pipe-mitm.exe
	@if [ ! -f "$(ZALO_CAP_DIR)/ZaloCall.exe" ]; then \
	    echo "ERROR: ZaloCall.exe not found at $(ZALO_CAP_DIR)"; exit 1; \
	fi
	@RUNNING=$$(pgrep -af 'Zalo-26\.1\.10.*\.exe' 2>/dev/null | grep -v 'make\|/bin/sh\|pgrep' || true); \
	if [ -n "$$RUNNING" ]; then \
	    echo "ERROR: Wine Zalo processes still running:"; echo "$$RUNNING"; \
	    echo "Run: pkill -f 'Zalo-26.1.10'"; exit 1; \
	fi
	@if [ ! -f "$(ZALO_CAP_DIR)/ZaloCall-real.exe" ]; then \
	    echo "Stashing real engine: $(ZALO_CAP_DIR)/ZaloCall.exe -> ZaloCall-real.exe"; \
	    mv "$(ZALO_CAP_DIR)/ZaloCall.exe" "$(ZALO_CAP_DIR)/ZaloCall-real.exe"; \
	else \
	    echo "ZaloCall-real.exe already exists, skipping rename"; \
	    rm -f "$(ZALO_CAP_DIR)/ZaloCall.exe"; \
	fi
	cp pipe-mitm.exe "$(ZALO_CAP_DIR)/ZaloCall.exe"
	@echo "MITM installed. Launch Zalo Win and make a call — log goes to:"
	@echo "  $(WINEPREFIX)/drive_c/zcall-mitm.log"
	@echo "Tail with: make mitm-log"

uninstall-mitm:
	@if [ ! -f "$(ZALO_CAP_DIR)/ZaloCall-real.exe" ]; then \
	    echo "ERROR: ZaloCall-real.exe backup not found; MITM probably not installed"; exit 1; \
	fi
	@RUNNING=$$(pgrep -af 'Zalo-26\.1\.10.*\.exe' 2>/dev/null | grep -v 'make\|/bin/sh\|pgrep' || true); \
	if [ -n "$$RUNNING" ]; then \
	    echo "ERROR: Wine Zalo processes still running:"; echo "$$RUNNING"; \
	    echo "Run: pkill -f 'Zalo-26.1.10'"; exit 1; \
	fi
	mv "$(ZALO_CAP_DIR)/ZaloCall.exe" "$(ZALO_CAP_DIR)/ZaloCall.exe.mitm.bak"
	mv "$(ZALO_CAP_DIR)/ZaloCall-real.exe" "$(ZALO_CAP_DIR)/ZaloCall.exe"
	@echo "Restored. MITM stashed at ZaloCall.exe.mitm.bak"

mitm-log:
	@LOG=$(WINEPREFIX)/drive_c/zcall-mitm.log; \
	touch "$$LOG"; \
	echo "Tailing $$LOG (Ctrl-C to stop)"; \
	tail -f "$$LOG"

clean:
	rm -f pipe-probe.exe pipe-mitm.exe engine-probe.exe bridge-shim.exe probe.log

// engine-probe.c — "fake Electron" harness to bring up ZaloCall.exe under our control.
//
// Purpose: verify a given ZaloCall.exe build (e.g. the older 21.12.1 engine on dev1-pc)
// actually boots and reaches `update/native-ready` when driven by us, WITHOUT needing a
// real Zalo login or the full Linux bridge. This de-risks route B's biggest unknown:
// "does this engine version still speak the protocol our 26.5.20 Electron expects?".
//
// Topology (matches Electron main.js — Electron is SERVER, engine is CLIENT):
//   recv pipe (argv[1], default PipeZCallRecv): engine WRITES events, we READ.
//   send pipe (argv[2], default PipeZCallSend): we WRITE commands, engine READS.
// We create both as named-pipe servers, spawn the engine as client, then log every
// raw frame the engine emits on recv. Frames are AES-128-CBC(JSON).hex + "$" — decrypt
// offline with decrypt-log.js (key yjAF9oqMWl6XfXYJn9mA7w==).
//
// Read-only by default: we never write commands, just observe the engine's own boot
// chatter (it emits native-ready on internal readiness). If the engine stalls waiting
// for an updateLocal first, that shows up as "engine connected, no frames" in the log.
//
// Build:  i686-w64-mingw32-gcc -O2 -Wall -static -o engine-probe.exe engine-probe.c -lkernel32
// Run (cwd MUST be the engine dir so Qt5/libeay32 DLLs load):
//   cd ~/Wine-Apps/zalo-2112/drive_c/zalo-engine
//   WINEPREFIX=~/Wine-Apps/zalo-2112 wine /path/to/engine-probe.exe
// Log: C:\zcall-probe.log  (drive_c/zcall-probe.log on the host).

#include <windows.h>
#include <stdio.h>
#include <stdarg.h>
#include <string.h>

static FILE *g_log = NULL;
static CRITICAL_SECTION g_lock;

static void log_ts(void) {
    SYSTEMTIME st; GetLocalTime(&st);
    fprintf(g_log, "[%02d:%02d:%02d.%03d] ", st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
}
static void log_line(const char *fmt, ...) {
    va_list ap;
    EnterCriticalSection(&g_lock);
    if (g_log) { log_ts(); va_start(ap, fmt); vfprintf(g_log, fmt, ap); va_end(ap); fputc('\n', g_log); fflush(g_log); }
    LeaveCriticalSection(&g_lock);
}
static void log_chunk(const char *dir, const unsigned char *buf, DWORD n) {
    EnterCriticalSection(&g_lock);
    if (g_log) {
        log_ts();
        fprintf(g_log, "[%s] %lu bytes:\n", dir, (unsigned long)n);
        for (DWORD i = 0; i < n; i++) {
            unsigned char c = buf[i];
            if (c == '\n') fprintf(g_log, "\\n");
            else if (c == '\r') fprintf(g_log, "\\r");
            else if (c >= 32 && c < 127) fputc(c, g_log);
            else fprintf(g_log, "\\x%02x", c);
        }
        fputc('\n', g_log); fflush(g_log);
    }
    LeaveCriticalSection(&g_lock);
}

// Read forever from the engine's event pipe and log raw frames.
static DWORD WINAPI recv_thread(LPVOID arg) {
    HANDLE h = (HANDLE)arg;
    unsigned char buf[16384];
    DWORD n_read;
    log_line("recv_thread started");
    while (1) {
        if (!ReadFile(h, buf, sizeof(buf), &n_read, NULL) || n_read == 0) {
            log_line("recv_thread read end err=%lu n=%lu", (unsigned long)GetLastError(), (unsigned long)n_read);
            break;
        }
        log_chunk("EVT", buf, n_read);
    }
    return 0;
}

int main(int argc, char **argv) {
    InitializeCriticalSection(&g_lock);
    g_log = fopen("C:\\zcall-probe.log", "a");
    if (!g_log) g_log = stderr;

    const char *recv_name = (argc > 1) ? argv[1] : "\\\\.\\pipe\\PipeZCallRecv";
    const char *send_name = (argc > 2) ? argv[2] : "\\\\.\\pipe\\PipeZCallSend";

    log_line("=================================");
    log_line("=== engine-probe START PID=%lu ===", (unsigned long)GetCurrentProcessId());
    log_line("recv(events, engine->us) = %s", recv_name);
    log_line("send(commands, us->engine) = %s", send_name);

    // Engine lives in our cwd (we are launched from the engine dir).
    char engine_dir[MAX_PATH];
    GetCurrentDirectoryA(MAX_PATH, engine_dir);
    char engine_path[MAX_PATH];
    snprintf(engine_path, sizeof(engine_path), "%s\\ZaloCall.exe", engine_dir);
    log_line("engine = %s", engine_path);

    // --- 1. Create both server pipes (engine connects to these as client) ---
    HANDLE h_recv = CreateNamedPipeA(recv_name, PIPE_ACCESS_DUPLEX,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT, 1, 65536, 65536, 0, NULL);
    if (h_recv == INVALID_HANDLE_VALUE) { log_line("FATAL: recv CreateNamedPipe err=%lu", (unsigned long)GetLastError()); return 3; }
    HANDLE h_send = CreateNamedPipeA(send_name, PIPE_ACCESS_DUPLEX,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT, 1, 65536, 65536, 0, NULL);
    if (h_send == INVALID_HANDLE_VALUE) { log_line("FATAL: send CreateNamedPipe err=%lu", (unsigned long)GetLastError()); return 4; }
    log_line("server pipes created");

    // --- 2. Spawn engine. argv[0] basename must read "ZaloCall.exe"; cwd = engine dir. ---
    char cmdline[1024];
    snprintf(cmdline, sizeof(cmdline), "\"ZaloCall.exe\" \"%s\" \"%s\"", recv_name, send_name);
    log_line("spawn cmd=%s cwd=%s", cmdline, engine_dir);
    STARTUPINFOA si = { 0 }; si.cb = sizeof(si);
    PROCESS_INFORMATION pi = { 0 };
    if (!CreateProcessA(engine_path, cmdline, NULL, NULL, FALSE, 0, NULL, engine_dir, &si, &pi)) {
        log_line("FATAL: CreateProcess err=%lu", (unsigned long)GetLastError());
        return 6;
    }
    log_line("engine PID=%lu", (unsigned long)pi.dwProcessId);

    // --- 3. Wait for engine to connect to both pipes ---
    if (!ConnectNamedPipe(h_recv, NULL) && GetLastError() != ERROR_PIPE_CONNECTED) {
        log_line("FATAL: recv ConnectNamedPipe err=%lu", (unsigned long)GetLastError()); return 7;
    }
    log_line("recv: engine connected");
    if (!ConnectNamedPipe(h_send, NULL) && GetLastError() != ERROR_PIPE_CONNECTED) {
        log_line("FATAL: send ConnectNamedPipe err=%lu", (unsigned long)GetLastError()); return 8;
    }
    log_line("send: engine connected");

    // --- 4. Read engine events; observe whether it reaches native-ready ---
    HANDLE t = CreateThread(NULL, 0, recv_thread, h_recv, 0, NULL);

    log_line("probe running; waiting for engine exit (or kill after observing)");
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 0; GetExitCodeProcess(pi.hProcess, &code);
    log_line("engine exited code=%lu", (unsigned long)code);

    if (t) WaitForSingleObject(t, 500);
    CloseHandle(h_recv); CloseHandle(h_send);
    CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
    log_line("=== engine-probe END ===");
    if (g_log != stderr) fclose(g_log);
    return (int)code;
}

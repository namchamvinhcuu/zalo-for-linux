// pipe-mitm.c — man-in-the-middle for ZaloCall.exe <-> Zalo.exe (Electron) pipes.
//
// CORRECTED TOPOLOGY (verified from Electron main.js):
//   Electron (Zalo.exe) is the SERVER on both named pipes:
//     C = net.createServer(); C.listen("\\.\pipe\PipeZCallRecv")   // engine -> Electron (events)
//     A = net.createServer(); A.listen("\\.\pipe\PipeZCallSend")   // Electron -> engine (commands)
//     O = spawn(ZaloCall.exe, [PipeZCallRecv, PipeZCallSend])      // engine is CLIENT
//
//   So the real ZaloCall.exe CONNECTS (CreateFile) to those pipes as a client.
//
// MITM sits in place of ZaloCall.exe (spawned by Electron with the real argv):
//   OUTER side (toward Electron): connect as CLIENT to the two argv pipes.
//     - outerRecv = CreateFile(argv[1])  -> MITM WRITES events here  (Electron reads)
//     - outerSend = CreateFile(argv[2])  -> MITM READS  commands here (Electron wrote)
//   INNER side (toward real engine): create SERVER pipes with new names, spawn real engine.
//     - innerRecv = CreateNamedPipe(PipeZCallMitmRecv) -> MITM READS  events  (engine writes)
//     - innerSend = CreateNamedPipe(PipeZCallMitmSend) -> MITM WRITES commands (engine reads)
//
//   Forward:
//     CMD thread: read outerSend  -> write innerSend  (Electron -> engine commands)
//     EVT thread: read innerRecv  -> write outerRecv  (engine -> Electron events)
//
// Build:  i686-w64-mingw32-gcc -O2 -Wall -static -o pipe-mitm.exe pipe-mitm.c -lkernel32
// Install: see Makefile `install-mitm`.  Log: C:\zcall-mitm.log

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

typedef struct { HANDLE h_read; HANDLE h_write; const char *dir; } fwd_ctx;

static DWORD WINAPI forward_thread(LPVOID arg) {
    fwd_ctx *ctx = (fwd_ctx *)arg;
    unsigned char buf[16384];
    DWORD n_read, n_written;
    log_line("forward[%s] started", ctx->dir);
    while (1) {
        if (!ReadFile(ctx->h_read, buf, sizeof(buf), &n_read, NULL) || n_read == 0) {
            log_line("forward[%s] read end err=%lu n=%lu", ctx->dir, (unsigned long)GetLastError(), (unsigned long)n_read);
            break;
        }
        log_chunk(ctx->dir, buf, n_read);
        if (!WriteFile(ctx->h_write, buf, n_read, &n_written, NULL) || n_written != n_read) {
            log_line("forward[%s] write err=%lu wrote=%lu/%lu", ctx->dir, (unsigned long)GetLastError(),
                (unsigned long)n_written, (unsigned long)n_read);
            break;
        }
    }
    return 0;
}

// Connect as client to an Electron-served pipe, retrying while Electron's listen() settles.
static HANDLE connect_outer(const char *path, const char *tag) {
    for (int retry = 0; retry < 100; retry++) {
        HANDLE h = CreateFileA(path, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING, 0, NULL);
        if (h != INVALID_HANDLE_VALUE) {
            log_line("outer[%s] connected to %s (retry %d)", tag, path, retry);
            return h;
        }
        DWORD err = GetLastError();
        if (err == ERROR_PIPE_BUSY) { WaitNamedPipeA(path, 1000); continue; }
        Sleep(100);
    }
    log_line("outer[%s] FAILED to connect to %s after 10s", tag, path);
    return INVALID_HANDLE_VALUE;
}

int main(int argc, char **argv) {
    InitializeCriticalSection(&g_lock);
    g_log = fopen("C:\\zcall-mitm.log", "a");
    if (!g_log) g_log = stderr;

    log_line("=================================");
    log_line("=== pipe-mitm START PID=%lu ===", (unsigned long)GetCurrentProcessId());
    log_line("argc=%d", argc);
    for (int i = 0; i < argc; i++) log_line("  argv[%d] = %s", i, argv[i]);
    if (argc < 3) { log_line("FATAL: need 2 pipe args"); return 1; }

    const char *outer_recv = argv[1];  // PipeZCallRecv : engine -> Electron (events)
    const char *outer_send = argv[2];  // PipeZCallSend : Electron -> engine (commands)
    const char *inner_recv = "\\\\.\\pipe\\PipeZCallMitmRecv";
    const char *inner_send = "\\\\.\\pipe\\PipeZCallMitmSend";

    // --- Locate real engine next to us ---
    char self_path[MAX_PATH]; GetModuleFileNameA(NULL, self_path, MAX_PATH);
    char real_path[MAX_PATH]; strcpy(real_path, self_path);
    char *p = strrchr(real_path, '\\'); if (!p) p = strrchr(real_path, '/');
    if (!p) { log_line("FATAL: bad self_path %s", self_path); return 2; }
    strcpy(p + 1, "ZaloCall-real.exe");
    log_line("real engine: %s", real_path);

    char engine_dir[MAX_PATH]; strcpy(engine_dir, real_path);
    char *slash = strrchr(engine_dir, '\\'); if (!slash) slash = strrchr(engine_dir, '/');
    if (slash) *slash = '\0';

    // --- 1. Create INNER server pipes (engine will connect to these as client) ---
    HANDLE h_inner_recv = CreateNamedPipeA(inner_recv, PIPE_ACCESS_DUPLEX,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT, 1, 65536, 65536, 0, NULL);
    if (h_inner_recv == INVALID_HANDLE_VALUE) { log_line("FATAL: inner_recv CreateNamedPipe err=%lu", (unsigned long)GetLastError()); return 3; }
    HANDLE h_inner_send = CreateNamedPipeA(inner_send, PIPE_ACCESS_DUPLEX,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT, 1, 65536, 65536, 0, NULL);
    if (h_inner_send == INVALID_HANDLE_VALUE) { log_line("FATAL: inner_send CreateNamedPipe err=%lu", (unsigned long)GetLastError()); return 4; }
    log_line("inner server pipes created");

    // --- 2. Connect OUTER (to Electron's servers) as client ---
    HANDLE h_outer_recv = connect_outer(outer_recv, "RECV");
    HANDLE h_outer_send = connect_outer(outer_send, "SEND");
    if (h_outer_recv == INVALID_HANDLE_VALUE || h_outer_send == INVALID_HANDLE_VALUE) {
        log_line("FATAL: could not connect to Electron's pipes");
        return 5;
    }

    // --- 3. Spawn the real engine with inner pipe names.  argv[0] must read "ZaloCall.exe". ---
    char cmdline[1024];
    snprintf(cmdline, sizeof(cmdline), "\"ZaloCall.exe\" \"%s\" \"%s\"", inner_recv, inner_send);
    log_line("spawn app=%s cmd=%s cwd=%s", real_path, cmdline, engine_dir);
    STARTUPINFOA si = { 0 }; si.cb = sizeof(si);
    PROCESS_INFORMATION pi = { 0 };
    if (!CreateProcessA(real_path, cmdline, NULL, NULL, FALSE, 0, NULL, engine_dir, &si, &pi)) {
        log_line("FATAL: CreateProcess err=%lu", (unsigned long)GetLastError());
        return 6;
    }
    log_line("real engine PID=%lu", (unsigned long)pi.dwProcessId);

    // --- 4. Wait for engine to connect to inner server pipes ---
    if (!ConnectNamedPipe(h_inner_recv, NULL) && GetLastError() != ERROR_PIPE_CONNECTED) {
        log_line("FATAL: inner_recv ConnectNamedPipe err=%lu", (unsigned long)GetLastError()); return 7;
    }
    log_line("inner_recv: engine connected");
    if (!ConnectNamedPipe(h_inner_send, NULL) && GetLastError() != ERROR_PIPE_CONNECTED) {
        log_line("FATAL: inner_send ConnectNamedPipe err=%lu", (unsigned long)GetLastError()); return 8;
    }
    log_line("inner_send: engine connected");

    // --- 5. Forward threads ---
    //   CMD: Electron -> engine  (read outer_send, write inner_send)
    //   EVT: engine  -> Electron (read inner_recv, write outer_recv)
    static fwd_ctx ctx_cmd, ctx_evt;
    ctx_cmd.h_read = h_outer_send; ctx_cmd.h_write = h_inner_send; ctx_cmd.dir = "CMD";
    ctx_evt.h_read = h_inner_recv; ctx_evt.h_write = h_outer_recv; ctx_evt.dir = "EVT";
    HANDLE t1 = CreateThread(NULL, 0, forward_thread, &ctx_cmd, 0, NULL);
    HANDLE t2 = CreateThread(NULL, 0, forward_thread, &ctx_evt, 0, NULL);

    log_line("MITM running; waiting for engine exit");
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 0; GetExitCodeProcess(pi.hProcess, &code);
    log_line("engine exited code=%lu", (unsigned long)code);

    // Let forward threads drain briefly
    if (t1) WaitForSingleObject(t1, 500);
    if (t2) WaitForSingleObject(t2, 500);

    CloseHandle(h_inner_recv); CloseHandle(h_inner_send);
    CloseHandle(h_outer_recv); CloseHandle(h_outer_send);
    CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
    log_line("=== pipe-mitm END ===");
    if (g_log != stderr) fclose(g_log);
    return (int)code;
}

// bridge-shim.c — Wine-side half of the route-B call bridge.
//
// Runs as a PE32 under Wine. Bridges the Windows call engine (ZaloCall.exe, which only
// speaks named pipes) to the Linux bridge-daemon (which owns the unix sockets that
// zalo-for-linux's Electron serves). Transport to the daemon is plain stdio:
//
//   daemon --(stdin)--> shim --(send pipe, raw hex$)--> engine    (commands)
//   daemon <--(stdout)- shim <-(recv pipe, raw hex$)--- engine    (events)
//
// The shim is a dumb byte pump: the daemon does all the framing/chunk/ack work (that
// logic belongs to the unix-socket side; see ZCall-Native-Engine-IPC). The engine reads
// raw hex$ frames (Windows uses the `z` raw write path, confirmed via engine-probe), and
// emits raw hex$ events (read path Y never reassembles chunks), so no framing here.
//
// Topology mirrors engine-probe: Electron-on-Windows is the pipe SERVER and the engine
// is the CLIENT, so the shim creates both pipe servers and spawns the engine as client.
//
// Build:  i686-w64-mingw32-gcc -O2 -Wall -static -o bridge-shim.exe bridge-shim.c -lkernel32
// Run (spawned by bridge-daemon.js; cwd MUST be the engine dir for Qt5/libeay32 DLLs):
//   WINEPREFIX=... wine bridge-shim.exe \\.\pipe\PipeZCallRecv \\.\pipe\PipeZCallSend
// Log: C:\zcall-shim.log

#include <windows.h>
#include <stdio.h>
#include <stdarg.h>
#include <string.h>

static FILE *g_log = NULL;
static CRITICAL_SECTION g_lock;

static void log_line(const char *fmt, ...) {
    va_list ap;
    EnterCriticalSection(&g_lock);
    if (g_log) {
        SYSTEMTIME st; GetLocalTime(&st);
        fprintf(g_log, "[%02d:%02d:%02d.%03d] ", st.wHour, st.wMinute, st.wSecond, st.wMilliseconds);
        va_start(ap, fmt); vfprintf(g_log, fmt, ap); va_end(ap);
        fputc('\n', g_log); fflush(g_log);
    }
    LeaveCriticalSection(&g_lock);
}

typedef struct { HANDLE h_read; HANDLE h_write; const char *dir; } pump_ctx;

// Pump bytes from h_read to h_write until either side closes.
static DWORD WINAPI pump_thread(LPVOID arg) {
    pump_ctx *c = (pump_ctx *)arg;
    unsigned char buf[16384];
    DWORD n_read, n_written, off;
    log_line("pump[%s] started", c->dir);
    while (1) {
        if (!ReadFile(c->h_read, buf, sizeof(buf), &n_read, NULL) || n_read == 0) {
            log_line("pump[%s] read end err=%lu n=%lu", c->dir, (unsigned long)GetLastError(), (unsigned long)n_read);
            break;
        }
        // Write fully (handles short writes on the pipe/stdout).
        for (off = 0; off < n_read; off += n_written) {
            if (!WriteFile(c->h_write, buf + off, n_read - off, &n_written, NULL) || n_written == 0) {
                log_line("pump[%s] write err=%lu", c->dir, (unsigned long)GetLastError());
                return 0;
            }
        }
    }
    return 0;
}

int main(int argc, char **argv) {
    InitializeCriticalSection(&g_lock);
    g_log = fopen("C:\\zcall-shim.log", "a");
    if (!g_log) g_log = stderr;

    const char *recv_name = (argc > 1) ? argv[1] : "\\\\.\\pipe\\PipeZCallRecv";
    const char *send_name = (argc > 2) ? argv[2] : "\\\\.\\pipe\\PipeZCallSend";

    log_line("=================================");
    log_line("=== bridge-shim START PID=%lu ===", (unsigned long)GetCurrentProcessId());
    log_line("recv(events, engine->us) = %s", recv_name);
    log_line("send(commands, us->engine) = %s", send_name);

    HANDLE h_stdin = GetStdHandle(STD_INPUT_HANDLE);
    HANDLE h_stdout = GetStdHandle(STD_OUTPUT_HANDLE);

    // Engine lives in our cwd (daemon launches wine with cwd = engine dir).
    char engine_dir[MAX_PATH];
    GetCurrentDirectoryA(MAX_PATH, engine_dir);
    char engine_path[MAX_PATH];
    snprintf(engine_path, sizeof(engine_path), "%s\\ZaloCall.exe", engine_dir);
    log_line("engine = %s", engine_path);

    // --- 1. Create both server pipes (engine connects as client) ---
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

    // --- 4. Byte pumps ---
    //   EVT: engine recv pipe -> stdout (to daemon)
    //   CMD: stdin (from daemon) -> engine send pipe
    static pump_ctx ctx_evt, ctx_cmd;
    ctx_evt.h_read = h_recv;  ctx_evt.h_write = h_stdout; ctx_evt.dir = "EVT";
    ctx_cmd.h_read = h_stdin; ctx_cmd.h_write = h_send;   ctx_cmd.dir = "CMD";
    HANDLE t1 = CreateThread(NULL, 0, pump_thread, &ctx_evt, 0, NULL);
    HANDLE t2 = CreateThread(NULL, 0, pump_thread, &ctx_cmd, 0, NULL);

    log_line("shim running; waiting for engine exit");
    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 0; GetExitCodeProcess(pi.hProcess, &code);
    log_line("engine exited code=%lu", (unsigned long)code);

    if (t1) WaitForSingleObject(t1, 500);
    if (t2) WaitForSingleObject(t2, 500);
    CloseHandle(h_recv); CloseHandle(h_send);
    CloseHandle(pi.hProcess); CloseHandle(pi.hThread);
    log_line("=== bridge-shim END ===");
    if (g_log != stderr) fclose(g_log);
    return (int)code;
}

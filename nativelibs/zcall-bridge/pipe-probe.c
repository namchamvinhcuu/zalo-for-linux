// pipe-probe.c — verify ZaloCall pipe role + dump first flow
// Build (Linux, no mingw needed): winegcc -mconsole -m32 -o pipe-probe.exe pipe-probe.c
// Run (under wine):
//   WINEPREFIX=~/Wine-Apps/zalo wine pipe-probe.exe \\.\pipe\PipeZCallRecv \\.\pipe\PipeZCallSend
// Notes:
//   * ZaloCall.exe spawn order in real call: parent passes 2 pipe paths via argv.
//     We don't know yet which side creates (server) vs connects (client).
//   * Strategy: try CreateFile (client). If pipe doesn't exist -> ZaloCall is the
//     creator (server) and we're early; try CreateNamedPipe (server) instead.
//   * For each pipe, after connect, kick off a reader thread that dumps incoming
//     bytes hex+ASCII to stdout. Sniff for ~30s then exit.

#include <windows.h>
#include <stdio.h>
#include <string.h>

#define DUMP_MAX 4096
#define SNIFF_SECS 30

static void hexdump(const char *tag, const unsigned char *buf, DWORD n) {
    DWORD i;
    for (i = 0; i < n; i += 16) {
        DWORD j; DWORD line = (n - i < 16) ? (n - i) : 16;
        printf("[%s] %04lx: ", tag, (unsigned long)i);
        for (j = 0; j < 16; j++) {
            if (j < line) printf("%02x ", buf[i+j]); else printf("   ");
            if (j == 7) printf(" ");
        }
        printf(" |");
        for (j = 0; j < line; j++) {
            unsigned char c = buf[i+j];
            printf("%c", (c >= 32 && c < 127) ? c : '.');
        }
        printf("|\n");
    }
    fflush(stdout);
}

typedef struct {
    HANDLE h;
    char tag[32];
} reader_ctx;

static DWORD WINAPI reader_thread(LPVOID arg) {
    reader_ctx *ctx = (reader_ctx *)arg;
    unsigned char buf[1024];
    DWORD n;
    DWORD total = 0;
    while (total < DUMP_MAX) {
        BOOL ok = ReadFile(ctx->h, buf, sizeof(buf), &n, NULL);
        if (!ok) {
            DWORD err = GetLastError();
            printf("[%s] ReadFile error %lu (total read %lu)\n", ctx->tag, (unsigned long)err, (unsigned long)total);
            fflush(stdout);
            break;
        }
        if (n == 0) {
            printf("[%s] EOF\n", ctx->tag);
            fflush(stdout);
            break;
        }
        printf("[%s] +%lu bytes (total %lu)\n", ctx->tag, (unsigned long)n, (unsigned long)(total + n));
        hexdump(ctx->tag, buf, n > DUMP_MAX - total ? DUMP_MAX - total : n);
        total += n;
    }
    return 0;
}

// Try to attach to pipe (client first; if not present, become server)
// Returns INVALID_HANDLE_VALUE on total failure
static HANDLE attach_pipe(const char *path, const char *tag, int *out_role /* 0=client, 1=server */) {
    HANDLE h;
    DWORD err;

    // CLIENT: CreateFile on existing named pipe
    h = CreateFileA(path, GENERIC_READ | GENERIC_WRITE, 0, NULL,
                    OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (h != INVALID_HANDLE_VALUE) {
        printf("[%s] CLIENT mode: connected to %s\n", tag, path);
        *out_role = 0;
        return h;
    }
    err = GetLastError();
    printf("[%s] CreateFile failed: err=%lu (%s)\n", tag, (unsigned long)err,
        err == 2 ? "FILE_NOT_FOUND" :
        err == 5 ? "ACCESS_DENIED" :
        err == 231 ? "PIPE_BUSY" :
        "other");

    if (err == ERROR_PATH_NOT_FOUND) {
        printf("[%s] Path malformed (err=3). Check argv escaping for the pipe path.\n", tag);
        return INVALID_HANDLE_VALUE;
    }
    if (err == ERROR_ACCESS_DENIED) {
        printf("[%s] Access denied (err=5) — ZaloCall is SERVER with restricted ACL or already saturated\n", tag);
        return INVALID_HANDLE_VALUE;
    }
    if (err == ERROR_PIPE_BUSY) {
        printf("[%s] Pipe busy (err=231) — ZaloCall is SERVER, Zalo.exe already attached. Kill Zalo.exe and retry.\n", tag);
        return INVALID_HANDLE_VALUE;
    }
    if (err != ERROR_FILE_NOT_FOUND) {
        // Other error
        printf("[%s] Unexpected error (err=%lu)\n", tag, (unsigned long)err);
        return INVALID_HANDLE_VALUE;
    }

    // SERVER: pipe doesn't exist -> ZaloCall expects someone to create it
    printf("[%s] Pipe not found -> trying SERVER mode (CreateNamedPipe)\n", tag);
    h = CreateNamedPipeA(path,
        PIPE_ACCESS_DUPLEX,
        PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT,
        1,         // max instances
        4096, 4096,
        0,         // default timeout
        NULL);
    if (h == INVALID_HANDLE_VALUE) {
        err = GetLastError();
        printf("[%s] CreateNamedPipe failed: err=%lu\n", tag, (unsigned long)err);
        return INVALID_HANDLE_VALUE;
    }
    printf("[%s] SERVER mode: pipe created at %s, waiting for client (30s timeout via overlapped...)\n", tag, path);
    // Note: ConnectNamedPipe blocks until client connects
    BOOL ok = ConnectNamedPipe(h, NULL);
    if (!ok) {
        err = GetLastError();
        if (err == ERROR_PIPE_CONNECTED) {
            // already connected
            printf("[%s] SERVER: already had client\n", tag);
        } else {
            printf("[%s] ConnectNamedPipe failed: err=%lu\n", tag, (unsigned long)err);
            CloseHandle(h);
            return INVALID_HANDLE_VALUE;
        }
    } else {
        printf("[%s] SERVER: client connected\n", tag);
    }
    *out_role = 1;
    return h;
}

int main(int argc, char **argv) {
    if (argc < 3) {
        fprintf(stderr, "Usage: %s \\\\.\\pipe\\PipeZCallRecv \\\\.\\pipe\\PipeZCallSend\n", argv[0]);
        return 1;
    }
    const char *recv_path = argv[1];
    const char *send_path = argv[2];

    printf("=== pipe-probe ===\n");
    printf("recv_path: %s (len=%zu)\n", recv_path, strlen(recv_path));
    {
        size_t i;
        printf("recv_hex : ");
        for (i = 0; i < strlen(recv_path); i++) printf("%02x ", (unsigned char)recv_path[i]);
        printf("\n");
    }
    printf("send_path: %s (len=%zu)\n", send_path, strlen(send_path));
    fflush(stdout);

    int recv_role = -1, send_role = -1;
    HANDLE h_recv = attach_pipe(recv_path, "RECV", &recv_role);
    HANDLE h_send = attach_pipe(send_path, "SEND", &send_role);

    if (h_recv == INVALID_HANDLE_VALUE && h_send == INVALID_HANDLE_VALUE) {
        printf("Both pipes failed. Exit.\n");
        return 2;
    }

    printf("\n=== Sniffing for %d seconds ===\n", SNIFF_SECS);

    HANDLE threads[2] = {NULL, NULL};
    int nt = 0;
    static reader_ctx ctx_recv, ctx_send;
    if (h_recv != INVALID_HANDLE_VALUE) {
        ctx_recv.h = h_recv;
        strcpy(ctx_recv.tag, "RECV");
        threads[nt++] = CreateThread(NULL, 0, reader_thread, &ctx_recv, 0, NULL);
    }
    if (h_send != INVALID_HANDLE_VALUE) {
        ctx_send.h = h_send;
        strcpy(ctx_send.tag, "SEND");
        threads[nt++] = CreateThread(NULL, 0, reader_thread, &ctx_send, 0, NULL);
    }

    DWORD start = GetTickCount();
    while (GetTickCount() - start < (DWORD)(SNIFF_SECS * 1000)) {
        Sleep(500);
    }

    printf("=== Sniff window done ===\n");
    if (h_recv != INVALID_HANDLE_VALUE) CloseHandle(h_recv);
    if (h_send != INVALID_HANDLE_VALUE) CloseHandle(h_send);
    // Threads will exit when handles close
    return 0;
}

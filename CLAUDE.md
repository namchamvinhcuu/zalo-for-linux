# CLAUDE.md

Hướng dẫn làm việc cho Claude trong dự án **zalo-for-linux**.

> **Giao tiếp với user bằng tiếng Việt.** Mọi câu hỏi clarify, đề xuất, xác nhận hành động → tiếng Việt. KHÔNG áp dụng cho: code, identifier, commit message, comment, error/log copy nguyên từ tool.

---

## 1. Dự án này là gì

`zalo-for-linux` **không phải là bản viết lại Zalo**. Nó là một **công cụ đóng gói (repackaging tool)**: lấy app Zalo macOS chính thức và bọc lại thành AppImage chạy trên Linux.

Luồng cốt lõi:

1. Tải file `.dmg` Zalo macOS chính thức.
2. Dùng `7z` + `@electron/asar` giải nén `app.asar` (logic Zalo viết bằng JavaScript đã minify) ra thư mục `app/`.
3. **Patch** code đã giải nén cho tương thích Linux (title bar, sqlite3, native addons, clipboard…).
4. Bọc bằng một Electron shell tối giản (`main.js` ở root) + các plugin.
5. Dùng `electron-builder` đóng gói thành AppImage trong `dist/`.

Tài liệu chi tiết (đọc khi cần, đây là knowledge base thật của dự án):

- **`README.md`** — tổng quan, known issues, hướng dẫn dùng/build.
- **`ARCHITECTURE.md`** — cấu trúc thư mục + build pipeline + bảng patch.
- **`DEVELOPMENT.md`** — build from source, scripts, env vars, cách thêm patch mới.
- **`nativelibs/README.md`** — native addon reimplementation (db-cross-v4…).

## 2. Tech stack & toolchain

- **Package manager:** `npm` (có `package-lock.json` — KHÔNG dùng yarn/pnpm, tránh tạo lock thứ 2).
- **Module type:** CommonJS (`require`/`module.exports`) — không có `"type":"module"`. Đừng viết ESM `import`.
- **Runtime đóng gói:** Electron `^22.3.27`. **Lưu ý:** đây là Electron cũ → API Electron phải đúng version này, đừng giả định API mới.
- **Build scripts:** Node thuần trong `scripts/`, log qua `scripts/utils/logger.js`.
- **Native addons:** C++ build qua `node-gyp` (`nativelibs/builder.js`). Cần `build-essential`, `libssl-dev`, `liblzma-dev`, và `7z` (p7zip-full) cho giải nén DMG.
- **Không có test framework** — xem mục Verify (#6).

Lệnh chính (xem `package.json` scripts):

| Lệnh | Tác dụng |
|------|----------|
| `npm run main` | Full pipeline: setup (download + extract + patch) + build |
| `npm run main:setup` | Chỉ download + extract + patch → `app/`, `temp/` |
| `npm run main:build` | Chỉ đóng gói `app/` → AppImage |
| `npm start` | Chạy app dev (sau khi đã setup) |
| `npm run prepare-app` | Giải nén DMG + apply patches |

Env vars: `ZALO_VERSION`, `ZADARK_VERSION`, `FORCE_DOWNLOAD` (chi tiết trong DEVELOPMENT.md).

## 3. Bản đồ thư mục

```
zalo-for-linux/
├── main.js                  # Electron shell entry — tray, title bar, load app/, register plugins
├── package.json             # metadata + electron-builder config (target: AppImage)
├── scripts/
│   ├── main.js              # orchestrator (SETUP / BUILD theo env)
│   ├── check-versions.js    # so version local vs Zalo release mới nhất
│   ├── download-dmg.js      # tải DMG macOS về temp/
│   ├── prepare-zadark.js    # build assets ZaDark từ submodule
│   ├── prepare-app.js       # giải nén app.asar + chạy lần lượt các patch
│   ├── build.js             # đóng gói 2 bản: Original + ZaDark
│   ├── utils/logger.js      # log helper (step/info/success/warn/error/dim)
│   └── patches/             # mỗi file = 1 patch áp lên app/ đã giải nén
│       ├── patch-titlebar.js        # T,frame:!1 -> !0  (bật native title bar)
│       ├── patch-sqlite3.js         # thay node_sqlite3.node macOS bằng bản Linux
│       ├── patch-db-cross-v4.js     # build db-cross-v4 + patch binding.js + platform ID 25->24
│       └── patch-clipboard-paste.js # fix paste ảnh từ clipboard (X11/Wayland)
├── plugins/
│   ├── zadark/   # git submodule (quaric/zadark) — dark mode, tích hợp lúc build
│   ├── zalux/    # updater + cửa sổ version (trigger qua document.title='ZALUX_TRIGGER')
│   └── screenshot/ # intercept IPC 'screen-capture' → gọi tool screenshot native Linux
├── nativelibs/              # reimplement clean-room các .node addon macOS bằng C++
│   ├── builder.js           # CLI build addon (đọc Electron version từ root package.json)
│   └── db-cross-v4/         # giải mã backup / E2EE message sync
├── app/                     # ⚠️ GITIGNORED — regenerate mỗi lần build, KHÔNG sửa tay/commit
├── temp/                    # cache DMG đã tải
└── dist/                    # output AppImage
```

## 4. Quy tắc cốt lõi của dự án

### a. KHÔNG bao giờ sửa trực tiếp `app/`

`app/` là code Zalo độc quyền (VNG), được **regenerate mỗi lần build** và đã gitignore. Mọi thay đổi lên code Zalo phải đi qua **một patch trong `scripts/patches/`** — sửa tay trong `app/` sẽ mất ngay lần build sau.

### b. Patch phải idempotent + phòng thủ

Bundle Zalo đã minify và **đổi giữa các version**. Mọi patch phải:

- **Check trước khi replace:** nếu pattern đã được patch rồi → skip (log `dim`), không patch chồng.
- **Anchor rõ ràng:** tìm một chuỗi/regex đặc trưng (vd `'T,frame:!1'`, `getClipboardText:()=>r.clipboard.readText(),`, `case"LINUX":return 25;`).
- **Skip an toàn khi không thấy anchor:** `logger.warn(...)` báo "Zalo layout may have changed" rồi return — KHÔNG throw làm gãy cả pipeline.
- **Idempotent:** chạy lại nhiều lần ra cùng kết quả.

Xem `patch-clipboard-paste.js` và `patch-db-cross-v4.js` làm mẫu. Cách thêm patch mới: DEVELOPMENT.md mục "Adding a New Patch".

### c. Native addons: build từ source, KHÔNG commit binary

`nativelibs/` chứa reimplementation clean-room (C++) của addon macOS. `.node` binary được build lúc chạy pipeline và **không bao giờ commit** vào repo. Đổi addon → sửa `src/*.cc` + `binding.gyp`, không nhét binary prebuilt.

### d. Build ra 2 AppImage

`build.js` chạy 2 phase: **Original** (Zalo thuần) rồi **với ZaDark** (patch dark mode vào `app/` rồi build lại). Tên file gồm cả git commit hash (`build.js` gọi `git rev-parse --short HEAD` → cần repo git hợp lệ).

## 5. Code style

- Match style sẵn có: CommonJS, `const`/`let`, arrow functions, log qua `logger` (không `console.log` trực tiếp trong scripts).
- Patch/script mới: theo đúng layout file patch hiện có (`async function main()` + `module.exports = { main }` + block `if (require.main === module)`).
- **Surgical changes:** chỉ đụng cái cần đụng. Đừng "cải thiện" code Zalo trong patch ngoài phạm vi fix. Đừng bump version Electron / `engines` / đổi electron-builder config nếu không có lý do rõ.
- Comment trong patch nên ghi rõ **anchor là gì** và **vì sao** (vd ported from upstream commit nào) — như header trong `patch-clipboard-paste.js`.

## 6. Verify — không có unit test, verify bằng pipeline + chạy thật

Dự án **không có test runner**. "Code parse được" KHÔNG phải bằng chứng. Tùy loại thay đổi:

| Loại thay đổi | Cách verify |
|---------------|-------------|
| Sửa/thêm **patch** | `npm run prepare-app` → đọc log thấy patch applied (không phải "anchor not found"); grep file trong `app/main-dist/` xác nhận thay đổi đã vào; idempotent: chạy lại lần 2 thấy "already present, skipping" |
| Sửa **plugin** (`main.js`, `plugins/`) | `npm start` (sau setup) → mở app, kiểm tra hành vi thật (tray, title bar, screenshot, updater, paste ảnh) + DevTools `Ctrl+Shift+I` xem console |
| Sửa **native addon** | `node nativelibs/builder.js nativelibs/<addon>` build OK → `.node` xuất hiện trong `build/Release/` |
| Sửa **build/đóng gói** | `npm run main:build` chạy hết → AppImage xuất hiện trong `dist/`, kích thước hợp lý |
| Sửa **script logic** thuần | `node --check <file>` + chạy script đó với input thật |

Báo cáo phải nói rõ **đã verify bằng cách nào** (chạy lệnh gì, quan sát gì). Nếu chỉ đọc lại file (vd đổi text/README) → nói rõ là chưa chạy.

**Autonomy:** các thao tác read-only (`ls`/`grep`/Read/Glob, `git status`/`log`/`diff`) và `npm ci`/`npm install` (restore lock, không thêm package mới), `npm run prepare-app`, `npm start`, `node --check` trên local → **tự chạy, không hỏi**. Cần confirm trước khi: `npm install <package mới>`, sửa `package.json` core (engines/scripts/build config), git commit/push, hoặc thao tác mạng/remote.

## 7. Library reference — tra source thật, không đoán

Khi nghi vấn API Electron 22 / npm package / Node built-in:

1. Đọc `node_modules/<pkg>/` (`package.json` field `main`/`exports`, source trong `lib/`/`dist/`, `*.d.ts`).
2. Verify version đã resolved trong `package-lock.json`.
3. Đặc biệt với **Electron 22** (cũ): đừng giả định API mới có sẵn — check docs đúng version.

Không verify được → nói rõ là đang đoán, không khẳng định.

## 8. Think before coding

- State assumptions; nếu mơ hồ hoặc có nhiều cách hiểu → hỏi (tiếng Việt) trước khi code.
- Pattern Zalo có thể đã đổi giữa version → đừng giả định anchor còn tồn tại, luôn check.
- Có cách đơn giản hơn → nói ra. Đừng over-engineer (không factory/abstraction cho code dùng 1 chỗ).

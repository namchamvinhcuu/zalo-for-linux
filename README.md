# Zalo for Linux 🐧

An unofficial, community-driven port of the Zalo desktop application for **Linux only**, created by repackaging the official macOS client into a standard AppImage with integrated ZaDark.

Thanks **realdtn2** for the solution: [realdtn2/zalo-linux-2026](https://github.com/realdtn2/zalo-linux-2026).

## ⚠️ Known Limitations

- **Video calls are not supported yet.** Everything else works on Linux — messaging, E2EE message sync, 1:1 voice calls, dark mode (ZaDark), native screenshots, clipboard image paste, title bar, and tray/dock unread indicators.

## 🌙 ZaDark Integration

This project includes integrated [ZaDark](https://github.com/quaric/zadark), ZaDark is an extension that helps you enable Dark Mode, more privacy features, and additional functionality.

**ZaDark helps you experience Zalo 🔒 more privately ✨ more personalized.**

### Features

- 🌙 **Dark Mode optimized specifically for Zalo** - Complete dark theme tailored for Zalo interface
- 🆃 **Customize fonts and font sizes** - Personalize text appearance to your preference
- 🖼️ **Custom chat backgrounds** - Set personalized backgrounds for conversations
- 🔤 **Quick message translation** - Instantly translate messages to your preferred language
- 😊 **Express emotions with 80+ Emojis** - Enhanced emoji reactions for messages
- 🔒 **Anti-message peeking protection** - Prevent others from secretly viewing your messages
- 👁️ **Hide status indicators** - Hide "typing", "delivered" and "read" status from others
- 📱 **Native Integration** - Seamlessly integrated during build process

> **Note:** ZaDark is licensed under MPL-2.0 and is developed by [Quaric](https://zadark.com). The setup process automatically prepares ZaDark, and build process integrates it seamlessly!

## 🚀 Quick Start

> There are no prebuilt releases yet — you build the AppImage yourself. It's a
> single command once the prerequisites are installed.

### 1. Install prerequisites

- Linux x86_64
- Node.js and npm
- `7z` (`p7zip-full`) — extracts the macOS app during setup
- C++ build tools (for native addons): `build-essential`, `libssl-dev`, `liblzma-dev`

On Debian/Ubuntu:

```bash
sudo apt-get update && sudo apt-get install -y p7zip-full build-essential libssl-dev liblzma-dev
```

### 2. Build the AppImage

```bash
# Clone + init submodules (ZaDark)
git clone https://github.com/namchamvinhcuu/zalo-for-linux.git
cd zalo-for-linux
git submodule update --init --recursive

# Download the macOS DMG, extract, patch, and package into an AppImage
npm run main
```

The build produces a **self-contained** AppImage in `dist/` — no system Wine,
Node, or extra runtime is needed to run it, including for voice calls.

### 3. Run it

```bash
chmod +x dist/Zalo-*.AppImage
./dist/Zalo-*.AppImage
```

To add Zalo to your application menu, we recommend **Gear Lever**:

1.  Install **Gear Lever** from [Flathub](https://flathub.org/en/apps/it.mijorus.gearlever).
2.  Open **Gear Lever**, click **"Open"** (top-left) and select the AppImage from `dist/`.
3.  Click **"Unlock"**, then choose **"Move to the app menu"** to integrate it into your launcher.

> **Voice calls** are powered by a bundled Wine plus the Windows call engine that
> the build stages into the AppImage. See [ARCHITECTURE.md](./ARCHITECTURE.md) →
> "Voice calls (route B)" for how that bundle is sourced; a build without it still
> produces a fully working messaging client.

> For the full build pipeline, scripts, environment variables, and how to add
> patches, see [DEVELOPMENT.md](./DEVELOPMENT.md).

## ⚙️ How It Works

This project is not a from-scratch rewrite of Zalo. It works by:

1.  Downloading the official macOS `.dmg` file.
2.  Using `7z` to extract the `app.asar` archive, which contains the main application logic written in JavaScript.
3.  Removing incompatible native macOS files.
4.  Wrapping the extracted application in a minimal, Linux-compatible Electron shell.
5.  Using `electron-builder` to package everything into a single, portable `AppImage` file.

For a deeper dive into the build pipeline and patching strategy, see
[ARCHITECTURE.md](./ARCHITECTURE.md).

For native addons (db-cross-v4, etc.), see
[`nativelibs/README.md`](./nativelibs/README.md).

## 🐛 Troubleshooting & Debugging

If you encounter issues or want to inspect the app's behavior, open Chrome Developer Tools (DevTools) with the keyboard shortcut `Ctrl` + `Shift` + `I` while the Zalo window is focused.

## 📚 More Documentation

- [ARCHITECTURE.md](./ARCHITECTURE.md) — How the build pipeline and patches work
- [DEVELOPMENT.md](./DEVELOPMENT.md) — Building from source, scripts, adding patches
- [nativelibs/README.md](./nativelibs/README.md) — Native addons (db-cross-v4, etc.)

## 📄 License

This project is licensed under the MIT License. Zalo is a trademark of VNG Corporation. This project is not affiliated with or endorsed by VNG Corporation.

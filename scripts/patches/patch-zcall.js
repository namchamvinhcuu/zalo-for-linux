// scripts/patches/patch-zcall.js
//
// Un-gate the voice/video call buttons on Linux.
//
// The Zalo renderer hides the call buttons behind a chain of macOS-only
// capability gates. This patch neutralises those gates so the buttons render
// and the click reaches the call flow. It is anchor-based, idempotent and
// skip-safe per the project patch rules.
//
// NOTE (2026-06-03): an earlier revision of this patch also built an N-API
// "tracing scaffold" (nativelibs/zcall + trace.js) and wired a Linux branch
// into the app's binding.js, on the assumption that v26 drives the call engine
// through the `vcmac` / zcall_mac.node N-API surface. RE of the IPC handler
// disproved that: v26's engine is a *separate native executable* (`ZaloCall`,
// inside ZaloHelper.app) spawned by the main process and driven over two
// Unix-domain sockets — see .obsidian-vault Architecture/ZCall-Native-Engine-IPC.
// The vcmac path is legacy and never on the call path, so the tracing scaffold
// was wrong-layer and has been removed from this patch. nativelibs/zcall is
// kept in the repo only as a reference (servers/token sample in testConnect()).

const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const ROOT = path.join(__dirname, '..', '..');
const APP_DIR = path.join(ROOT, 'app');

// The renderer hides the voice/video call buttons behind a capability check
//   isSupport() === enable_mac_call && enableCall && ie
// where `ie = Number($znode.os.release().split('.')[0]) >= 17` — a macOS Darwin
// kernel-version gate (Darwin 17 = macOS 10.13). On Linux os.release() is the
// Linux kernel (e.g. "6.14.0-..."), so 6 < 17 → ie === false → calls are hidden
// regardless of the engine. Neutralise the version comparison so `ie` is true
// on Linux too (account-level enable_call / enable_mac_call still apply).
const UI_GATE_ANCHOR = 'Number(e.split(".")[0])<17';
const UI_GATE_PATCHED = 'Number(e.split(".")[0])<0/*zfl-zcall*/';

// Master call-capability gate in the renderer:
//   isSupport() === enable_mac_call && enableCall && ie
// enable_mac_call / enableCall are server feature flags (settings.chat.enable_call
// + features.enable_mac_call) and may be off for this account/build, so fixing
// `ie` alone isn't enough. Force isSupport() true on Linux — the header still
// won't show the button for self-chat / OA / non-friends (those are separate
// checks: g===sendToMeId, isOAType, u.isFr). Minified var names are tolerated.
const IS_SUPPORT_RE =
  /isSupport\(\)\{return!!\w+\.default\.enable_mac_call&&\(\w+\.default\.enableCall&&\w+\)\}/g;
const IS_SUPPORT_PATCHED = 'isSupport(){return!0/*zfl-zcall*/}';

// Voice-call header button (audio-only, Stage 0). Its render guard is
//   if(canShowVideoCall && !isGroup){ ...render voice button... }
// where canShowVideoCall (T) further requires isSupport() && u.isFr etc. Drop
// the canShowVideoCall term so the voice button shows for any 1:1 conversation,
// independent of the capability/friend gates above.
const VOICE_GUARD_ANCHOR = 'let a=null;if(t&&!n){';
const VOICE_GUARD_PATCHED = 'let a=null;if(!n){/*zfl-zcall*/';

// chatController.makeCall bails early unless canUseIpcCall() === enable_ipc_call
// && ne(true). If the server disabled enable_ipc_call, the click is a no-op
// ("makeCall: not supported", logged to file not console). Force it true.
const IPC_CALL_RE =
  /canUseIpcCall\(\)\{return \w+\.default\.enable_ipc_call&&\w+\}/g;
const IPC_CALL_PATCHED = 'canUseIpcCall(){return!0/*zfl-zcall*/}';

async function main() {
  logger.info('Un-gating call buttons on Linux...');
  patchCallUiGate();
}

function patchCallUiGate() {
  const pcDist = path.join(APP_DIR, 'pc-dist');
  if (!fs.existsSync(pcDist)) {
    logger.warn('pc-dist not found, skipping call-UI un-gate');
    return;
  }
  // The call-button code lives in different bundles per window: compact-app-pc.js
  // (compact window) and a lazy chunk under pc-dist/lazy/ (main window). Walk
  // pc-dist recursively so every copy gets patched.
  const jsFiles = walkJs(pcDist);
  let touched = 0;
  let anyAnchor = false;
  let alreadyDone = false;
  for (const p of jsFiles) {
    const f = path.relative(pcDist, p);
    let content = fs.readFileSync(p, 'utf8');
    let changed = false;

    // All edits below are applied together on a freshly-extracted bundle, so if
    // ANY marker is present this file is already done — skip to stay idempotent
    // (several patched forms still contain their own anchor and would re-apply).
    if (
      content.includes(UI_GATE_PATCHED) ||
      content.includes(IS_SUPPORT_PATCHED) ||
      content.includes(VOICE_GUARD_PATCHED) ||
      content.includes(IPC_CALL_PATCHED)
    ) {
      alreadyDone = true;
      continue;
    }
    // (a) macOS-version platform gate (ie).
    if (content.includes(UI_GATE_ANCHOR)) {
      anyAnchor = true;
      content = content.split(UI_GATE_ANCHOR).join(UI_GATE_PATCHED);
      changed = true;
    }
    // (b) master isSupport() capability gate.
    if (IS_SUPPORT_RE.test(content)) {
      anyAnchor = true;
      content = content.replace(IS_SUPPORT_RE, IS_SUPPORT_PATCHED);
      changed = true;
    }
    // (c) voice-call button render guard.
    if (content.includes(VOICE_GUARD_ANCHOR)) {
      anyAnchor = true;
      content = content.split(VOICE_GUARD_ANCHOR).join(VOICE_GUARD_PATCHED);
      changed = true;
    }
    // (d) canUseIpcCall gate.
    if (IPC_CALL_RE.test(content)) {
      anyAnchor = true;
      content = content.replace(IPC_CALL_RE, IPC_CALL_PATCHED);
      changed = true;
    }

    if (changed) {
      fs.writeFileSync(p, content, 'utf8');
      logger.dim(`Un-gated call support in pc-dist/${f}`);
      touched++;
    }
  }
  if (touched > 0) {
    logger.success('Call buttons un-gated on Linux');
    return;
  }
  if (alreadyDone) {
    logger.dim('Call-UI gates already patched, skipping');
  } else if (!anyAnchor) {
    logger.warn('Call-UI gate anchors not found — Zalo layout may have changed, skipping');
  }
}

// Recursively collect *.js paths under dir.
function walkJs(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walkJs(p));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(p);
  }
  return out;
}

if (require.main === module) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}

module.exports = { main };

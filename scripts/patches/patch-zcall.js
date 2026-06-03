// scripts/patches/patch-zcall.js
//
// Stage-0 wiring for the zcall Linux engine (see ZCALL-PHASE3-PLAN.md §Stage 0).
//
// Builds the `nativelibs/zcall` scaffold, drops the built .node + the tracing
// wrapper (trace.js) into the app, and adds a Linux branch to the app's
// binding.js that loads the *traced* scaffold. The branch is GATED behind the
// ZCALL_LINUX env var, so a normal AppImage build keeps the original behaviour
// (`{error: 'not support'}`) — set ZCALL_LINUX=1 only for a dev capture run:
//
//   ZCALL_LINUX=1 npm start
//
// then place a real outgoing call. The JS signaling runs for real and the
// tracing wrapper logs every engine input (servers list, callId, genSession,
// token, config) to ${TMPDIR}/zcall-trace.jsonl (override: ZCALL_TRACE_FILE).
//
// The stub never connects, so the call won't complete — Stage 0 only needs the
// captured inputs. Anchor-based + idempotent + skip-safe per project patch rules.

const { execSync } = require('child_process');
const fs = require('fs-extra');
const path = require('path');
const logger = require('../utils/logger');

const ROOT = path.join(__dirname, '..', '..');
const APP_DIR = path.join(ROOT, 'app');
const NATIVELIBS_DIR = path.join(ROOT, 'nativelibs');
const BUILDER_SCRIPT = path.join(NATIVELIBS_DIR, 'builder.js');
const ZCALL_DIR = path.join(NATIVELIBS_DIR, 'zcall');
const ZCALL_APP_DIR = path.join(APP_DIR, 'native', 'nativelibs', 'zcall');

// Exact original tail of getLib() in the app's binding.js — our anchor.
const ANCHOR = "else{\n        return {error: 'not support'};\n    }";
// The engine is loaded by a process whose env does NOT carry ZCALL_LINUX (likely
// a utility process with a scrubbed env), so the branch must be unconditional on
// linux — an env gate left getLib() returning {error:'not support'} → the call
// flow rejected with "not support". (Dev branch; production gating TBD.)
const LINUX_BRANCH =
  "else if(process.platform === 'linux'){\n" +
  "        return require('./zcall-trace.js')(require('./zcall-native.node'));\n" +
  "    }else{\n        return {error: 'not support'};\n    }";
// Upgrade an older env-gated branch from a previous patch revision.
const ENV_GATED = "process.platform === 'linux' && process.env.ZCALL_LINUX";

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
  logger.info('Wiring zcall Linux scaffold (Stage 0: traced stub engine)...');

  if (!fs.existsSync(path.join(ZCALL_DIR, 'binding.gyp'))) {
    logger.warn('nativelibs/zcall not found, skipping');
    return;
  }
  if (!fs.existsSync(ZCALL_APP_DIR)) {
    logger.warn('app zcall dir not found (Zalo layout may have changed), skipping');
    return;
  }

  // 1. Build the scaffold addon against the project's Electron N-API headers.
  try {
    execSync(`node "${BUILDER_SCRIPT}" "${ZCALL_DIR}"`, { cwd: ROOT, stdio: 'pipe' });
  } catch (error) {
    logger.error('Failed to build zcall scaffold', error.message);
    if (error.stdout) logger.dim(error.stdout.toString());
    throw new Error('Failed to build zcall scaffold');
  }

  // 2. Copy the built binary into the app.
  const built = path.join(ZCALL_DIR, 'build', 'Release', 'zcall-native.node');
  if (!fs.existsSync(built)) {
    throw new Error(`zcall build OK but binary missing: ${built}`);
  }
  fs.copyFileSync(built, path.join(ZCALL_APP_DIR, 'zcall-native.node'));

  // 3. Copy the tracing wrapper next to it.
  fs.copyFileSync(
    path.join(ZCALL_DIR, 'trace.js'),
    path.join(ZCALL_APP_DIR, 'zcall-trace.js')
  );

  // 4. Add the gated Linux branch to binding.js (idempotent).
  const bindingJsPath = path.join(ZCALL_APP_DIR, 'binding.js');
  let content = fs.readFileSync(bindingJsPath, 'utf8');

  if (content.includes(ENV_GATED)) {
    content = content.replace(ENV_GATED, "process.platform === 'linux'");
    fs.writeFileSync(bindingJsPath, content, 'utf8');
    logger.dim('Upgraded binding.js linux branch (removed ZCALL_LINUX env gate)');
  } else if (content.includes('zcall-trace.js')) {
    logger.dim('binding.js already wired for Linux zcall, skipping');
  } else if (!content.includes(ANCHOR)) {
    logger.warn('zcall binding.js anchor not found — Zalo layout may have changed, skipping wire');
    return;
  } else {
    content = content.replace(ANCHOR, LINUX_BRANCH);
    fs.writeFileSync(bindingJsPath, content, 'utf8');
    logger.dim('Patched binding.js (linux branch, unconditional)');
  }

  // 5. Un-gate the call buttons in the renderer (see UI_GATE_ANCHOR comment).
  //    The bundle filename carries a content hash, so scan pc-dist/*.js.
  patchCallUiGate();

  logger.success('zcall scaffold wired + call buttons un-gated on Linux');
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
  if (touched > 0) return;
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

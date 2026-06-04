// nativelibs/zcall/index.js
//
// Entry point for the built Linux zcall addon (package.json "main").
// Loads build/Release/zcall-native.node and re-exports its native surface
// (currently `{ MainApp }`), matching the contract of the app's binding.js
// (app/native/nativelibs/zcall/binding.js → `module.exports = getLib()`), so
// the same JS layer (vcmac.js) can consume this once it is wired in Phase 3.
//
// Until then this is a dev convenience: `require('zcall-linux')` after building.

'use strict';

const path = require('path');

const BINARY = path.join(__dirname, 'build', 'Release', 'zcall-native.node');

try {
  module.exports = require(BINARY);
} catch (err) {
  // Not built yet (or ABI mismatch) — surface a clear hint instead of a raw
  // "cannot find module", since the binary is gitignored and built on demand.
  throw new Error(
    `zcall-native.node not loadable (${err.message}). ` +
    'Build it first: node nativelibs/builder.js nativelibs/zcall'
  );
}

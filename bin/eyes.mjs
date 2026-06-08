#!/usr/bin/env node
// =============================================================================
// eyes — shim
//
// Loads the compiled CLI. We do an `await import()` so the shim itself can
// stay as `.mjs` and ESM. The compiled entry is the TypeScript build output
// at `dist/cli/index.js` (produced by the main `tsc -p tsconfig.json`).
// =============================================================================

await import("../dist/cli/index.js");

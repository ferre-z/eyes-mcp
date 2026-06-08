// =============================================================================
// Eyes-CLI — `eyes serve`
//
// Starts the existing MCP HTTP server. `src/index.ts` self-bootstraps on
// import (it calls app.listen() at module top level), so we just wrap the
// side-effect import in a named function so the CLI dispatch is explicit.
// =============================================================================

export function startServer(): void {
  // Importing the entry module boots the server and registers signal
  // handlers. This is a no-op after the first call.
  void import("../index.js");
}

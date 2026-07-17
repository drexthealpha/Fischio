// Entry point for hosts that run one file at the repo root. Wispbyte's "Startup File" field
// defaults to index.js, so this keeps that default working with no panel configuration.
//
// The real work is deploy/start-all.mjs, the supervisor that launches and restarts the
// always-on services (ingest, api, keeper, seed). It is ESM and this package is CommonJS, so
// it loads through a dynamic import, which is valid from CommonJS.
import("./deploy/start-all.mjs").catch((e) => {
  console.error("[fischio] failed to start the supervisor:", e);
  process.exit(1);
});

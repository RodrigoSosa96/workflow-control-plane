// Thin re-export for back-compat: the real implementation now lives in
// session-transport.js, generalized with a per-harness adapter (pi + claude).
export { createPiSessionTransport } from "./session-transport.js";

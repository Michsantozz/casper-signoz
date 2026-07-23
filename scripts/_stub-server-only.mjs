// Neutralize `import "server-only"` / `"client-only"` outside the Next bundler,
// so tsx recovery scripts can import server modules. tsx transpiles to CJS, so
// the barrier is loaded via require() → patch Module._load (CJS), not the ESM
// resolve hook.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const Module = require("node:module");

const orig = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "server-only" || request === "client-only") return {};
  return orig.call(this, request, parent, isMain);
};

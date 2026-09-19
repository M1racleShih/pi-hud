// Pi's loader accepts TypeScript entry points; the implementation is native ESM.
// No host-package imports, transpilation step, runtime dependencies, or startup I/O.
export { default } from "./src/extension.ts";

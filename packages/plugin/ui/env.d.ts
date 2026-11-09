/// <reference types="vite/client" />

// Injected at build time by Vite `define` (see vite.config.ts) — the product
// version, sourced from @figwright/mcp's package.json.
declare const __APP_VERSION__: string;
// Injected the same way: this build's stamp (epoch ms, as a string).
declare const __PLUGIN_BUILD_ID__: string;

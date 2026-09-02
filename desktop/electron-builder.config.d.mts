// Hand-written declaration for electron-builder.config.mjs.
//
// The config file is plain, untranspiled `.mjs` (electron-builder's Node API
// loads it directly — no esbuild/tsc step wanted in that path, same
// reasoning as `scripts/*.mjs` — see payload-manifest-guard.d.mts's own doc
// comment). `desktop/__tests__/product-name.test.ts` imports it directly to
// pin `appId`/`productName`, and `tsc --noEmit` would otherwise resolve that
// import to implicit `any` under `strict` — this file supplies just enough
// of the shape for that one test, not the full electron-builder
// `Configuration` type (which the config module itself already gets via its
// own `@type` JSDoc annotations).
//
// Kept in sync BY HAND — same tradeoff as every other hand-written `.d.mts`
// in this directory.

declare const config: {
  appId: string
  productName: string
  [key: string]: unknown
}

export default config

// Hand-written declaration for macho-scan.mjs.
//
// `scripts/*.mjs` is plain, un-typechecked JS (see
// payload-manifest-guard.d.mts's doc comment for why: no build step in the
// electron-builder invocation path). `desktop/__tests__/macho-scan.test.ts`
// (F6, whole-branch review) imports `findMachOFiles` directly to unit-test
// it, which would otherwise resolve to implicit `any` under `strict` — this
// file supplies the type, same tradeoff as payload-manifest-guard.d.mts:
// kept in sync BY HAND, no automation enforcing the two agree.

export function findMachOFiles(rootDir: string): Promise<string[]>

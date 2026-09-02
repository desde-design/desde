import { defineConfig } from "vitest/config"
import { fileURLToPath } from "node:url"

export default defineConfig({
  resolve: {
    alias: [
      { find: "@", replacement: fileURLToPath(new URL("../src", import.meta.url)) },
      // EXACT match only: `supertest/index.js` (which the wrapper itself
      // imports) must keep resolving to the real package. A plain string
      // alias prefix-matches and would alias the wrapper into itself.
      {
        find: /^supertest$/,
        replacement: fileURLToPath(
          new URL("./server/__tests__/supertest-reuse.ts", import.meta.url),
        ),
      },
    ],
  },
  test: {
    environment: "node",
    // Restore every `vi.stubGlobal`/`vi.spyOn`/`vi.fn` after each test so no
    // test can leak a stubbed global (fetch, location) or a mock into another.
    // Several suites stub `fetch`/`location` and clean up in their own
    // `afterEach`; making it systemic here closes the gap when a suite forgets,
    // which surfaced as a members-panel test that passed alone and in its own
    // directory but failed in the full run depending on worker/file ordering
    // (a machine-dependent flake — different CPU counts distribute files
    // differently). Safe: no viewer test stubs in `beforeAll`, so nothing
    // relies on a stub persisting across the tests in a file.
    unstubGlobals: true,
    restoreMocks: true,
    // Closes the servers `supertest-reuse` opens. See that file for why the
    // suite reuses one server per app instead of one per request.
    // `gallery-test-setup` is guarded on a DOM existing, so it is inert for
    // every node-environment suite here — see that file.
    setupFiles: ["./server/__tests__/close-servers.ts", "./gallery/gallery-test-setup.ts"],
    include: [
      "server/**/*.test.ts",
      "app/**/__tests__/*.test.ts",
      "app/**/*.test.ts",
      // A `.tsx` test under `app/` (colocated or in `__tests__/`) was not
      // being collected at all — only `gallery/**/*.test.tsx` matched `.tsx`
      // before this line existed. Added defensively: nothing under `app/`
      // is a `.test.tsx` file today, so this closes the gap before it bites
      // rather than after.
      "app/**/*.test.tsx",
      // The surface gallery's render sweep. It opts into jsdom with a
      // `@vitest-environment` docblock rather than this config switching
      // environment globally, which would put every server suite in a browser
      // it has no use for.
      "gallery/**/*.test.tsx",
    ],
    exclude: ["**/node_modules/**", "**/.next/**"],
    testTimeout: 20_000,
  },
})

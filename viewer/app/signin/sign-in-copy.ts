/**
 * Copy shared between `/signin` and Settings › Account.
 *
 * It lives in its own module rather than on `signin/page.tsx` because
 * `page.tsx` is a Next route module: its default export is the page
 * component, and importing a constant out of it drags `SignInPage` and its
 * whole import graph (`Card`, `Separator`, `Wordmark`, the email form and its
 * `fetchJson` client) into whatever chunk did the importing. A one-line
 * string is not worth a page.
 */

/**
 * What to say on a viewer with no sign-in provider at all.
 *
 * Both surfaces answer one question, "there is no way to sign in here, now
 * what?", and the true answer is a fact about how the process was started:
 * `server/auth/local-operator.ts` mints a one-time link and prints it at
 * boot. Two independently worded versions would be two chances to describe
 * that wrongly.
 *
 * It used to read "Check the terminal where it's running", which broke the
 * house rule against sending a reader to a surface they may not have (see
 * `docs/design.md`, "Never tell someone to run our own CLI"). Mo hit it in a
 * browser with the viewer running in a background shell he could not see, and
 * it was the only thing the page said. Restarting is now the stated action
 * because it is the one that always works: a fresh link is printed, and since
 * 2026-09-01 the boot also opens it in a browser by itself.
 *
 * What this must never do is show the token. It is printed out of band
 * precisely so that holding it proves you can reach the machine; a page
 * anyone can load is not that.
 */
export const LOCAL_OPERATOR_SENTENCE =
  "This viewer signs you in with a one-time link, printed once when it starts. Restart it to get a fresh link."

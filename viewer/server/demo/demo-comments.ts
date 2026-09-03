import type { StoredCommentInput, StoredCommentReplyInput } from "../storage/types"

/**
 * The conversation the demo prototype ships with.
 *
 * A review tool whose demo has nothing to review shows the reviewer an empty
 * list and asks them to imagine the product. These four threads exist so the
 * first screen a stranger sees is the thing the product is for (Mo,
 * 2026-09-01: "let's seed it with some comments and replies").
 *
 * ## Why the authors have `user:` uids
 *
 * This is the load-bearing detail, and it is not obvious from the outside.
 * `mayMutateCommentContent` (`../api/comments-routes.ts`) treats a comment as
 * owned only when `author.uid` starts with `user:`. For any other uid it
 * returns TRUE, meaning any caller who can write may rewrite the body or
 * delete it. The public demo allows anonymous comments and has no sign-in, so
 * "any caller" there means any visitor with the link.
 *
 * Seeded with anonymous-shaped uids, this conversation would be editable and
 * deletable by strangers, silently, with no audit trail. The `user:` prefix is
 * what makes it durable: only that user or a project insider may mutate it,
 * and on the public demo neither exists.
 *
 * These uids intentionally do NOT correspond to rows in the users table. The
 * check is on the prefix, and inventing three sign-in-capable accounts to own
 * a fixture would be a worse trade than a uid that no session can ever match.
 *
 * ## What they still cannot be protected from
 *
 * A `resolved`-only PATCH deliberately skips the authorship check, because
 * triaging someone else's comment is ordinary review work. So a visitor can
 * resolve these, and a resolved comment leaves the default list. A long-lived
 * public demo will drift toward empty and wants a periodic reseed. That is an
 * operations question, not something to engineer around here.
 *
 * ## Copy rules
 *
 * These are public-facing strings, not fixture filler: on the public demo they
 * are the first words most people read in this product. No "me" or "my", no em
 * dashes, obviously fictional names, and every comment says something a
 * designer would actually say about THIS prototype.
 */

interface SeedAuthor {
  uid: string
  displayName: string
  email: string
  photoURL: string
}

/**
 * `email` and `photoURL` are empty strings, which the validator accepts and
 * which are the honest values: these people do not exist, so there is no
 * address to notify, and the viewer's CSP forbids a remote avatar anyway. The
 * pin falls back to a coloured initial (`comment-pins.ts`).
 */
const PRIYA: SeedAuthor = { uid: "user:demo-priya", displayName: "Priya Raman", email: "", photoURL: "" }
const ANA: SeedAuthor = { uid: "user:demo-ana", displayName: "Ana Whitfield", email: "", photoURL: "" }
const TOMAS: SeedAuthor = { uid: "user:demo-tomas", displayName: "Tomas Iversen", email: "", photoURL: "" }

export interface DemoCommentSeed {
  comment: StoredCommentInput
  replies: StoredCommentReplyInput[]
  /** Seeded already-resolved, so the rail's Resolved toggle has something behind it. */
  resolved?: boolean
}

/**
 * Anchors are `data-demo-anchor` values, not classes.
 *
 * The demo's markup carries that attribute on exactly the elements seeded
 * here (`viewer/fixtures/demo-react/src/pages/*.tsx`). A class selector would
 * couple these pins to the demo's styling, so a restyle would detach them
 * silently: the comment survives, the pin never appears.
 *
 * `pagePrefix` is passed in rather than hard-coded because a comment's page
 * key is the iframe's raw `pathname + hash`, compared by strict equality
 * (`comment-pins.ts`). That pathname is `/p/demo/…` when the prototype is
 * served path-namespaced and `/…` when it has an origin of its own, so one
 * baked-in key would show pins in one origin mode and none in the other.
 */
export function demoComments(pagePrefix: string): DemoCommentSeed[] {
  const overview = pagePrefix
  const workspaces = `${pagePrefix}workspaces`
  const settings = `${pagePrefix}settings`

  return [
    {
      comment: {
        position: { anchorSelector: '[data-demo-anchor="metric-error-rate"]', page: overview },
        body: "Error rate is the only number here that got worse, and it is styled like the three that improved. Should a rising error rate read as a warning rather than as neutral text?",
        author: PRIYA,
      },
      replies: [
        {
          body: "Agreed. The red is doing the work, but the eye lands on the big number first and 0.42% reads as small.",
          author: ANA,
        },
        {
          body: "The threshold on Settings is 0.50%, so this is close to firing and nothing on this page says so.",
          author: PRIYA,
        },
      ],
    },
    {
      comment: {
        position: { anchorSelector: '[data-demo-anchor="workspace-northwind-eu"]', page: workspaces },
        body: "northwind-eu has been degraded for three days. Is there a way to see since when, without leaving this table?",
        author: ANA,
      },
      replies: [
        {
          body: "A Since column would push Requests off on narrow screens. A tooltip on the status pill might do it instead.",
          author: TOMAS,
        },
      ],
    },
    {
      comment: {
        position: { anchorSelector: '[data-demo-anchor="notify"]', page: settings },
        body: "Nobody is a real option in this list. If someone picks it, nothing later shows that alerts were turned off on purpose.",
        author: PRIYA,
      },
      replies: [],
    },
    {
      comment: {
        position: { anchorSelector: '[data-demo-anchor="retention"]', page: settings },
        body: "Good that this says it is not built yet. Worth saying when it is expected, or reviewers will keep filing it.",
        author: TOMAS,
      },
      replies: [],
      // The one resolved thread. It used to be a second Overview comment on the
      // attention panel; Mo wanted one comment on Overview (2026-09-02), and
      // the rail's Resolved toggle still needs something behind it.
      resolved: true,
    },
  ]
}

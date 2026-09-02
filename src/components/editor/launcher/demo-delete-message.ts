/**
 * What the demo's delete confirmation says.
 *
 * Its own module, and pure, because it has four branches and the failure mode
 * is a dialog that reads "1 files". A confirmation is the last thing a reader
 * sees before losing work, so the singular/plural is not a polish detail.
 *
 * The demo starts byte-identical to the bundle, so deleting an untouched one
 * costs nothing and the copy should say so plainly rather than warn. The moment
 * someone edits it, it becomes their work and the copy names what goes.
 */
import type { DemoChangeSummary } from "@/types/launcher"

function countPhrase(n: number, singular: string): string {
  return `${n} ${n === 1 ? singular : `${singular}s`}`
}

export function demoDeleteMessage(changes: DemoChangeSummary): string {
  const parts: string[] = []
  if (changes.dirtyFiles > 0) parts.push(countPhrase(changes.dirtyFiles, "uncommitted file"))
  if (changes.extraCommits > 0) parts.push(countPhrase(changes.extraCommits, "commit"))
  if (parts.length === 0) return "Delete the demo? It can be added again at any time."
  return `Delete the demo? ${parts.join(" and ")} will be lost. Adding it again starts from the original.`
}

/**
 * The ES-module text of a file, for the import scanner in
 * `import-binding.ts`: a `.vue` file's `<script setup>` (or `<script>`)
 * block, and any other file unchanged. Kept out of `import-binding.ts` so
 * that module stays free of the Vue compiler.
 */

import { parse as parseSfc } from '@vue/compiler-sfc'

export function moduleSourceOfFile(path: string, source: string): string {
  if (!path.toLowerCase().endsWith('.vue')) return source
  try {
    const { descriptor } = parseSfc(source)
    const block = descriptor.scriptSetup ?? descriptor.script
    return block?.content ?? ''
  } catch {
    return ''
  }
}

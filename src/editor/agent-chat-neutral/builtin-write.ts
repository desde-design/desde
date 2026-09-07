/**
 * `Write`, at the path its name says.
 *
 * The implementation lives in `builtin-edit.ts` because Write and Edit share
 * every helper: one reconstruction, one `brokeredWrite` call, one refusal
 * vocabulary. Splitting them into two files would mean two copies of that, or
 * a third file nobody would think to look in. This module is the import path
 * `builtin-tools.ts` actually uses for Write, so the file layout is a real
 * seam rather than a stub kept alive for its filename.
 */
export { buildWriteToolSpec, type BuiltinWriteOpts } from './builtin-edit'

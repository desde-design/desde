// Edge case: file in story-globs but without a default-export object.
// Must be skipped, not crashed on.
export const helper = () => 42

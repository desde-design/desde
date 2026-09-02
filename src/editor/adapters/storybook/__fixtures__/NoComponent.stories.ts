// Edge case: a story file without a `component` field. The source must
// still emit a manifest, deriving the name from `meta.title` and leaving
// `importPath` undefined.

import type { Meta } from '@storybook/vue3'

const meta: Meta = {
  title: 'Misc/Untitled',
  argTypes: {
    flag: { control: 'boolean' },
  },
}

export default meta

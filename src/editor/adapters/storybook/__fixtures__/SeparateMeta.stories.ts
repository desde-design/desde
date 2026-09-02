import type { Meta, StoryObj } from '@storybook/vue3'
import { Card } from '@acme/design-system'

const meta = {
  title: 'Card',
  component: Card,
  argTypes: {
    title: { control: 'text' },
    elevated: { control: 'boolean' },
    variant: {
      options: ['plain', 'outlined', 'shadowed'],
    },
  },
  args: {
    title: 'Hello',
    elevated: false,
    variant: 'plain',
  },
} satisfies Meta<typeof Card>

export default meta

type Story = StoryObj<typeof meta>
export const Default: Story = {}

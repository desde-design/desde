import type { Meta, StoryObj } from '@storybook/vue3'
import Button from './Button.vue'

const meta: Meta<typeof Button> = {
  title: 'Components/Button',
  component: Button,
  argTypes: {
    label: {
      control: 'text',
      description: 'The visible button text.',
    },
    appearance: {
      control: { type: 'select' },
      options: ['primary', 'secondary', 'tertiary', 'danger'],
      description: 'Visual style.',
    },
    size: {
      control: { type: 'radio', options: ['sm', 'md', 'lg'] },
      description: 'Button size.',
    },
    disabled: {
      control: 'boolean',
    },
    count: {
      control: 'number',
      description: 'Numeric prop for testing.',
    },
    advanced: {
      control: { type: 'object' },
      description: 'Object-typed config.',
    },
  },
  args: {
    label: 'Click me',
    appearance: 'primary',
    size: 'md',
    disabled: false,
  },
  parameters: {
    docs: {
      description: {
        component: 'A basic button used across the design system.',
      },
    },
  },
}

export default meta

type Story = StoryObj<typeof meta>

export const Primary: Story = {}

export const Disabled: Story = {
  args: { disabled: true },
}

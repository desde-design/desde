/**
 * A small, design-system-neutral `RawComponentMeta` in the exact shape
 * `vue-component-meta` emits, for tests that need a REAL manifest produced
 * by the real normalizer rather than a hand-written `ComponentManifest`.
 *
 * It deliberately covers the three control kinds a UI test cares about:
 * a finite-choice enum (`appearance`), a boolean (`disabled`), and a plain
 * string (`label`) — so a regression in the control classifier (e.g. a
 * finite-choice prop rendering as a text input) is visible downstream.
 *
 * Previously these tests ran against the bundled Acme DS sample JSON.
 * That coupled generic UI/pipeline coverage to one vendor's data; this
 * fixture is the vendor-neutral replacement.
 */
import type { RawComponentMeta } from '../raw-manifest'

export const UI_BUTTON_RAW: RawComponentMeta = {
  name: 'UiButton',
  description: 'A button.',
  type: 1,
  props: [
    {
      name: 'appearance',
      description: 'Visual style of the button.',
      type: 'Appearance | undefined',
      default: '"primary"',
      global: false,
      required: false,
      tags: [],
      schema: {
        kind: 'enum',
        type: 'Appearance | undefined',
        schema: ['undefined', '"primary"', '"secondary"', '"tertiary"', '"danger"'],
      },
      declarations: [],
    },
    {
      name: 'size',
      description: 'Size of the button.',
      type: 'Size | undefined',
      default: '"medium"',
      global: false,
      required: false,
      tags: [],
      schema: {
        kind: 'enum',
        type: 'Size | undefined',
        schema: ['undefined', '"small"', '"medium"', '"large"'],
      },
      declarations: [],
    },
    {
      name: 'disabled',
      description: 'Whether the button is disabled.',
      type: 'boolean | undefined',
      default: 'false',
      global: false,
      required: false,
      tags: [],
      schema: {
        kind: 'enum',
        type: 'boolean | undefined',
        schema: ['undefined', 'false', 'true'],
      },
      declarations: [],
    },
    {
      name: 'label',
      description: 'Text rendered inside the button.',
      type: 'string | undefined',
      global: false,
      required: false,
      tags: [],
      schema: 'string | undefined',
      declarations: [],
    },
  ],
  events: [],
  slots: [
    {
      name: 'default',
      description: 'Button content.',
      type: '{}',
      tags: [],
      schema: { kind: 'object', type: '{}', schema: {} },
      declarations: [],
    },
  ],
  exposed: [],
}

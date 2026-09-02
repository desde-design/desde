/**
 * Composed design-system building blocks — the layer between the shadcn
 * primitives (`src/components/ui/`) and feature components. Each block is
 * the canonical recipe for a recurring composed pattern; reach for one of
 * these before assembling primitives + utility classes by hand.
 *
 * See docs/design.md for the inventory, usage examples and the rules for
 * promoting a new pattern to a block.
 */
export { AnimatedEllipsis } from "./ellipsis"
export { ChoiceTile, type ChoiceTileProps } from "./choice-tile"
export {
  OptionCard,
  OptionCardGroup,
  CheckOptionCard,
  type OptionCardProps,
  type OptionCardGroupProps,
  type CheckOptionCardProps,
} from "./option-card"
export { ListRow, listRowVariants, type ListRowProps } from "./list-row"
export {
  ListFrame,
  ListFrameSearch,
  type ListFrameProps,
  type ListFrameSearchProps,
} from "./list-frame"
export { Eyebrow, eyebrowVariants, type EyebrowProps } from "./eyebrow"
export {
  StatusDot,
  StatusPill,
  statusDotVariants,
  type StatusDotProps,
  type StatusPillProps,
  type StatusTone,
} from "./status-dot"
export { Callout, calloutVariants, type CalloutProps } from "./callout"
export { CommandChip, type CommandChipProps } from "./command-chip"
export { CopyButton, type CopyButtonProps } from "./copy-button"
export { BusyOverlay, type BusyOverlayProps } from "./busy-overlay"
export { Stepper, type StepperProps, type StepperStep } from "./stepper"
export { CatAtPortal } from "./cat-at-portal"
export { CatVacuumFailure } from "./cat-vacuum-failure"
export { EmptyState, type EmptyStateProps } from "./empty-state"
export { Field, type FieldProps } from "./field"
export { ValueReadout, type ValueReadoutProps } from "./value-readout"
export { BeforeAfter, type BeforeAfterProps } from "./before-after"
export { Wordmark } from "./wordmark"
export { ROW_TINTS, rowTint, useProjectGrid } from "./project-grid"
export { ProjectLoader, type ProjectLoaderProps } from "./project-loader"
export { AppHeader, type AppHeaderProps } from "./app-header"
export { FieldGroup } from "./field-group"
export { SettingsSection, type SettingsSectionProps } from "./settings-section"
export { HOVER_REVEAL } from "./hover-reveal"

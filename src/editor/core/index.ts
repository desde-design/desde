export type {
  ComponentEventManifest,
  ComponentManifest,
  ComponentManifestExtensions,
  ComponentManifestSource,
  ComponentPropManifest,
  ComponentSlotManifest,
  ControlKind,
  ControlOption,
  DataContractManifest,
  DefaultValueSource,
  DesignSystemId,
  FrameworkId,
  ManifestControl,
  ManifestDefaultValue,
  ManifestSource,
  ManifestValue,
  RenderingHint,
  RenderingHintProvenance,
  SourceDeclaration,
  StatePreviewManifest,
  VariantGroupManifest,
} from './manifest'

export type {
  DesignToken,
  DesignTokenSource,
  TokenCategory,
} from './design-tokens'

export type { GroundingService } from './grounding'

export type { CanonicalSelectorElement } from './canonical-selector'
export { canonicalSelectorOf, sortedClasses } from './canonical-selector'

export type {
  GroundingHealth,
  GroundingRuntimeError,
  HealthCollector,
  SourceHealthEntry,
} from './grounding-health'

export { createHealthCollector } from './grounding-health'

export type { SubstrateStyleCapabilities } from './substrate-style-capabilities'
export { NO_SUBSTRATE_STYLE_CAPABILITIES } from './substrate-style-capabilities'

export type { DriftEntry, DriftKind, DriftLog, DriftSignal } from './drift'
export { createDriftLog, driftKey, DRIFT_KINDS, REPAIRABLE_DRIFT_KINDS } from './drift'

export type {
  ReviewCaptureInput,
  ReviewCaptureResult,
  ReviewCaptureScope,
  ReviewInteractAction,
  ReviewInteractInput,
  ReviewInteractResult,
  ReviewPageInfo,
  ReviewResolveResult,
  ReviewSurface,
  ReviewTarget,
} from './review-surface'

export type {
  PlanValidationResult,
  ScreenshotCapture,
  ScreenshotCaptureScope,
  ScreenshotPlan,
  ScreenshotPlanAction,
  ScreenshotPlanSource,
  ScreenshotPlanStep,
  ScreenshotPlanStepKind,
  SemanticTarget,
} from './screenshot-plan'

export { validateScreenshotPlan } from './screenshot-plan'

export type {
  RouteEnumerationPlanInput,
  UnsavedScreenshotPlan,
} from './screenshot-plan-build'

export { buildRouteEnumerationPlan } from './screenshot-plan-build'

export type {
  EnumeratedRoute,
  EnumerateRoutesResult,
  RouteEnumerator,
  SkippedRoute,
} from './route-scaffold'

export type {
  AdapterTarget,
  IframePoint,
  IterationContext,
  Selection,
  SelectionAncestor,
  SelectionTarget,
  SourceLocation,
} from './selection'

export type {
  DataBinding,
  IntentRecord,
  OffSystemMarker,
} from './intent'

export type {
  AgentRequest,
  ComponentRef,
  CopyEdit,
  DataBindingEdit,
  DeleteEdit,
  DetachEdit,
  DisambiguationChoice,
  DuplicateEdit,
  FlattenConditionalEdit,
  InsertEdit,
  InsertionTarget,
  IntentEdit,
  IterationScopeChoice,
  JsxStyleEdit,
  LLMPatchEdit,
  MoveEdit,
  Mutation,
  MutationContext,
  MutationResolutionKind,
  MutationScope,
  OffSystemOverrideEdit,
  OverwriteEdit,
  PasteEdit,
  PendingMutation,
  PropEdit,
  StructuralEdit,
  StructuralEditBase,
  TokenEdit,
  UnwrapEdit,
  VariantEdit,
  WrapEdit,
} from './edit'

export { deleteScopeAvailability } from './edit'

export type {
  AdapterSubscription,
  ApplyEditOpts,
  DragMoveRequest,
  EditResult,
  InsertAtPointRequest,
  OverridePreviewFailure,
  ResizeRequest,
  FrameworkAdapter,
  SaveLLMTrace,
  SourceLoc,
} from './framework-adapter'

export type {
  IconManifest,
  IconPreview,
  IconRef,
  IconSearchHit,
  IconSetRegistry,
  IconSetSource,
  IconUsagePattern,
} from './icon-set'

export type {
  CanvasAnnotationCreateInput,
  CanvasAnnotationUpdatePatch,
  CanvasCreateInput,
  CanvasEdgeCreateInput,
  CanvasEdgeUpdatePatch,
  CanvasFrameCreateInput,
  CanvasFrameUpdatePatch,
  CanvasStore,
  CanvasUpdatePatch,
  CommentCreateInput,
  CommentReplyInput,
  CommentStore,
  CommentSubscriber,
  CommentUpdatePatch,
  ScreenshotPlanStore,
  ScreenshotPlanCreateInput,
  ScreenshotPlanUpdatePatch,
  NoteCreateInput,
  NoteReplyInput,
  NoteStore,
  NoteUpdatePatch,
} from './stores'

export { createInMemoryCommentStore } from './stores'

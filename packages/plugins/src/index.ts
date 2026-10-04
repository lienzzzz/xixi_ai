/**
 * `@xixi/plugins` — pack `03_AGENT_PLUGIN.md` §1–§3: the plugin kernel that sits **on top of** the
 * existing `ToolRegistry` rather than replacing it.
 *
 * What lives here:
 *
 *  * `PluginManager` — the nine-step lifecycle (`discover → validate → permission → load →
 *    activate(ctx) → register capabilities → health → deactivate → dispose`), with a journal that
 *    makes the order observable.
 *  * `CapabilityRegistry` — the five V0.3 capability kinds (`tool`, `topic_source`,
 *    `context_provider`, `sensor_source`, `action`), every registration returning a Disposable.
 *  * manifest validation (`validateManifest`, `PLUGIN_MANIFEST_SCHEMA_V1`) and the permission
 *    vocabulary.
 *  * the four 铁律 boundaries as enforcement points: no main SQLite handle, no core-prompt edit,
 *    no raw camera/mic, and no way around `ToolPermission`.
 *
 * Dependency direction is one-way: `plugins → brain-adapter` (tool types and the registry) and
 * `plugins → conversation` (the core prompt text, imported so this package does not keep a second
 * copy of it). Nothing in those packages imports this one, so there is no cycle.
 */
export { DisposableBundle, isDisposable, onceDisposable, toRegistration, type Disposable, type Registration } from './disposal.ts';
export {
  PluginBoundaryError,
  PluginError,
  PluginLifecycleError,
  PluginManifestError,
  PluginPermissionError,
  PLUGIN_BOUNDARIES,
  type PluginBoundary,
  type PluginErrorCode,
} from './errors.ts';
export {
  CAPABILITY_PERMISSIONS,
  FORBIDDEN_PERMISSIONS,
  parseManifest,
  PLUGIN_CAPABILITIES,
  PLUGIN_MANIFEST_SCHEMA_V1,
  PLUGIN_MANIFEST_SCHEMA_VERSIONS,
  PLUGIN_PERMISSIONS,
  grantedPermissions,
  validateManifest,
  type PluginCapability,
  type PluginManifest,
  type PluginManifestHealth,
  type PluginPermission,
} from './manifest.ts';
export {
  CapabilityRegistry,
  RESERVED_CAPABILITY_NAMES,
  RESERVED_TOOL_PREFIXES,
  type ActionHandler,
  type CapabilityRegistration,
  type CapabilityRegistryOptions,
  type ContextLine,
  type ContextProvider,
  type PluginContribution,
  type PluginToolSpec,
  type SensorEvent,
  type SensorSource,
  type TopicCandidate,
  type TopicSource,
} from './capability-registry.ts';
export {
  CORE_PROMPT_AUTHORITY,
  CORE_PROMPT_BLOCKS,
  CORE_PROMPT_MARKERS,
  CORE_PROMPT_SECTION_NAMES,
  createCorePromptAuthority,
  verifyOnAssemble,
  type CorePromptAuthority,
  type CorePromptSectionName,
  type PromptAssemblerLike,
  type PromptSection,
  type VerifiablePrompt,
  type VerifyOnAssembleOptions,
} from './prompt-authority.ts';
export {
  assertNoPrivilegedSurface,
  buildPluginContext,
  createPluginToolView,
  createRestrictedStore,
  FORBIDDEN_CONTEXT_KEYS,
  PRIVILEGED_SURFACE_MARKERS,
  type BuiltPluginContext,
  type NetworkGrant,
  type NotifyGrant,
  type PluginAuditEvent,
  type PluginAuditRecord,
  type PluginContext,
  type PluginContextOptions,
  type PluginHost,
  type PluginLog,
  type PluginPermissionKey,
  type PluginStorage,
  type PluginToolView,
  type PluginToolViewOptions,
  type StorageGrant,
} from './context.ts';
export {
  asModuleShape,
  FilePluginSource,
  findManifestsIn,
  importModule,
  InlinePluginSource,
  loadPluginModule,
  PLUGIN_MANIFEST_FILENAME,
  type DiscoveredPlugin,
  type InlinePlugin,
  type LoadedModule,
  type PluginActivation,
  type PluginContextLike,
  type PluginContributionLike,
  type PluginHealthHook,
  type PluginHealthLike,
  type PluginHook,
  type PluginModule,
  type PluginModuleLoader,
  type PluginModuleShape,
  type PluginSource,
} from './discovery.ts';
export {
  createPluginRuntime,
  inlinePluginSource,
  mountPluginTools,
  pluginTool,
  PluginManager,
  PLUGIN_LIFECYCLE_STEPS,
  PLUGIN_PERMISSION_KEYS,
  type CreatePluginRuntimeOptions,
  type PluginHealthReport,
  type PluginHealthStatus,
  type PluginInstance,
  type PluginLifecycleRecord,
  type PluginLifecycleStep,
  type PluginManagerOptions,
  type PluginRuntime,
  type PluginState,
} from './manager.ts';

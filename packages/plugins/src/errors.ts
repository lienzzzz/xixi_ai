/**
 * Typed refusals for the plugin layer (pack `03_AGENT_PLUGIN.md` §2/§3).
 *
 * Every rejection in this package is one of these, and every one carries a stable `code` so a
 * caller (or a test) can assert *which* boundary said no instead of matching prose.
 */

/** The four things a plugin is never allowed to do (§3). Stable ids: tests assert on these. */
export const PLUGIN_BOUNDARIES = ['sqlite-handle', 'core-system-prompt', 'raw-camera-mic', 'tool-permission'] as const;

export type PluginBoundary = (typeof PLUGIN_BOUNDARIES)[number];

export type PluginErrorCode =
  | 'PLUGIN_MANIFEST_INVALID'
  | 'PLUGIN_PERMISSION_DENIED'
  | 'PLUGIN_LOAD_FAILED'
  | 'PLUGIN_DUPLICATE_ID'
  | 'PLUGIN_CAPABILITY_CONFLICT'
  | 'PLUGIN_RESERVED_NAME'
  | 'PLUGIN_BOUNDARY_VIOLATION'
  | 'PLUGIN_LIFECYCLE_ERROR';

/** Base class so `catch` can tell plugin refusals apart from ordinary bugs. */
export class PluginError extends Error {
  readonly code: PluginErrorCode;

  constructor(code: PluginErrorCode, message: string, options: { readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'PluginError';
    this.code = code;
  }
}

/** Manifest shape/field refusal (§2). */
export class PluginManifestError extends PluginError {
  constructor(message: string) {
    super('PLUGIN_MANIFEST_INVALID', message);
    this.name = 'PluginManifestError';
  }
}

/** A permission the plugin did not declare (or one that may never be granted, §3). */
export class PluginPermissionError extends PluginError {
  readonly permission: string;

  constructor(permission: string, message: string) {
    super('PLUGIN_PERMISSION_DENIED', message);
    this.name = 'PluginPermissionError';
    this.permission = permission;
  }
}

/** One of the four 铁律 boundaries was crossed. `boundary` is what a test asserts on. */
export class PluginBoundaryError extends PluginError {
  readonly boundary: PluginBoundary;
  readonly pluginId: string;

  constructor(boundary: PluginBoundary, pluginId: string, message: string) {
    super('PLUGIN_BOUNDARY_VIOLATION', message);
    this.name = 'PluginBoundaryError';
    this.boundary = boundary;
    this.pluginId = pluginId;
  }
}

/** A lifecycle step refused: the plugin is left in a recorded, non-active state. */
export class PluginLifecycleError extends PluginError {
  readonly step: string;

  constructor(step: string, message: string, options: { readonly cause?: unknown } = {}) {
    super('PLUGIN_LIFECYCLE_ERROR', message, options);
    this.name = 'PluginLifecycleError';
    this.step = step;
  }
}

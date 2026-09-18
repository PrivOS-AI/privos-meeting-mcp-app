/**
 * Single source of truth for what this app tells the Hub about itself. The
 * reviewed `privos-app.json` is the authority; the marketplace-projected
 * manifest, the Relay `AppDescriptor` and the UI resource URI are all derived
 * from it here.
 */
import type { AppDescriptor, AppPermissionDescriptor } from '@privos_ai/app-server';

import { getAppIconDataUri } from './app-icon.js';
import publisherManifest from '../../privos-app.json';

/** The exact field set the marketplace/Hub manifest contract recognizes. */
export const MARKETPLACE_MANIFEST_FIELDS = [
  'schemaVersion', 'kind', 'name', 'version', 'title', 'description', 'icon',
  'author', 'homepage', 'repository', 'permissions', 'dataPolicy', 'availabilityTier',
  'capabilities', 'agentBot', 'tools', 'port', 'resources', 'volumes', 'stateless', 'license', 'env',
  'resourceManifestTemplate',
] as const;

export type AppManifest = Pick<typeof publisherManifest, Extract<(typeof MARKETPLACE_MANIFEST_FIELDS)[number], keyof typeof publisherManifest>>;

/**
 * Placeholder token in the manifest CSP (`_meta.ui.csp.connect-src`/`media-src`)
 * that must be replaced with the Hub's real presigned-Files origin before the
 * iframe can fetch transcript/audio. Kept literal in `privos-app.json` (source +
 * lint) and resolved from `PRIVOS_FILES_ORIGIN` at build/boot by
 * {@link createManifest}, so switching Hub is an env change, not a manifest edit.
 */
export const FILES_ORIGIN_PLACEHOLDER = '<PRIVOS_FILES_ORIGIN>';

/**
 * Substitute {@link FILES_ORIGIN_PLACEHOLDER} with `PRIVOS_FILES_ORIGIN` when set
 * (trailing slash trimmed). Regex-free string replace so an origin with special
 * characters is safe. Leaves the placeholder untouched when the env is unset
 * (dev / `manifest:lint`), which never reaches a real iframe.
 */
export function resolveFilesOrigin<T>(value: T): T {
  const origin = (process.env.PRIVOS_FILES_ORIGIN ?? '').trim().replace(/\/+$/, '');
  if (!origin) return value;
  return JSON.parse(JSON.stringify(value).split(FILES_ORIGIN_PLACEHOLDER).join(origin)) as T;
}

/** The reviewed manifest projected onto the fields the Hub/marketplace recognizes. */
export function createManifest(): AppManifest {
  const projected = Object.fromEntries(
    MARKETPLACE_MANIFEST_FIELDS.map((field) => [field, (publisherManifest as Record<string, unknown>)[field]]),
  ) as AppManifest;
  return resolveFilesOrigin(projected);
}

/** The full reviewed manifest, for code that needs fields outside the projection. */
export const manifest = publisherManifest;

export const APP_ID = publisherManifest.name;

/**
 * URI of the single UI surface this app exposes. Declared under the tool's
 * `_meta.ui` (developer-guide.md:44-50) — permissions/csp live in the same
 * object, so `resourceUri` is read from there too.
 */
export const UI_RESOURCE_URI =
  publisherManifest.tools.find(
    (tool): tool is (typeof publisherManifest.tools)[number] & { _meta: { ui: { resourceUri: string } } } =>
      typeof (tool as { _meta?: { ui?: { resourceUri?: unknown } } })._meta?.ui?.resourceUri === 'string',
  )?._meta.ui.resourceUri ?? 'ui://meeting-agent/app.html';

/**
 * The `AppDescriptor` the SDK's Relay transport needs — built straight from the
 * reviewed manifest so a relay-paired install advertises exactly what the
 * Marketplace listing declares.
 */
export function buildRelayAppDescriptor(): AppDescriptor {
  return {
    id: publisherManifest.name,
    name: publisherManifest.name,
    version: publisherManifest.version,
    title: publisherManifest.title,
    description: publisherManifest.description,
    homepage: publisherManifest.homepage,
    author: publisherManifest.author,
    permissions: publisherManifest.permissions as readonly AppPermissionDescriptor[],
    manifestIcon: publisherManifest.icon,
    relayIcon: getAppIconDataUri(),
  };
}

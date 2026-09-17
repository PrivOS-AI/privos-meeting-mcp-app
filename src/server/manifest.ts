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

/** The reviewed manifest projected onto the fields the Hub/marketplace recognizes. */
export function createManifest(): AppManifest {
  return Object.fromEntries(
    MARKETPLACE_MANIFEST_FIELDS.map((field) => [field, (publisherManifest as Record<string, unknown>)[field]]),
  ) as AppManifest;
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

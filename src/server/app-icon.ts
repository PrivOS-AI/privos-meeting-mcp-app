/**
 * Icon-as-data-URI resolution for every entry point that hands this app's icon
 * to the Hub (pairing metadata, MCP `initialize`). Reads the icon path declared
 * in the reviewed manifest so every surface advertises the same icon.
 */
import fs from 'node:fs';
import path from 'node:path';

import { repoRoot } from './paths.js';
import publisherManifest from '../../privos-app.json';

let cached: string | undefined | null = null;

/** Read the manifest's icon file as a data URI, or `undefined` when absent. */
export function getAppIconDataUri(): string | undefined {
  if (cached !== null) return cached ?? undefined;
  const icon = (publisherManifest as { icon?: string }).icon;
  const iconPath = icon?.startsWith('/') ? path.join(repoRoot, icon) : undefined;
  if (!iconPath || !fs.existsSync(iconPath)) {
    cached = undefined;
    return undefined;
  }
  const ext = path.extname(iconPath).slice(1);
  const mime = ext === 'svg' ? 'image/svg+xml' : `image/${ext}`;
  const data = fs.readFileSync(iconPath).toString('base64');
  cached = `data:${mime};base64,${data}`;
  return cached;
}

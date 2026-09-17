/**
 * Validate privos-app.json against the SDK's manifest rules. Runs as part of
 * `npm run build` because a malformed manifest is otherwise only discovered at
 * install time.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { SUPPORTED_MANIFEST_SCHEMA_VERSIONS, lintManifest } from '@privos_ai/app-server';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(repoRoot, 'privos-app.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

if (!SUPPORTED_MANIFEST_SCHEMA_VERSIONS.includes(manifest.schemaVersion)) {
  console.error(
    `privos-app.json declares schemaVersion ${manifest.schemaVersion}; `
      + `this SDK supports ${SUPPORTED_MANIFEST_SCHEMA_VERSIONS.join(', ')}.`,
  );
  process.exit(1);
}

const result = lintManifest(manifest);
if (!result.valid) {
  console.error('privos-app.json is invalid:');
  for (const error of result.errors) console.error(`  - ${error}`);
  process.exit(1);
}

console.log(`privos-app.json is valid (schemaVersion ${manifest.schemaVersion}).`);
console.log(`  canonical manifest hash: ${result.canonicalManifestHash}`);
console.log(`  permission declaration hash: ${result.publisherPermissionDeclarationHash}`);

/**
 * PrivOS marketplace preflight — mirrors the Portal's publish-time validation
 * locally, so a manifest/package identity mismatch or a `serveApp` boot
 * regression is caught before submission. Run via `npm run preflight`.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { serveApp } from '@privos_ai/app-server';
import { lintManifest, SUPPORTED_MANIFEST_SCHEMA_VERSIONS } from '@privos_ai/app-server/manifest-tools';

import { createManifest, buildRelayAppDescriptor, MARKETPLACE_MANIFEST_FIELDS } from '../src/server/manifest.js';

export const PREFLIGHT_RULESET = 'marketplace-validation-mirror/2026-08-19';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures: string[] = [];
const fail = (message: string, fix: string) => failures.push(`${message}\n  Fix: ${fix}`);

interface PackageJsonIdentity {
  name: string;
  version: string;
  title?: string;
  description: string;
  repository?: { type: string; url: string } | string;
}

async function main(): Promise<void> {
  console.log(`PrivOS MCP app preflight (${PREFLIGHT_RULESET})`);

  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8')) as PackageJsonIdentity;
  const manifest = createManifest();

  if (JSON.stringify(Object.keys(manifest)) !== JSON.stringify(MARKETPLACE_MANIFEST_FIELDS)) {
    fail('Manifest contains unsupported or missing fields.', 'Keep privos-app.json aligned with MARKETPLACE_MANIFEST_FIELDS.');
  }

  for (const field of ['name', 'version', 'title', 'description'] as const) {
    if (manifest[field] !== pkg[field]) {
      fail(`Manifest field "${field}" differs from package.json.`, 'Keep package identity fields synchronized with privos-app.json.');
    }
  }
  const pkgRepositoryUrl = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  if (manifest.repository !== pkgRepositoryUrl) {
    fail('Manifest repository differs from package.json.', 'Use the canonical GitHub repository URL in both files.');
  }

  if (!(SUPPORTED_MANIFEST_SCHEMA_VERSIONS as readonly number[]).includes(manifest.schemaVersion) || manifest.kind !== 'mcp-app') {
    fail(
      'privos-app.json is not a supported MCP app manifest.',
      `Set schemaVersion to one of ${SUPPORTED_MANIFEST_SCHEMA_VERSIONS.join(', ')} and kind to mcp-app.`,
    );
  }
  const lint = lintManifest(manifest);
  console.log(`canonicalManifestHash=${lint.canonicalManifestHash}`);
  console.log(`publisherPermissionDeclarationHash=${lint.publisherPermissionDeclarationHash || '<unavailable>'}`);
  for (const error of lint.errors) fail(`Manifest: ${error}.`, 'Run npm run manifest:lint and correct the reported contract.');

  const lockPath = path.join(repoRoot, 'package-lock.json');
  if (fs.existsSync(lockPath)) {
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
      version?: string;
      packages?: Record<string, { version?: string }>;
    };
    const lockRootVersions = [lock.version, lock.packages?.['']?.version];
    if (lockRootVersions.some((version) => version !== pkg.version)) {
      fail(
        `package-lock.json declares ${lockRootVersions.join(' / ')} but the app is ${pkg.version}.`,
        'Run `npm install --package-lock-only` after every version bump and commit the lockfile.',
      );
    }
  }

  const handle = await serveApp({
    descriptor: buildRelayAppDescriptor(),
    createHandler: () => async () => ({}),
    port: 0,
    host: '127.0.0.1',
    installSignalHandlers: false,
    resolveManifest: () => createManifest(),
    __test: { env: { ...process.env, NODE_ENV: 'development' } },
    configure: (app) => {
      app.get('/.well-known/mcp/manifest.json', (_req, res) => res.json(createManifest()));
    },
  });
  const address = handle.server.address();
  if (!address || typeof address === 'string') {
    fail('Direct server did not bind a TCP port.', 'Ensure serveApp binds an HTTP surface for the smoke check.');
  } else {
    const response = await fetch(`http://127.0.0.1:${address.port}/.well-known/mcp/manifest.json`);
    if (!response.ok || JSON.stringify(await response.json()) !== JSON.stringify(manifest)) {
      fail('The running app did not serve the authoritative manifest.', 'Route GET /.well-known/mcp/manifest.json to createManifest() via serveApp configure.');
    }
  }
  await handle.close();

  if (failures.length) {
    console.error(`\nPreflight failed (${failures.length}):\n- ${failures.join('\n- ')}`);
    process.exit(1);
  }
  console.log('Preflight passed.');
}

main().catch((error) => {
  console.error(`Preflight crashed: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});

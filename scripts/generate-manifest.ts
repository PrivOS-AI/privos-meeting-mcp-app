/**
 * Writes the marketplace-projected manifest to `dist/manifest.json` as part of
 * `npm run build`, so the digest-pinned bytes served in production are
 * byte-identical to what `createManifest()` projects from `privos-app.json`.
 */
import fs from 'node:fs';
import path from 'node:path';

import { createManifest } from '../src/server/manifest.js';

const output = path.resolve('dist/manifest.json');
fs.mkdirSync(path.dirname(output), { recursive: true });
fs.writeFileSync(output, `${JSON.stringify(createManifest(), null, 2)}\n`);
console.log(`Generated ${output}`);

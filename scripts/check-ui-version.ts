/**
 * The UI is part of the versioned app contract: a Hub ingests a version's UI
 * once (on install, upgrade, or the admin's Refresh after the manifest changed)
 * and keeps serving that asset set. A UI that changes under the SAME version
 * leaves the Hub with the old assets while the live shell names new ones, and
 * the frame shows "App assets unavailable" (it happened on dev, twice).
 *
 * This check fails when the built UI bundle differs from the one recorded for
 * the current version in `ui-bundle.lock.json`:
 *
 *   npm run build && npm run check:ui-version      # fails if the UI changed under the same version
 *   (bump "version" in privos-app.json + package.json) && npm run ui:lock
 *
 * The digest is the SDK's deterministic bundle (`privos-app bundle-ui`), the
 * same bytes a Marketplace version would carry.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const LOCK = path.resolve('ui-bundle.lock.json');
const write = process.argv.includes('--write');

const manifestVersion = (JSON.parse(readFileSync('privos-app.json', 'utf8')) as { version: string }).version;
const packageVersion = (JSON.parse(readFileSync('package.json', 'utf8')) as { version: string }).version;
if (manifestVersion !== packageVersion) {
  console.error(`privos-app.json version ${manifestVersion} and package.json version ${packageVersion} differ — keep them equal.`);
  process.exit(1);
}

const out = path.join(mkdtempSync(path.join(os.tmpdir(), 'ui-bundle-')), 'ui.tar');
const cli = path.resolve('node_modules', '.bin', process.platform === 'win32' ? 'privos-app.cmd' : 'privos-app');
execFileSync(cli, ['bundle-ui', '--out', out], { stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' });
const sha256 = createHash('sha256').update(readFileSync(out)).digest('hex');

const lock = existsSync(LOCK) ? (JSON.parse(readFileSync(LOCK, 'utf8')) as { version: string; sha256: string }) : null;

if (write) {
  if (lock && lock.version === manifestVersion && lock.sha256 !== sha256) {
    console.error(`The UI changed but the version is still ${manifestVersion}. Bump "version" in privos-app.json and package.json first.`);
    process.exit(1);
  }
  writeFileSync(LOCK, `${JSON.stringify({ version: manifestVersion, sha256 }, null, 2)}\n`);
  console.log(`ui-bundle.lock.json: ${manifestVersion} ${sha256}`);
  process.exit(0);
}

if (!lock) {
  console.error('ui-bundle.lock.json is missing — run `npm run ui:lock`.');
  process.exit(1);
}
if (lock.sha256 === sha256) {
  console.log(`UI bundle matches version ${lock.version}.`);
  process.exit(0);
}
if (lock.version === manifestVersion) {
  console.error(
    `The UI changed but the version is still ${manifestVersion}: a Hub would keep serving the old assets ("App assets unavailable").\n` +
      'Bump "version" in privos-app.json and package.json, then run `npm run ui:lock`.',
  );
  process.exit(1);
}
console.error(`Version is ${manifestVersion} but ui-bundle.lock.json records ${lock.version} — run \`npm run ui:lock\`.`);
process.exit(1);

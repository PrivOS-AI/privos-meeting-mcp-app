/**
 * One-time standalone pairing (`npm run pair`). Announces `privos-app.json` over
 * the pairing socket, waits for an admin to approve the permission ceiling in
 * Hub Admin > Apps, then writes the identity file and starts the app in
 * standalone-production mode — one command, no second URL.
 */
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

import { buildPairingMetadata, pairAndAwaitApproval, type PairingResult } from '@privos_ai/app-server';
import WebSocket from 'ws';

import { buildRelayAppDescriptor, resolveFilesOrigin } from '../src/server/manifest.js';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer: string) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function runStandaloneServer(): Promise<number> {
  const agent = (process.env.npm_config_user_agent || '').split('/')[0];
  const argv = agent === 'pnpm' ? ['pnpm', 'start'] : agent === 'yarn' ? ['yarn', 'start'] : ['npm', 'start'];
  console.log(`\nStarting the app: ${argv.join(' ')}\n`);
  return new Promise((resolve, reject) => {
    const child = spawn(argv[0], argv.slice(1), {
      cwd: repositoryRoot,
      stdio: 'inherit',
      env: { ...process.env, NODE_ENV: 'production' },
    });
    child.on('error', reject);
    child.on('exit', (code, signal) => resolve(signal ? 1 : (code ?? 0)));
  });
}

async function main(): Promise<void> {
  const pairUrl = await prompt('Enter the one-time pairing URL from Hub Admin: ');
  if (!pairUrl) throw new Error('No pairing URL provided');

  // Resolve the CSP `<PRIVOS_FILES_ORIGIN>` placeholder from env before announcing,
  // so the paired install carries the real Files origin (not the literal token).
  const manifest = resolveFilesOrigin(JSON.parse(await readFile(path.join(repositoryRoot, 'privos-app.json'), 'utf8')));
  console.log('\nRegistering… once registered, approve the permission ceiling in Hub Admin > Apps.');
  console.log('This command keeps waiting and starts the app automatically after approval.');
  const paired: PairingResult = await pairAndAwaitApproval(
    pairUrl,
    { ...buildPairingMetadata(buildRelayAppDescriptor()), manifest },
    WebSocket,
    { onAwaitingApproval: () => process.stdout.write('.') },
  );

  if (paired.pairingVersion !== 2 || !paired.identityFilePath) {
    throw new Error(
      'This Hub did not return standalone dispatch trust (pairingVersion 2). '
        + 'Standalone production requires a Hub that supports standalone pairing.',
    );
  }

  console.log(`\nIdentity saved to ${paired.identityFilePath}`);
  console.log('Verify the fingerprint out-of-band with the operator who issued the pairing URL before trusting dispatch.');

  process.exitCode = await runStandaloneServer();
}

main().catch((err) => {
  const reason = String(err instanceof Error ? err.message : err).replace(/^Pairing failed: /, '');
  console.error(`\nPairing failed: ${reason}`);
  process.exit(1);
});

/**
 * SPIKE: Vietnamese A/B quality test: soniox-async vs elevenlabs-batch
 *
 * Does NOT block P2+. Run >=30 minutes of VN+EN audio through both installed
 * async providers. Measure WER (vi+en), speaker-assignment accuracy over 50
 * turns, and first-label latency. Results only adjust the STT_*_PROVIDER
 * default; record them in docs/system-architecture.md.
 *
 * This is a foundational Phase-1 spike (see plan.md § Spikes). It CANNOT run
 * without live credentials / a live PrivOS Hub, so offline it only verifies its
 * prerequisites and prints the exact procedure. Fill observed results into
 * docs/system-architecture.md § Spike results. Requires: SONIOX_API_KEY,ELEVENLABS_API_KEY.
 */
const REQUIRED: string[] = ['SONIOX_API_KEY','ELEVENLABS_API_KEY'];

function main(): void {
  console.log('SPIKE: Vietnamese A/B quality test: soniox-async vs elevenlabs-batch');
  const missing = REQUIRED.filter((k) => !process.env[k] || !process.env[k]!.trim());
  if (missing.length) {
    console.warn('Prerequisites missing (spike not run):', missing.join(', '));
    console.warn('Set them (see .env.example) and re-run against a live Hub. Record observed output in docs/system-architecture.md.');
    return;
  }
  console.log('Prerequisites present. Implement the live probe as described in the file header, then record observed output.');
}

main();

export {};

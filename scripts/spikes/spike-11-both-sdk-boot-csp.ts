/**
 * SPIKE: Both SDKs boot in a room tab under CSP
 *
 * Open the tool in a room: run the Soniox wrapper and @elevenlabs/client Scribe.connect({microphone:false,token}). Confirm no "Refused to connect", record the real CSP directive, the origins both SDKs touch, and the ElevenLabs realtime concurrency limit.
 *
 * This is a foundational Phase-1 spike (see plan.md § Spikes). It CANNOT run
 * without live credentials / a live PrivOS Hub, so offline it only verifies its
 * prerequisites and prints the exact procedure. Fill observed results into
 * docs/system-architecture.md § Spike results. Requires: SONIOX_API_KEY,ELEVENLABS_API_KEY.
 */
const REQUIRED: string[] = ['SONIOX_API_KEY','ELEVENLABS_API_KEY'];

function main(): void {
  console.log('SPIKE: Both SDKs boot in a room tab under CSP');
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

/**
 * SPIKE: Cả hai SDK boot trong tab phòng dưới CSP
 *
 * Mở tool trong phòng: chạy wrapper Soniox và @elevenlabs/client Scribe.connect({microphone:false,token}). Xác nhận không Refused to connect, ghi directive CSP thật, origin hai SDK chạm, và giới hạn đồng thời ElevenLabs realtime.
 *
 * This is a foundational Phase-1 spike (see plan.md § Spikes). It CANNOT run
 * without live credentials / a live PrivOS Hub, so offline it only verifies its
 * prerequisites and prints the exact procedure. Fill observed results into
 * docs/system-architecture.md § Spike results. Requires: SONIOX_API_KEY,ELEVENLABS_API_KEY.
 */
const REQUIRED: string[] = ['SONIOX_API_KEY','ELEVENLABS_API_KEY'];

function main(): void {
  console.log('SPIKE: Cả hai SDK boot trong tab phòng dưới CSP');
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

/**
 * SPIKE: Soniox realtime qua SDK ~5 phút
 *
 * Mint temporary-api-key -> new SonioxClient().start({...,stream,enableSpeakerDiarization,translation:two_way}). Ghi: JSON token thô, translation có sống chung diarization không, speaker trên token is_final, mã đóng thật, độ trễ, origin SDK chạm tới.
 *
 * This is a foundational Phase-1 spike (see plan.md § Spikes). It CANNOT run
 * without live credentials / a live PrivOS Hub, so offline it only verifies its
 * prerequisites and prints the exact procedure. Fill observed results into
 * docs/system-architecture.md § Spike results. Requires: SONIOX_API_KEY.
 */
const REQUIRED: string[] = ['SONIOX_API_KEY'];

function main(): void {
  console.log('SPIKE: Soniox realtime qua SDK ~5 phút');
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

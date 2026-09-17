/**
 * SPIKE: Dựng wrapper + ghim SDK Soniox
 *
 * Chứng minh gói chọn (@soniox/speech-to-text-web@1.4.0 vs @soniox/client@2.3.0) nhận MediaStream ta cấp, trả token speaker, stop() flush, reconnect key mới, lộ lỗi/backpressure ra callback. Ghim version.
 *
 * This is a foundational Phase-1 spike (see plan.md § Spikes). It CANNOT run
 * without live credentials / a live PrivOS Hub, so offline it only verifies its
 * prerequisites and prints the exact procedure. Fill observed results into
 * docs/system-architecture.md § Spike results. Requires: SONIOX_API_KEY.
 */
const REQUIRED: string[] = ['SONIOX_API_KEY'];

function main(): void {
  console.log('SPIKE: Dựng wrapper + ghim SDK Soniox');
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

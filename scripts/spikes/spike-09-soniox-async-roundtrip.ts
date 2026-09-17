/**
 * SPIKE: Soniox async round-trip webm 60s + 2h
 *
 * POST /v1/files -> /v1/transcriptions -> poll completed. Lưu JSON output thô, tên trường thật, thời gian quay vòng; thử file ~2h để đo giới hạn kích thước/thời lượng.
 *
 * This is a foundational Phase-1 spike (see plan.md § Spikes). It CANNOT run
 * without live credentials / a live PrivOS Hub, so offline it only verifies its
 * prerequisites and prints the exact procedure. Fill observed results into
 * docs/system-architecture.md § Spike results. Requires: SONIOX_API_KEY.
 */
const REQUIRED: string[] = ['SONIOX_API_KEY'];

function main(): void {
  console.log('SPIKE: Soniox async round-trip webm 60s + 2h');
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

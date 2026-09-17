/**
 * SPIKE: getUserMedia trong tab phòng Hub
 *
 * Xác nhận getUserMedia() hoạt động khi tool khai _meta.ui.permissions:['microphone']. Chạy trong iframe phòng Hub thật, bấm Bắt đầu ghi, xác nhận hộp thoại xin quyền hiện ra.
 *
 * This is a foundational Phase-1 spike (see plan.md § Spikes). It CANNOT run
 * without live credentials / a live PrivOS Hub, so offline it only verifies its
 * prerequisites and prints the exact procedure. Fill observed results into
 * docs/system-architecture.md § Spike results. Requires: none.
 */
const REQUIRED: string[] = [];

function main(): void {
  console.log('SPIKE: getUserMedia trong tab phòng Hub');
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

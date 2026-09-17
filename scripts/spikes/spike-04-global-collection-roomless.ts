/**
 * SPIKE: Collection scope:global room-less
 *
 * registerCollection(scope:'global') KHÔNG truyền roomId -> getSchema phải trả scope:'global' và KHÔNG có roomId. Nếu bị đóng dấu room thì drop + re-register khi rỗng.
 *
 * This is a foundational Phase-1 spike (see plan.md § Spikes). It CANNOT run
 * without live credentials / a live PrivOS Hub, so offline it only verifies its
 * prerequisites and prints the exact procedure. Fill observed results into
 * docs/system-architecture.md § Spike results. Requires: PRIVOS_AGENT_BOT_USER_ID,PRIVOS_AGENT_BOT_CREDENTIAL,MCP_APP_ID.
 */
const REQUIRED: string[] = ['PRIVOS_AGENT_BOT_USER_ID','PRIVOS_AGENT_BOT_CREDENTIAL','MCP_APP_ID'];

function main(): void {
  console.log('SPIKE: Collection scope:global room-less');
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

/**
 * SPIKE: mcpapp.bot.getMe / bot credential
 *
 * Call mcpapp.bot.getMe (or GET /api/v1/me) to decide the "Send to Chat room" button in P6; confirm the source of botToken.
 *
 * This is a foundational Phase-1 spike (see plan.md § Spikes). It CANNOT run
 * without live credentials / a live PrivOS Hub, so offline it only verifies its
 * prerequisites and prints the exact procedure. Fill observed results into
 * docs/system-architecture.md § Spike results. Requires: PRIVOS_AGENT_BOT_USER_ID,PRIVOS_AGENT_BOT_CREDENTIAL.
 */
const REQUIRED: string[] = ['PRIVOS_AGENT_BOT_USER_ID','PRIVOS_AGENT_BOT_CREDENTIAL'];

function main(): void {
  console.log('SPIKE: mcpapp.bot.getMe / bot credential');
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

/**
 * Wiring point for every app-owned tool. Called once at startup so registration
 * order is explicit. Later phases append their feature tools here (recording
 * token, chunk ingest, live speakers, process/summarize, speaker resolution).
 * The UI-bearing `meeting_agent` tool is declared in the manifest and answered
 * directly by the MCP handler.
 */
import { botCredentialCheckTool } from './bot-credential-check-tool.js';
import { bootstrapTool } from './bootstrap-tool.js';
import { chunkReadyTool } from './chunk-ready-tool.js';
import { realtimeTokenTool } from './realtime-token-tool.js';
import { registerTool } from './registry.js';
import { sttStatusTool } from './stt-status-tool.js';
import { translateTool } from './translate-tool.js';

export function registerAllTools(): void {
  registerTool(botCredentialCheckTool);
  registerTool(bootstrapTool);
  registerTool(sttStatusTool);
  registerTool(realtimeTokenTool);
  registerTool(chunkReadyTool);
  registerTool(translateTool);
}

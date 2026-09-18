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
import { liveSpeakersTool } from './live-speakers-tool.js';
import { processTool } from './process-tool.js';
import { realtimeTokenTool } from './realtime-token-tool.js';
import { registerTool } from './registry.js';
import { relabelSpeakerTool } from './relabel-speaker-tool.js';
import { sendToChatTool } from './send-to-chat-tool.js';
import { settingsSetTool } from './settings-set-tool.js';
import { speakerProfileDeleteTool, speakerProfileListTool, speakerProfileUpdateTool } from './speaker-profile-tools.js';
import { speakerResolveTool } from './speaker-resolve-tool.js';
import { statusTool } from './status-tool.js';
import { sttStatusTool } from './stt-status-tool.js';
import { summarizeTool } from './summarize-tool.js';
import { translateTool } from './translate-tool.js';

export function registerAllTools(): void {
  registerTool(botCredentialCheckTool);
  registerTool(bootstrapTool);
  registerTool(sttStatusTool);
  registerTool(realtimeTokenTool);
  registerTool(chunkReadyTool);
  registerTool(liveSpeakersTool);
  registerTool(translateTool);
  registerTool(processTool);
  registerTool(statusTool);
  registerTool(summarizeTool);
  registerTool(sendToChatTool);
  registerTool(settingsSetTool);
  registerTool(speakerResolveTool);
  registerTool(speakerProfileListTool);
  registerTool(speakerProfileUpdateTool);
  registerTool(speakerProfileDeleteTool);
  registerTool(relabelSpeakerTool);
}

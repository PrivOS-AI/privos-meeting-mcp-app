/**
 * Registry of app-owned MCP tools. Feature modules register here instead of
 * editing the transport or the MCP handler, so adding a capability stays a
 * one-file change.
 */
import type { RoomBoundHubClient, ToolCallContext } from '@privos_ai/app-server';

/** Platform access every tool call gets alongside the per-call context. */
export interface ToolRuntime {
  agentBotHub: RoomBoundHubClient;
}

export interface AppTool {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(args: Record<string, unknown>, context: ToolCallContext, runtime: ToolRuntime): Promise<unknown>;
}

const tools = new Map<string, AppTool>();

export function registerTool(tool: AppTool): void {
  if (tools.has(tool.name)) {
    throw new Error(`Tool already registered: ${tool.name}`);
  }
  tools.set(tool.name, tool);
}

export function resolveTool(name: string | undefined): AppTool | undefined {
  return name ? tools.get(name) : undefined;
}

/** Tool declarations for `tools/list`, without the executable body. */
export function listToolDefinitions(): Array<Omit<AppTool, 'execute'>> {
  return [...tools.values()].map(({ execute: _execute, ...definition }) => definition);
}

/** Names of every registered tool — used by tests to assert the manifest matches. */
export function registeredToolNames(): string[] {
  return [...tools.keys()];
}

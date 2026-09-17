/**
 * MCP request handler. `initialize` / `notifications/initialized` are answered
 * by the SDK runtime from the descriptor/ui; what is left for the app is
 * advertising its tools (from `tools/registry.ts`) and executing them.
 *
 * Feature tools FAIL CLOSED: a call is refused unless the caller has a verified
 * actor, except in development with `ALLOW_UNVERIFIED_ACTOR=1`. The UI tool
 * (`meeting_agent`) is exempt — it only returns the app document.
 */
import type { AppMcpHandler, ServeAppHandlerContext, ToolCallContext } from '@privos_ai/app-server';

import { AppError } from '../shared/app-error.js';
import { env, isDevelopmentRuntime } from './env.js';
import { UI_RESOURCE_URI, manifest } from './manifest.js';
import { listToolDefinitions, resolveTool, type ToolRuntime } from './tools/registry.js';
import { renderUiHtml } from './ui-resource.js';

/** The UI-bearing tool declared first in the manifest. */
const UI_TOOL = manifest.tools[0] as { name?: string; title?: string; description?: string } | undefined;
const UI_TOOL_NAME = String(UI_TOOL?.name ?? 'meeting_agent');
const UI_TOOL_TITLE = String(UI_TOOL?.title ?? manifest.title);
const UI_TOOL_DESCRIPTION = String(UI_TOOL?.description ?? manifest.description);

/** `_meta.ui` (resourceUri + permissions + csp + hideAiChat) for the UI tool. */
const UI_TOOL_META = (manifest.tools[0] as { _meta?: { ui?: unknown } })?._meta ?? {
  ui: { resourceUri: UI_RESOURCE_URI },
};

/** Fail closed unless the caller is a verified actor (dev escape hatch aside). */
function assertVerifiedActor(context: ToolCallContext): void {
  const verified = Boolean(context.actor) && context.identityState === 'verified';
  if (verified) return;
  if (isDevelopmentRuntime() && env.allowUnverifiedActor) return;
  throw new AppError('Yêu cầu bị từ chối: cần một người dùng đã xác minh danh tính.');
}

export function createMcpHandler(ctx: ServeAppHandlerContext): AppMcpHandler {
  const runtime: ToolRuntime = { agentBotHub: ctx.agentBotHub };

  return async function handleMcpRequest(request, context: ToolCallContext): Promise<unknown> {
    switch (request.method) {
      case 'tools/list':
        return {
          tools: [
            {
              name: UI_TOOL_NAME,
              title: UI_TOOL_TITLE,
              description: UI_TOOL_DESCRIPTION,
              inputSchema: { type: 'object', properties: { roomId: { type: 'string' } } },
              _meta: UI_TOOL_META,
            },
            ...listToolDefinitions(),
          ],
        };

      case 'tools/call': {
        const params = (request.params ?? {}) as { name?: string; arguments?: Record<string, unknown> };

        if (params.name === UI_TOOL_NAME) {
          return {
            content: [
              {
                type: 'resource',
                resource: {
                  uri: UI_RESOURCE_URI,
                  mimeType: 'text/html;profile=mcp-app',
                  text: renderUiHtml(),
                },
              },
            ],
          };
        }

        const tool = resolveTool(params.name);
        if (!tool) {
          throw Object.assign(new Error(`Unknown tool: ${params.name ?? '<missing>'}`), { code: -32601 });
        }
        assertVerifiedActor(context);
        const result = await tool.execute(params.arguments ?? {}, context, runtime);
        return { content: [{ type: 'text', text: JSON.stringify(result) }] };
      }

      default:
        throw Object.assign(new Error(`Method not found: ${request.method}`), { code: -32601 });
    }
  };
}

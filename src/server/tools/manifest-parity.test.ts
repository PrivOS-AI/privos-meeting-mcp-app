import { describe, expect, it } from 'vitest';

import publisherManifest from '../../../privos-app.json';
import { registerAllTools } from './index.js';
import { listToolDefinitions } from './registry.js';

interface ManifestTool {
  name: string;
  title: string;
  description: string;
  inputSchema: unknown;
}

describe('runtime tool registry matches the published manifest', () => {
  registerAllTools();
  const registered = listToolDefinitions();
  const manifestTools = publisherManifest.tools as ManifestTool[];
  const uiToolName = manifestTools[0].name;

  it('registers every non-UI manifest tool exactly once', () => {
    const nonUiNames = manifestTools.filter((t) => t.name !== uiToolName).map((t) => t.name).sort();
    expect(registered.map((t) => t.name).sort()).toEqual(nonUiNames);
  });

  it('keeps each registered tool title + description identical to the manifest', () => {
    for (const tool of registered) {
      const manifestTool = manifestTools.find((t) => t.name === tool.name);
      expect(manifestTool, `manifest missing tool ${tool.name}`).toBeDefined();
      expect(tool.title).toBe(manifestTool!.title);
      expect(tool.description).toBe(manifestTool!.description);
    }
  });

  it('keeps each registered tool inputSchema identical to the manifest (run npm run manifest:sync-tools)', () => {
    for (const tool of registered) {
      const manifestTool = manifestTools.find((t) => t.name === tool.name);
      expect(JSON.parse(JSON.stringify(tool.inputSchema)), tool.name).toEqual(manifestTool!.inputSchema);
    }
  });

  it('bounds every string and array a tool accepts', () => {
    const unbounded: string[] = [];
    const walk = (schema: unknown, where: string): void => {
      if (!schema || typeof schema !== 'object') return;
      const node = schema as Record<string, unknown>;
      const types = ([] as unknown[]).concat(node.type ?? []);
      if (types.includes('string') && node.maxLength === undefined && node.enum === undefined) unbounded.push(`${where} (string)`);
      if (types.includes('array') && node.maxItems === undefined) unbounded.push(`${where} (array)`);
      for (const [key, child] of Object.entries((node.properties as Record<string, unknown>) ?? {})) walk(child, `${where}.${key}`);
      if (node.items) walk(node.items, `${where}[]`);
    };
    for (const tool of manifestTools) walk(tool.inputSchema, tool.name);
    expect(unbounded).toEqual([]);
  });
});

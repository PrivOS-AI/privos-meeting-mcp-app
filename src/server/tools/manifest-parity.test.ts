import { describe, expect, it } from 'vitest';

import publisherManifest from '../../../privos-app.json';
import { registerAllTools } from './index.js';
import { listToolDefinitions } from './registry.js';

interface ManifestTool {
  name: string;
  title: string;
  description: string;
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
});

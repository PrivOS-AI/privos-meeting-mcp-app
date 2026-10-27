/**
 * Copies every registered tool's title, description and inputSchema into
 * `privos-app.json`, so the reviewed manifest and `tools/list` cannot drift
 * (`src/server/tools/manifest-parity.test.ts` fails when they do). The UI tool
 * (`meeting_agent`, first in the manifest) is not registered and is left as is.
 * Run via `npm run manifest:sync-tools`, then review the diff.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { registerAllTools } from '../src/server/tools/index.js';
import { listToolDefinitions } from '../src/server/tools/registry.js';

const manifestPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'privos-app.json');
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as { tools: Array<Record<string, unknown>> };

registerAllTools();
const definitions = new Map(listToolDefinitions().map((tool) => [tool.name, tool]));

let changed = 0;
manifest.tools = manifest.tools.map((tool) => {
  const definition = definitions.get(String(tool.name));
  if (!definition) return tool;
  const next = { ...tool, title: definition.title, description: definition.description, inputSchema: definition.inputSchema };
  if (JSON.stringify(next) !== JSON.stringify(tool)) changed++;
  return next;
});
const missing = [...definitions.keys()].filter((name) => !manifest.tools.some((tool) => tool.name === name));
if (missing.length) {
  console.error(`Registered tools missing from privos-app.json (add them by hand, with any ui/_meta): ${missing.join(', ')}`);
  process.exit(1);
}

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`privos-app.json: ${changed} tool definition(s) updated.`);
// Tool modules start background timers on import; nothing else to wait for.
process.exit(0);

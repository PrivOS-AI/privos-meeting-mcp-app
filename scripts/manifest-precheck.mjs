#!/usr/bin/env node
// Mirrors the privos-portal rules that reject a privos-app.json at upload (schemaVersion 3).
// Sources (privos-portal: schema rules @ privos-mt 78e2ee3; permission catalog @ develop f4eb90a, 2026-10-08):
//   src/services/marketplace/marketplace-mcp-permission-catalog.ts  — scope/context/executionContext
//   src/services/marketplace/marketplace-archive-manifest.ts        — v3 schema + cross-field rules
//   src/services/app-cluster/runtime-size-catalog.ts                — runtime sizes
// Usage: node manifest-precheck.mjs [path/to/privos-app.json]   (default: ./privos-app.json)
// Re-sync these tables when the Portal changes; the Portal is the truth, this is an early warning.
import { readFileSync } from "node:fs";
const m = JSON.parse(readFileSync(process.argv[2] || "./privos-app.json", "utf8")), e = [];
const err = (msg) => e.push(msg);
const len = (s) => (typeof s === "string" ? s.trim().length : -1);
const INSTANT = m.executionMode === "INSTANT";

// --- identity & metadata ---
if (m.schemaVersion !== 3) err(`schemaVersion: must be 3 (got ${m.schemaVersion})`);
if (m.kind !== "mcp-app") err(`kind: must be "mcp-app"`);
if (!/^[a-z0-9][a-z0-9._-]{1,127}$/.test(m.name || "")) err(`name: "${m.name}" must match ^[a-z0-9][a-z0-9._-]{1,127}$ (lowercase)`);
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(m.version || "")) err(`version: "${m.version}" is not semver`);
if (len(m.title) < 2 || len(m.title) > 100) err("title: 2–100 chars");
if (len(m.description) < 10 || len(m.description) > 2000) err("description: 10–2000 chars");
if (m.port !== undefined && !(Number.isInteger(m.port) && m.port >= 1024 && m.port <= 65535)) err(`port: ${m.port} must be an integer 1024–65535`);

// --- runtime resources ---
const SIZES = { XS: [256, 0.25], S: [512, 0.5], M: [1024, 1], L: [2048, 2], XL: [4096, 4] }, ORDER = Object.keys(SIZES);
const r = m.resources;
if (r) {
  if (!(r.memoryMb >= 64 && r.memoryMb <= 4096)) err(`resources.memoryMb: ${r.memoryMb} must be 64–4096`);
  if (!(r.cpus >= 0.1 && r.cpus <= 4)) err(`resources.cpus: ${r.cpus} must be 0.1–4`);
  if (r.tmpSizeMb !== undefined && !(r.tmpSizeMb >= 16 && r.tmpSizeMb <= 1024)) err(`resources.tmpSizeMb: ${r.tmpSizeMb} must be 16–1024`);
  if (r.memoryMb > 2048 && m.runtime?.recommendedSize !== "XL") err("resources.memoryMb > 2048 requires runtime.recommendedSize XL");
}
if (m.runtime) {
  const { minimumSize: lo, recommendedSize: hi } = m.runtime;
  if (!SIZES[lo] || !SIZES[hi]) err(`runtime: sizes must be one of ${ORDER}`);
  else {
    if (ORDER.indexOf(lo) > ORDER.indexOf(hi)) err("runtime.minimumSize must be <= recommendedSize");
    if (r && (r.memoryMb !== SIZES[hi][0] || r.cpus !== SIZES[hi][1])) err(`RUNTIME_RESOURCES_MISMATCH: resources must equal ${hi} (memoryMb ${SIZES[hi][0]}, cpus ${SIZES[hi][1]})`);
  }
}

// --- state: stateless / volumes ---
if (!INSTANT) {
  if (typeof m.stateless !== "boolean") err("stateless: required (true|false) except for INSTANT apps");
  else if (m.stateless === false && (m.volumes || []).length !== 1) err(`volumes: stateless:false needs exactly one data volume (got ${(m.volumes || []).length}) — or set stateless:true`);
}
if ((m.volumes || []).length > 1) err("volumes: at most one (name \"data\")");
(m.volumes || []).forEach((v, i) => { if (v.name !== "data") err(`volumes.${i}.name: must be "data"`); });

// --- dataPolicy ---
if (!INSTANT && !m.dataPolicy) err("dataPolicy: required except for INSTANT apps");
if (m.dataPolicy) {
  if (len(m.dataPolicy.version) < 1) err("dataPolicy.version: required");
  if (len(m.dataPolicy.retention) < 10) err("dataPolicy.retention: 10–2000 chars");
  if (m.dataPolicy.externalProcessing && !(m.dataPolicy.externalDestinations || []).length)
    err("dataPolicy.externalDestinations: required when externalProcessing is true (list where data goes, e.g. \"Anthropic API\")");
}

// --- env ---
const env = m.env || [];
if (env.length > 32) err(`env: at most 32 entries (got ${env.length})`);
const seenEnv = new Set();
env.forEach((v, i) => {
  const t = `env.${i} ${v.key}`;
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(v.key || "")) err(`${t}: key must match ^[A-Z][A-Z0-9_]{0,63}$`);
  if (/^PRIVOS_/.test(v.key) && !["PRIVOS_AGENT_BOT_CREDENTIAL", "PRIVOS_AGENT_BOT_USER_ID"].includes(v.key)) err(`${t}: reserved PRIVOS_ prefix (rename, e.g. APP_…)`);
  if (["PORT", "HOME", "PATH"].includes(v.key)) err(`${t}: runtime-owned name`);
  if (len(v.description) < 1 || len(v.description) > 200) err(`${t}: description 1–200 chars`);
  if (typeof v.required !== "boolean" || typeof v.secret !== "boolean") err(`${t}: required and secret must be booleans`);
  if (seenEnv.has(v.key)) err(`${t}: duplicate key`); seenEnv.add(v.key);
});

// --- tools & UI ---
const seenTool = new Set();
(m.tools || []).forEach((tool, i) => {
  if (seenTool.has(tool.name)) err(`tools.${i}: duplicate tool name ${tool.name}`); seenTool.add(tool.name);
  const uri = tool.ui?.resourceUri;
  if (uri) {
    let host; try { host = new URL(uri).host; } catch { host = null; }
    if (host !== m.name) err(`tools.${i} ${tool.name}: ui host "${host}" must equal manifest name "${m.name}" (split assets are fetched at ui://<name>/assets/…)`);
  }
});
if (INSTANT && m.ui?.shellMode === "live") err('ui.shellMode "live" is not allowed for INSTANT apps');
const tiers = (m.license?.tiers || []).map((t) => t.id);
if (new Set(tiers).size !== tiers.length) err("license.tiers: ids must be unique");

// --- permissions (catalog) ---
// Generated from privos-portal MARKETPLACE_MCP_PERMISSION_CATALOG (develop @ f4eb90a), which mirrors the Hub's
// apps/meteor/server/services/mcp-permission-catalog.ts (MCP_PERMISSION_CATALOG_VERSION 2026-08-31). Regenerate, never hand-edit.
const C = {
 "basic:information":[["workspace", "room"],["user", "background", "both"]],
 "lists:read":[["workspace", "room"],["user", "background", "both"]],
 "lists:query":[["workspace", "room"],["user", "background", "both"]],
 "lists:write":[["workspace", "room"],["user", "background", "both"]],
 "custom-permissions:read":[["room"],["user", "background", "both"]],
 "custom-permissions:write":[["room"],["user", "background", "both"]],
 "files:read":[["workspace", "room"],["user", "background", "both"]],
 "files:write":[["workspace", "room"],["user", "background", "both"]],
 "messages:read":[["room"],["user"]],
 "messages:send":[["room"],["user", "background", "both"]],
 "notifications:write":[["room"],["user", "background", "both"]],
 "users:read":[["workspace", "room"],["user"]],
 "rooms:read":[["workspace", "room"],["user"]],
 "rooms:write":[["workspace", "room"],["user"]],
 "db:read":[["workspace", "room"],["user", "background", "both"]],
 "db:write":[["workspace", "room"],["user", "background", "both"]],
 "db:schema:read":[["workspace", "room"],["user", "background", "both"]],
 "db:schema:write":[["workspace", "room"],["user", "background", "both"]],
 "bot:message:send":[["room"],["background"]],
 "bot:room:join":[["room"],["user"]],
 "bot:identity:read":[["room"],["user"]],
 "sandbox:generate":[["room"],["user"]],
 "sandbox:skills:use":[["room"],["user"]],
 "sandbox:botkey:push":[["room"],["user"]],
 "sandbox:wake":[["room"],["user"]],
 "sandbox:ai-chat":[["room"],["user"]],
 "sandbox:ai-chat:write":[["room"],["user"]],
 "sandbox:agent-sets:upload":[["workspace"],["user"]],
 "rooms:roles:read":[["room"],["user"]],
 "firm-knowledge:admin":[["room"],["user"]],
 "firm-knowledge:grants:write":[["room"],["user"]],
 "firm-knowledge:evidence:read":[["room"],["user"]],
 "firm-knowledge:answer:run":[["room"],["user"]],
 "firm-knowledge:quality:report":[["room"],["user"]],
 "firm-knowledge:draft:write":[["room"],["user"]],
 "firm-knowledge:sop:read":[["room"],["user"]],
 "firm-knowledge:sop-run:read":[["room"],["user"]],
 "firm-knowledge:sop-run:start":[["room"],["user"]],
 "firm-knowledge:sop-step:submit":[["room"],["user"]],
 "firm-knowledge:sop-approval:request":[["room"],["user"]],
 "firm-knowledge:sop-run:cancel":[["room"],["user"]],
 "firm-knowledge:workspace:read":[["workspace", "room"],["user"]],
 "firm-knowledge:workspace:answer:run":[["workspace", "room"],["user"]],
 "firm-knowledge:workspace:curate":[["workspace", "room"],["user"]],
 "firm-knowledge:workspace:review":[["workspace", "room"],["user"]],
 "firm-knowledge:workspace:quality":[["workspace", "room"],["user"]],
 "firm-knowledge:workspace:audience":[["workspace", "room"],["user"]],
 "firm-knowledge:workspace:governance":[["workspace", "room"],["user"]],
 "firm-knowledge:workspace:connections":[["workspace", "room"],["user"]],
 "firm-knowledge:workspace:sop":[["workspace", "room"],["user"]],
 "firm-knowledge:workspace:records":[["workspace", "room"],["user"]]};
const perms = m.permissions || [];
if (perms.length < 1 || perms.length > 50) err(`permissions: 1–50 entries (got ${perms.length})`);
const seenS = new Set(), seenF = new Set();
perms.forEach((p, i) => {
  const c = C[p.scope], t = `permissions.${i} ${p.scope}`;
  if (!c) err(`${t}: unknown scope (PROPOSAL_PERMISSION_UNKNOWN)`);
  else {
    if (!c[0].includes(p.context)) err(`${t}: context ${p.context} not in ${c[0]} (PROPOSAL_PERMISSION_CONTEXT_INVALID)`);
    const need = p.executionContext === "both" ? ["user", "background"] : [p.executionContext];
    if (need.some((x) => !c[1].includes(x))) err(`${t}: executionContext ${p.executionContext} not in ${c[1]} (PROPOSAL_PERMISSION_EXECUTION_INVALID)`);
  }
  if (!["required", "optional"].includes(p.requirement)) err(`${t}: requirement must be required|optional`);
  if (!/^[a-z0-9][a-z0-9._-]{1,127}$/.test(p.feature || "")) err(`${t}: feature "${p.feature}" must match ^[a-z0-9][a-z0-9._-]{1,127}$`);
  if (p.requirement === "optional" && len(p.degradedBehavior) < 10) err(`${t}: optional needs degradedBehavior (10–1000 chars)`);
  if (p.requirement === "required" && p.degradedBehavior) err(`${t}: required must not have degradedBehavior`);
  if (len(p.reason) < 10 || len(p.reason) > 1000) err(`${t}: reason 10–1000 chars`);
  if (seenS.has(p.scope)) err(`${t}: duplicate scope`); seenS.add(p.scope);
  if (seenF.has(p.feature)) err(`${t}: duplicate feature ${p.feature}`); seenF.add(p.feature);
});

console.log(e.length ? e.join("\n") : "OK");
process.exit(e.length ? 1 : 0);

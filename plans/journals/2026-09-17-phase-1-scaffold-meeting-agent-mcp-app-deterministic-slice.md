---
title: Phase 1 scaffold meeting-agent MCP app (deterministic slice)
date: 2026-09-17
summary: Scaffolded ai.privos.meeting-agent Phase 1; green offline; spikes/P2+/deploy gated on live Hub+keys
---

# Phase 1 scaffold meeting-agent MCP app (deterministic slice)

## What happened
Implemented the deterministic slice of Phase 1 (scaffold app foundation) for the
`ai.privos.meeting-agent` PrivOS MCP app from an empty repo, modeled on
`~/projects/genealogy-privos-mcp-app` (server skeleton/scripts) and
`~/projects/privos-mcp-app-demo` (bot-tool-call / app-db patterns).

Built: serveApp wiring + mcp-handler (fail-closed actor gate), typed env, manifest
(4 tools, one `_meta.ui` with permissions+csp), installation-bot Hub layer
(bot-tool-call with optional roomId, app-db-bot-client + ensureAppDbSchema, credential
self-check, app-settings, bootstrap), STT provider interface + workspace/env registry
+ 4 vendor shells, shared app-db schema (7 collections) + cosine + slug, React 18 + Vite
UI shell (rail/topbar/5 screens, vi/en i18n, theme, inline SVG icons), 11 gated spike
scripts + A/B stub, deploy-hodao script, 7 docs. UI shell delegated to a fullstack
subagent; backend reviewed by a code-reviewer subagent.

Gotcha: dev shell has `NODE_ENV=production`, so `npm install` skipped devDeps until
`NODE_ENV=development npm install --include=dev`; run tsc/vitest via `node_modules/.bin/`.

Verified offline (all green): typecheck (ui+server), 21 vitest tests, vite build (single
inline bundle), manifest:lint, preflight.

## Decision
User was told upfront the 11 foundational spikes, `npm run pair`, the A/B default-picker
and the hodao deploy cannot run without a live Hub + bot credential + Soniox/ElevenLabs
keys + audio, and the plan forbids writing Phase 2 before spike-10 resolves. User chose
"full scaffold P1" then "stop at P1". Committed as `6084668`.

Code review (DONE_WITH_CONCERNS) fixes applied: re-keyed fail-closed/boot guards from
`NODE_ENV` to `resolveRuntimeMode().mode` (H1); sourced/aligned tool title+description to
the manifest and added a registry↔manifest parity test (M1); made `setSetting` tolerate a
concurrent unique-key create (M2); cosine encode/decode cleanups (L2/L3).

## Next steps
- Provide a live Hub + bot credential + Soniox/ElevenLabs keys + ≥30 min VN+EN audio, then
  run `scripts/spikes/*` and record results in `docs/system-architecture.md`.
- Resolve placeholders before P2: CSP `<PRIVOS_FILES_ORIGIN>` (spike-03), bot-join tool
  name (spike-06). Do NOT write Phase 2 until spike-10 (SDK API surface) is confirmed.
- `npm run pair` + open tool in a Hub room; then pm2 deploy on hodao.

> Historical work record — not durable authority. Prefer docs/specs/ADRs for current decisions.

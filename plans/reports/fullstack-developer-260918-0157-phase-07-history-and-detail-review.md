# Phase 7 (History + Meeting Detail) + deferred Phase 6 UI — Implementation Report

## Scope executed
- Phase 7 full scope: history screen (1d), meeting detail screen (1c), keyword search, meeting stats, transcript loader, presigned/fallback file download, audio player, virtualized transcript, bookmarks, DOCX/SRT export, speaker relabel wiring, i18n.
- Phase 6 deferred UI: summary-card, action-items-card, save-to-files-modal, send-to-chat-button, action-list-provisioner, action-item-read-model, live-screen/processing-screen wiring, i18n.

## Files created
Data layer (`src/ui/data/`):
- `format-time.ts`, `action-item-read-model.ts`, `action-list-provisioner.ts`, `bookmark-read-model.ts`
- `file-download.ts`, `transcript-loader.ts`, `keyword-search.ts` (+`.test.ts`), `docx-export.ts` (+`.test.ts`), `meeting-stats.ts` (+`.test.ts`), `meeting-export.ts`

Components (`src/ui/components/`):
- `summary-card.tsx`, `action-items-card.tsx`, `save-to-files-modal.tsx`, `send-to-chat-button.tsx`
- `stat-card.tsx`, `filter-chips.tsx`, `status-badge.tsx`, `search-box.tsx`, `meeting-row-menu.tsx`, `meeting-history-row.tsx`
- `audio-player.tsx`, `transcript-line.tsx`, `transcript-view.tsx`, `transcript-toolbar.tsx`, `bookmarks-panel.tsx`
- `meeting-speakers-panel.tsx`, `meeting-detail-actions.tsx` (extra split, not in original file list — keeps `meeting-detail-screen.tsx` under control)

Theme:
- `src/ui/theme/summary.css`, `history.css`, `meeting-detail.css` (repo puts all CSS under `theme/`, not colocated per-screen — followed that existing convention instead of the phase doc's literal `screens/*.css` path).

## Files modified
- `src/ui/data/app-db-client.ts` — added `delete`/`aggregate` (needed for stats + meeting delete; not in phase's original file-ownership list but required by its own Architecture section — `mcpapp.db.aggregate`/`.delete` confirmed against `privos-dev-docs/mcp-app-platform/apis/tools-database.md` and the existing server-side `AppDbBotClient`).
- `src/ui/data/meeting-read-model.ts` — `listMeetings` now paginated (`{meetings,total}`), `renameMeeting`, `deleteMeeting` (best-effort file cleanup + cascade-deleted children via schema `onDelete:'cascade'`), `listSpeakersForMeetings`, `listMeetingIdsWithBookmarks`, `listActionItemCountsForMeetings`, extra fields (`ownerUserId`, `folderId`, `language`, `keyTopics`, `sentToChatAt`).
- `src/ui/screens/history-screen.tsx`, `meeting-detail-screen.tsx` — full rewrite from placeholders.
- `src/ui/screens/processing-screen.tsx` — on job completion: loads the finished meeting, shows `SummaryCard`+`ActionItemsCard`+`SendToChatButton`, auto-opens `SaveToFilesModal` once, "Xem chi tiết" button.
- `src/ui/screens/live-screen.tsx` — side panel's bookmarks tab now lists/deletes live-session bookmarks (`bookmark-read-model.ts`); summary/actions tabs stay "available after end" (no data exists during live recording — accurate, not a placeholder bug).
- `src/ui/app.tsx` — `selectedMeetingId` state, `openMeeting()`, wired History↔Detail↔Processing navigation.
- `src/ui/main.tsx` — imports the 3 new CSS files.
- `src/ui/i18n/vi.json` + `en.json` — full parity, ~95 new keys.
- `docs/design-guidelines.md` — "Ask AI" v1 note (phase-07 step 14).
- `package.json` — added `docx` dependency.

## Deps added
- `docx@^9.7.1` (installed via `NODE_ENV=development npm install --include=dev`). No other deps changed; no Anthropic references introduced.

## Open-question defaults taken (per user directive: plan default + code comment, no live testing)
1. **`file-download.ts` binary fallback** when `downloadUrl` is absent from `GET file-management.files/:fileId` — never exercised against a live Hub; defensive-only branch, documented in the module header.
2. **`save-to-files-modal.tsx` "Open in Files" deep link** — used `privos://files/<folderId>` (mirrors `send-to-chat-tool.ts`'s own best-effort convention); unverified URI scheme, documented in the component header.
3. **`send-to-chat-button.tsx`** — defaults to enabled whenever `bot:message:send` scope + a summary exist (spike P1-6 `mcpapp.bot.getMe` never run); a Hub rejection surfaces inline per "không lỗi im lặng", button re-enabled for retry.
4. **"Ask AI" sparkle toggle** — simplified out; a single keyword search box covers both title/summary (history) and transcript (detail). Documented in `docs/design-guidelines.md`.
5. **History "Của tôi" filter** — `ownerUserId === userId`, matching the phase doc's own instruction to relabel "Chia sẻ với tôi" since no sharing mechanism exists yet.
6. **DOCX `decisions[]`** — always empty. `meeting-job.ts` only persists `payload.summary`/`payload.key_topics` onto `meetings`; decisions live solely in the already-saved `summary.md`, not re-derivable from App DB. Documented in `meeting-export.ts`.
7. **History "week" boundary** — Monday 00:00 local time (spec left the exact convention open).

## Gate status (all run from `/home/roxane/projects/meeting-agent`)
- `node_modules/.bin/tsc -p tsconfig.json --noEmit` — **PASS**
- `node_modules/.bin/tsc -p tsconfig.server.json --noEmit` — **PASS**
- `node_modules/.bin/vitest run` — **PASS** (56 test files, 300 tests; 9 new tests added across keyword-search/meeting-stats/docx-export)
- `npm run build` (vite build + generate-manifest + manifest:lint) — **PASS** (bundle grew to ~1.25MB gzip 354KB due to `docx`; only a size warning, not an error)
- `node scripts/lint-manifest.mjs` — **PASS**
- `NODE_ENV=development node_modules/.bin/tsx scripts/preflight.ts` — **PASS**, process exits cleanly (no orphan on port 3012 confirmed via `ps`)

No dev server, spike, or live Hub pairing was run — static verification only, per directive.

## Not completed / deviations
- `meeting-detail-screen.tsx` is 309 lines, above the ~200-line convention. Already split into `transcript-toolbar.tsx`, `meeting-speakers-panel.tsx`, `meeting-detail-actions.tsx`; remaining size is the genuine data-loading/composition container wiring 9 child pieces (player, transcript, toolbar, 3 side-panel cards, speakers, save modal) — further splitting would fragment cohesive state (meeting/transcript/speakers/bookmarks/action items all cross-reference each other for seek/relabel/reload).
- CSS files placed under `src/ui/theme/*.css` (matching the actual repo convention already established by P1-P6) rather than the phase doc's literal `src/ui/screens/*.css` path.
- No manual "kiểm tay cuộc họp 1h thật" (hand-test on a real 1h meeting) — blocked by the no-pairing/no-dev-server directive; only static gates could run.

Status: DONE
Summary: Full Phase 7 (history + meeting detail) and the deferred Phase 6 UI (summary/action-items/save-to-files/send-to-chat/list-provisioner) are implemented, wired into app.tsx/live-screen/processing-screen, and all 6 verification gates pass green with 300/300 tests.
Concerns/Blockers: Three UI behaviors rest on Hub specifics never observed live (file-download fallback shape, Files deep-link URI scheme, bot send-to-chat availability) — each is defaulted per plan + documented in code; needs a real pairing session to confirm before shipping to hodao.

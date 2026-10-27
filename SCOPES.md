# Permission map

Every permission in `privos-app.json` is listed here with the code that needs it
and what the app does when an optional one is not granted. Backend Hub access
runs as the installation bot (`ServeAppHandlerContext.agentBotHub`), so the bot
must be a member of the room; the UI joins it through `mcpapp.bot.joinCurrentRoom`
before `meeting_bootstrap`.

| Scope | Requirement | Execution | Call sites | Without it |
|---|---|---|---|---|
| `basic:information` | required | both | `src/server/index.ts` (boot credential check, `GET /api/v1/me`), `src/server/tools/bot-credential-check-tool.ts` | — |
| `files:read` | required | both | `src/server/media/hub-file-download.ts` (metadata, list, download of audio parts, transcripts, summaries) | — |
| `files:write` | required | both | `src/server/files/hub-file-upload.ts` (upload merged audio, transcript, summary), `src/server/media/hub-file-download.ts` (delete original audio after processing) | — |
| `db:schema:read` | required | both | `src/server/hub/app-db-bot-client.ts` (`mcpapp.db.getSchema`, `mcpapp.db.listCollections`) | — |
| `db:schema:write` | required | both | `src/server/hub/app-db-bot-client.ts` (register collections in `meeting_bootstrap`) | — |
| `db:read` | required | both | `src/server/hub/app-db-bot-client.ts` (`mcpapp.db.query`, `mcpapp.db.get`); `src/ui/data/app-db-client.ts` (history, detail screens) | — |
| `db:write` | required | both | `src/server/hub/app-db-bot-client.ts` (`mcpapp.db.create/update/delete`: meetings, jobs, encrypted voiceprints, action items, decisions); `src/ui/data/app-db-client.ts` (drafts, bookmarks, action item done/pushed; deleting a meeting deletes its rows) | — |
| `sandbox:generate` | required | user | `src/server/hub/hub-ai-client.ts` (summary, live summary, translation) | — |
| `sandbox:botkey:push` | optional | user | `src/ui/data/sandbox-bot-key.ts` (`agents.sandbox.botKeyStatus`, `agents.sandbox.pushBotKey`) | An admin pushes the bot key manually; Hub AI summary and translation stay unavailable until then |
| `rooms:read` | optional | user | `src/ui/data/room-members.ts` (`groups.members` / `channels.members` for the speaker member picker); `src/ui/data/open-in-files.ts` (`rooms.info`, the room type and name for the **Open in Files** link) | The user types a speaker name instead of picking a member; **Open in Files** assumes a private group named as the host reports it |
| `rooms:roles:read` | optional | user | No API call: the Hub adds the signed `room_roles` / `workspace_roles` claims to the caller's identity; read in `src/server/tools/can-manage-room-settings.ts` (`meeting_settings_set`, full view of `meeting_stt_status`) and `src/server/tools/is-workspace-admin.ts` (admin access to any voiceprint profile) | Nobody can change the room's settings in the app (fail closed); the room keeps its current values or the defaults, and Settings shows them read-only. Workspace admins lose admin access to other people's voiceprints; creators keep access to their own |
| `lists:read` | optional | user | `src/ui/data/action-list-provisioner.ts` (`lists.listByRoomId`, `lists.info`) | The "Push to Smart List" button is hidden |
| `lists:write` | optional | user | `src/ui/data/action-list-provisioner.ts` (`lists.create`, `lists.fields.create`, item create); gated in `src/ui/components/action-items-card.tsx` | The "Push to Smart List" button is hidden |
| `bot:room:join` | optional | user | `src/ui/app.tsx` (`mcpapp.bot.joinCurrentRoom` before `meeting_bootstrap`) | An admin adds the bot to the room; processing pauses until it joins |
| `bot:identity:read` | optional | user | `src/ui/components/send-to-chat-button.tsx` (`mcpapp.bot.getMe`) | A banner explains how to configure the bot credential |
| `bot:message:send` | optional | background | `src/server/tools/send-to-chat-tool.ts` (post the saved summary as the bot); gated in `src/ui/components/send-to-chat-button.tsx` | The "Send to chat" button is hidden |

Reserved environment keys for the bot: `PRIVOS_AGENT_BOT_USER_ID`,
`PRIVOS_AGENT_BOT_CREDENTIAL`. The credential never reaches the iframe or tool
results; `meeting_agent_bot_credential_check` reports only valid/invalid.

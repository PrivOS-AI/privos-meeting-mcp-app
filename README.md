# PrivOS Meeting App

A [PrivOS](https://privos.ai) MCP app for offline meeting capture. It records from the
browser microphone, shows bilingual live captions with speaker labels, recognises
returning speakers across sessions through encrypted voiceprints, summarises the
meeting with Hub AI, and stores audio, transcripts and summaries in the room's
PrivOS Files.

App id: `ai.privos.meeting-agent` · Licence: MIT

## Features

- Live captions in two languages with per-turn speaker labels
- Cross-session speaker identity via encrypted voiceprints (pure Node, no GPU)
- Speech-to-text through Soniox or ElevenLabs, switchable per room from Settings
- Hub AI summaries and exportable transcripts (Markdown, DOCX)
- Everything is written to the room's Files; original audio is deleted after
  processing unless "Keep original audio" is enabled

## Requirements

- Node.js 22 or newer
- A PrivOS workspace where the app can be installed
- At least one speech-to-text API key (Soniox or ElevenLabs)

## Getting started

```bash
git clone https://github.com/PrivOS-AI/privos-meeting-mcp-app.git
cd privos-meeting-mcp-app
npm install
cp .env.example .env
npm run dev
```

The first `npm run dev` walks you through pairing the app with your PrivOS Hub and
stores the resulting credentials in `.env`. Runtime mode (development, standalone
production, or platform-managed) is detected automatically; see `.env.example` for
the variables each mode uses.

Common scripts:

| Command | Purpose |
|---|---|
| `npm run dev` | Run against a Hub over the relay transport with the Vite dev UI |
| `npm run build` | Build the UI and regenerate the app manifest |
| `npm run typecheck` | Type-check client and server |
| `npm test` | Run the Vitest suite |
| `npm run preflight` | Check the environment before a deployment |
| `npm run pair` | Pair a standalone production install with a Hub |

## Data handling

Attendee audio is streamed to the speech-to-text provider selected in Settings.
Transcripts and summaries are processed by Hub AI inside your workspace and stored
in the room's Files. The full data policy is declared in `privos-app.json`.

The voiceprint store is encrypted with `VOICEPRINT_ENC_KEY`. Back that key up:
losing it loses every stored voiceprint.

## Deployment

Operator notes for a standalone production install (pm2, backups, key rotation,
rollback) live in `docs/deployment-guide.md`. `PRIVOS.md` holds the working notes
for contributors and AI coding agents.

## License

MIT, see [LICENSE](LICENSE). Copyright (c) 2026 Roxane, Inc.

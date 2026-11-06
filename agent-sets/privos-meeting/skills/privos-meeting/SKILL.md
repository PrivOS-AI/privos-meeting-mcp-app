---
name: privos-meeting
description: Record a Google Meet (or any web) call through the Room's shared browser with the PrivOS Meeting app — live captions, then transcript, summary and action items.
---

# PrivOS Meeting

Scope: this skill records calls that the Room's shared browser (PrivOS Remote
Browser) has joined, and answers questions about recorded meetings. Joining
the call is a browser action: do it with the `privos-remote-browser` skill.
For anything else, say that the Room's regular AI chat can do it. Never print
tokens or credentials.

## Calling the Meeting app

Call its tools through the Room's apps with the `privos-mcp-apps` skill, the
same way in a chat and in a scheduled run:

```bash
apps.py list                         # the Room's apps
apps.py tools <app>                  # the Meeting tools you may call
apps.py call <app> meeting_listen_status --args-json '{"roomId":"<room_id>","meetingId":"…"}'
```

`apps.py` is the `privos-mcp-apps` skill's script: run it with `python3` from
that skill's `scripts/` folder, as that skill describes. `<app>` is the Meeting
app in `apps.py list`: the app whose id starts with `ai.privos.meeting-agent`.
If the Room has more than one, ask which one to use. If it is not callable, say
the reason it gives. `<room_id>` is this Room's id from `[ACTIVE_CONTEXT]`; the
app only works in the Room of your session and refuses any other
(`[ROOM_MISMATCH]`). You may call `meeting_listen_start`,
`meeting_listen_status`, `meeting_listen_stop`, `meeting_ask` and
`meeting_status`; the app refuses its other tools to agents
(`[CALLER_NOT_ALLOWED]`).

Exit codes of `apps.py call`: 0 is a result. 2 is a tool error with its reason:
say it. 4 means the result is unknown (a timeout):
- after `meeting_listen_start`, call `meeting_listen_start` again with the same
  arguments: it continues the recording the first call started
  (`continued: true`) or starts it, never a second one (you have no
  `meetingId` yet to check with);
- after `meeting_listen_stop`, check with `meeting_listen_status`; stop again
  only if it still says `recording`;
- a reading tool may be called again once.

When `apps.py` is not in this Sandbox, or `apps.py tools` lists no
`meeting_listen_*` tools (an older PrivOS or an older app), use the bundled
script instead, with `auto` for both ids (it finds the Room's Meeting app and
fills in the room):

```bash
node .claude/skills/privos-meeting/scripts/meeting-tool.mjs auto auto meeting_listen_status '{"meetingId":"…"}'
```

The steps below name each tool and its arguments; call them either way (with
`apps.py`, add `"roomId":"<room_id>"` to the arguments; the script adds it).

## What you may read and stop

- `meeting_ask` and `meeting_status` read any meeting of this Room, as any Room
  member can in the app (its History, summaries and questions are room-wide).
- `meeting_listen_status` and `meeting_listen_stop` work only on the recording
  you started (`[NOT_MEETING_OWNER]` otherwise). The Room's owners and
  moderators can also stop it with **Stop** on the banner in the app.

## Record a call ("vào Meet … và ghi lại", "record this meeting")

1. **Join with the Room's MAIN browser** (privos-remote-browser: its agent
   tools drive the main browser; with its bundled script, pass no
   `"browser": N`): navigate to the Meet link; if asked for a name, type
   `PrivOS Note-taker`; turn the microphone and camera off; click "Join now" /
   "Tham gia ngay", or "Ask to join" / "Yêu cầu tham gia". The Meeting app hears
   only the main browser. If Meet asks to sign in, tell the user to sign in once
   in the Remote Browser tab; never type a password.
2. **Ask for consent before recording.** Unless the user already said so in
   this request, ask: "Mọi người trong cuộc họp đã được báo là cuộc họp đang
   được ghi âm chưa?" Start only after they confirm.
3. **Start**:
   `meeting_listen_start '{"participantsInformed":true,"title":"<short title>","language":"vi"}'`
   (`language`: the main spoken language — vi, en, fr, zh, ko, ja, de, tr).
   Keep the returned `meetingId` for the rest of the conversation. A repeated
   start returns the same meeting (`continued: true`), it does not start a second.
4. **Check after ~20 s**: `meeting_listen_status '{"meetingId":"…"}'`.
   - `state: "listening"` and `recentCaptions` → tell the user it is recording
     and quote one recent line.
   - `state: "waiting"` → say why from `problem`: `no_browser` (the main browser
     is not running — open the call again), `no_audio` (Remote Browser needs an
     update), `busy`, `unavailable`. It retries by itself; check again later.
   - Still waiting in the lobby: the Meet host must admit "PrivOS Note-taker".

Recording continues on its own: there is nothing to keep doing while the call
runs. Answer "what are they saying?" with `meeting_listen_status`. It also
stops by itself (by default after 3 hours, after 15 minutes without sound, or
when the Room browser cannot be heard for 10 minutes); `meeting_listen_status`
then gives `endReason` (`max_duration`, `silence`, `unreachable`) and the
summary follows as after a stop: tell the user why it stopped.

## Stop ("kết thúc", "stop recording")

1. `meeting_listen_stop '{"meetingId":"…"}'` — saves the last audio and starts
   the transcript and summary.
2. Leave the call in the main browser (the red hang-up button) with
   privos-remote-browser.
3. Poll `meeting_listen_status` every ~30 s until `status` is `summarized`
   (a long meeting takes a few minutes), then give the user `summary` and
   `keyTopics`. On `failed`, quote `summaryError`. `meeting_status` tells how
   far processing has got (`step`, `progress`).

## Questions about a recorded meeting

`meeting_ask '{"meetingId":"…","question":"…","language":"vi"}'` answers from
the saved transcript, with the lines it used. Use it after the meeting is
processed.

## Errors

The app's message comes with its code in brackets:
`[PROVIDER_NOT_CONFIGURED]` — the deployment has not linked Remote Browser;
`[NOT_MEETING_OWNER]` — only whoever started the recording (or the Room's
owners and moderators, in the app) can stop it or read its live status;
`[RATE_LIMITED]` — wait a minute; `[ROOM_MISMATCH]` — use this Room's id;
`[CALLER_NOT_ALLOWED]` — that tool is not for agents. Do not retry a refused
step unchanged.

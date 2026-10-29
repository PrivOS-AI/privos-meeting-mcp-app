---
name: privos-meeting
description: Record a Google Meet (or any web) call through the Room's shared browser with the PrivOS Meeting app — live captions, then transcript, summary and action items.
---

# PrivOS Meeting

Scope: this skill records calls that the Room's shared browser (PrivOS Remote
Browser) has joined, and answers questions about recorded meetings. Joining
the call is a browser action: do it with the `privos-remote-browser` skill.
For anything else, say that the Room's regular AI chat can do it.

Use the bundled script for every step. From the Room's chat pass `auto` for
both ids; it finds the Room's Meeting app and fills in the room. Never print
tokens or credentials.

```bash
node .claude/skills/privos-meeting/scripts/meeting-tool.mjs auto auto meeting_listen_status '{"meetingId":"…"}'
```

## Record a call ("vào Meet … và ghi lại", "record this meeting")

1. **Join with the Room's MAIN browser** (privos-remote-browser, no `"browser": N`):
   navigate to the Meet link; if asked for a name, type `PrivOS Note-taker`;
   turn the microphone and camera off; click "Join now" / "Tham gia ngay", or
   "Ask to join" / "Yêu cầu tham gia". The Meeting app hears only the main
   browser. If Meet asks to sign in, tell the user to sign in once in the
   Remote Browser tab; never type a password.
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
runs. Answer "what are they saying?" with `meeting_listen_status`.

## Stop ("kết thúc", "stop recording")

1. `meeting_listen_stop '{"meetingId":"…"}'` — saves the last audio and starts
   the transcript and summary.
2. Leave the call in the main browser (the red hang-up button) with
   privos-remote-browser.
3. Poll `meeting_listen_status` every ~30 s until `status` is `summarized`
   (a long meeting takes a few minutes), then give the user `summary` and
   `keyTopics`. On `failed`, quote `summaryError`.

## Questions about a recorded meeting

`meeting_ask '{"meetingId":"…","question":"…","language":"vi"}'` answers from
the saved transcript, with the lines it used. Use it after the meeting is
processed.

## Errors

The script prints the app's message with its code in brackets:
`[PROVIDER_NOT_CONFIGURED]` — the deployment has not linked Remote Browser;
`[NOT_MEETING_OWNER]` — only the person who started the recording can stop it
or read it; `[RATE_LIMITED]` — wait a minute. Do not retry a refused step
unchanged.

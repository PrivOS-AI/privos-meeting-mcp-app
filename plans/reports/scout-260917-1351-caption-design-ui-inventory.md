# Scout report: Meeting Caption design → UI inventory

Source: `resources/Caption application design/Meeting Caption.dc.html` + `_ds/.../colors_and_type.css` + `_ds/.../README.md`. Canvas 1440×900 per screen. Design system = PrivOS "Lean to Scale" (Montserrat 500/600/700, JetBrains Mono, navy #001930 / blue #3C82E6 / gold #FFC814, gold→silver gradient `linear-gradient(160deg,#FFC814 8%,#DCDCDC 78%)`, pill buttons, 4px grid, cool navy shadows, Fluent line icons, NO emoji).

## Screens

| ID | Name | Layout | Key regions |
|----|------|--------|-------------|
| 1a | Live caption — transcript-first, light | grid 64px rail / 60px topbar / 1fr body (1fr + 340px side) / 72px footer | rail nav (mic/history/bookmark/search/settings/avatar), editable title + "17 Sep 2026 · From 09:30 · 4 speakers", Transcript↔Stage toggle, REC dot + timer, transcript lines (avatar initials+color, name, mm:ss, VI text + EN translation, bookmark per line, speaker picker overlay w/ "Add new speaker"/"Rename"), side panel tabs Summary / Action items / Bookmarks, footer controls mic / font-size / bookmark / pause / End & summarize |
| 1b | Live caption — Stage, dark | full-bleed navy, dot texture, 1fr + 340px | 3-layer captions (history 32%/60% opacity, current speaker large 30/38/46px via `stageCaptionSize`, blinking cursor), lang pair + "ElevenLabs Scribe" status, dark side panel, floating blurred control bar, gold gradient "End & summarize" |
| 1c | Meeting detail (after recording) | rail / topbar / 1fr + 380px | breadcrumb History / title, buttons Export SRT/DOCX, Send to Chat room, Share; meta (date, 42 min, speakers, badge "Transcript stored on PrivOS"); audio player w/ scrubber + bookmark ticks + speed; search (keyword vs AI sparkle toggle, hit highlight yellow); filters Speakers, EN+VI; right cards: AI summary (copy, keyword chips), Action items (checkbox, owner, due, "Push to Smart List"), Bookmarks (time + quote) |
| 1d | Meeting history | rail / topbar / full main | "Start recording" gold button; search input w/ Ask-AI toggle (⌘K) + AI answer card w/ source links; stats 4 cards (This week 7, Recorded 5h12m, Open action items 11, Bookmarked 9); filter chips All / Has action items / Bookmarked / Shared with me; sort Newest; table: title+date, speaker avatars, duration mono, actions count, status badge (Summarized green / Processing orange / Private gray), ⋯ menu |
| 1e | Settings | rail / topbar / 240px nav + 760px content | nav: Language & translation, Speech recognition (ElevenLabs), Microphone (browser), Speaker identification, AI summary, Privacy & storage, Caption display; content: primary lang, bilingual toggle + lang; ElevenLabs API key masked + Test + model dropdown + usage 5h12m/50h; mic permission + Test w/ wave anim; Privacy: Keep original audio toggle, auto-delete 90d |

## Data shapes implied by `data-dc-script`
- props: `showTranslation: boolean (true)`, `stageCaptionSize: 'small'|'medium'|'large'`
- state: `{ sec, title, editing: null|'a'|'b'|'c' }`; timer mm:ss, pulse/blink/wave keyframes
- Line: `{ initials, color, name, time, vi, en, marked? }` (search variants viPre/viHit/viPost)
- ActionItem: `{ text, owner, due, at }`
- Meeting row: `{ title, date, people[{i,color}], dur, actions, status, statusColor, statusBg }`
- Speaker palette: #1F9E6F, #E5A800, #38475B, #3C82E6, #2563C9, #6A7584

## Tokens used
bg-canvas #F4F6F8, surface #fff, border-1 #ECEEF1, fg-1 #001930, fg-2 #38475B, fg-3 #6A7584, navy-50 #E6E8EB, dark surface #06223A / raised #0C2A45, status success #1F9E6F/#E4F5EE, warning #E5A800/#FFF6DE, danger #DB4B4B/#FBE7E7, info #3C82E6/#E7F0FD; shadow-lg `0 12px 28px rgba(0,25,48,.14)`; radii 6/10/16/999; overline 11px 600 .14em uppercase; body 15/13/12px.

## Icons (assets/icons)
microphone, microphone-off, history, bookmark, bookmark-add, search, settings, edit, chevron-down, chevron-right, file-text, text-font-size, translate, person-multiple, share, calendar, clock, shield-keyhole, pause, play, record, record-stop, checkmark, checkmark-circle, checkbox-checked/unchecked, arrow-left, arrow-export, arrow-download, chat, filter, copy, sparkle, arrow-up-down, more, globe, volume, bell, bot, document, star, pin, add, lightbulb, alert-circle. Brand: favicon-white/color, logo-white/color.

## Gaps vs. requested scope (must be designed consistently with DS)
1. Speaker identification settings page content (1e nav item exists, no body): voiceprint list per person (PrivOS user or free name), enrol/re-enrol, delete, match threshold.
2. Post-meeting "who is this?" resolution: unknown speaker → assign to PrivOS user / name → save voiceprint.
3. Processing state after End & summarize (diarization + summary + save to PrivOS Files progress) — 1d has "Processing" badge only.
4. Export / "Save to PrivOS Files" confirmation (folder, filenames).
5. Optional upload of pre-recorded audio (not in design; only if scope confirms).
6. New meeting start form (title, language, room) — 1d "Start recording" jumps straight to 1a.
7. Notification bell dropdown, ⋯ row menu contents, theme toggle — minor.

Status: DONE

# Design Guidelines

Bám design export (`resources/Caption application design/`) + PrivOS Design System.

## Tokens

Nguồn: `resources/.../colors_and_type.css` → `src/ui/theme/tokens.css` (bỏ dòng
`@import` Google Fonts vì iframe opaque origin). Lớp alias `--ma-*`:
- Nền: `--ma-bg-canvas:#F4F6F8`, `--ma-surface:#fff`, `--ma-border-1:#ECEEF1`
- Chữ: `--ma-fg-1:#001930`, `--ma-fg-2:#38475B`, `--ma-fg-3:#6A7584`
- Dark surfaces: `#06223A`, `#0C2A45`
- Shadow: `--ma-shadow-lg:0 12px 28px rgba(0,25,48,.14)`; radii 6/10/16/999
- Palette speaker: `#1F9E6F #E5A800 #38475B #3C82E6 #2563C9 #6A7584`

## App shell

Grid: rail trái **64px** / topbar **60px** / body **1fr** / footer auto
(`app-shell.css`). Light/dark theo `usePrivosContext().theme` qua `theme-provider.tsx`
(`[data-theme]` trên `:root`).

## Fonts

Montserrat (body) + JetBrains Mono (mono) — **KHÔNG** link Google Fonts. Dùng
fallback stack (`Montserrat, system-ui, sans-serif` / `JetBrains Mono, ui-monospace,
monospace`); nhúng woff2 base64 nếu cần đúng brand (ghi lại nếu chấp nhận fallback).

## Icons

45 icon SVG ở `src/ui/assets/icons/`, render **inline** qua `components/icon.tsx`
(`import.meta.glob('...*.svg', {query:'?raw', eager:true})`) — không fetch asset anh em.
**KHÔNG dùng emoji** làm icon.

## i18n

`vi` mặc định, `en` fallback; mọi chuỗi UI qua `t()`. Ngôn ngữ mở đầu: lựa chọn đã lưu
→ `navigator.language` → `vi`.

## Settings (P8, 5 màn bổ sung ngoài design gốc)

Design export chỉ phác thảo khung Settings; 5 trong 7 panel (Speech recognition,
Microphone, AI summary, Privacy & storage, Caption display) không có mock chi
tiết — dựng theo layout nav 240px + nội dung 720px chung của `1e` và tokens
hiện có (`ma-settings-*` trong `theme/settings.css`), KHÔNG thêm token/màu mới.
Language & translation và Speaker identification (P4) theo đúng mock. QĐ-08:
không panel nào có ô nhập API key; provider STT chỉ có select + bảng trạng thái
đọc từ `meeting_stt_status`.

## Search — "Ask AI" v1 (P7)

Design gốc có ô search kèm toggle sparkle "Ask AI". **v1 không gọi LLM**: search là
keyword thuần trên `title` + `summaryText` (history, `keyword-search.ts#searchMeetings`)
và trên `segment.text` (meeting detail, `#searchTranscript`), bỏ dấu tiếng Việt bằng
`foldDiacritics`. `search-box.tsx` triển khai ở P7 **không** render riêng toggle
sparkle — một ô tìm kiếm duy nhất đã phủ cả hai nguồn (title/summary hoặc transcript)
nên không có "chế độ AI" thứ hai để bật/tắt. RAG thực thụ (semantic search có gọi Hub
AI) là v2, chưa lên kế hoạch.

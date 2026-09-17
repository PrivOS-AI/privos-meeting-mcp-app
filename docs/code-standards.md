# Code Standards

- **TypeScript strict** (`noUnusedLocals`/`noUnusedParameters`, `moduleResolution: bundler`).
  Relative imports use `.js` extensions (matches SDK/genealogy convention).
- **Two tsconfigs**: `tsconfig.json` (ui + shared, DOM libs), `tsconfig.server.json`
  (server + shared + scripts, node). `npm run typecheck` runs both.
- **KISS / DRY.** File > ~200 LOC → cân nhắc tách module (trừ CSS/JSON/markdown).
  Kebab-case cho tên file `.ts/.tsx`.
- **Secrets** chỉ ở env backend (`.env` 0600). Không log/echo/return credential,
  token, hay vector voiceprint. Iframe không bao giờ nhận API key hay embedding.
- **App DB writes** (job/voiceprint/settings) chỉ qua tool backend (bot credential).
  Iframe chỉ `query/get/count` để hiển thị.
- **Errors**: ném `AppError` với thông điệp tiếng Việt an toàn cho người dùng; lỗi
  không lường trước không lộ nội bộ.
- **Manifest là hợp đồng**: mọi tool phải khai trong `privos-app.json` + registry;
  `npm run manifest:lint` + `preflight` phải xanh. `name/version/title/description/
  repository` đồng bộ giữa `package.json` và `privos-app.json`.
- **No emoji** trong UI (icon = inline SVG). Không link Google Fonts (opaque origin).
- **Tests**: vitest, `*.test.ts(x)`. Chạy test hẹp trước, mở rộng khi đổi contract chung.

# Prompt cho phía Hub — hỗ trợ `screen-wake-lock` cho iframe MCP app

Dùng trong session Claude Code tại `~/projects/privos-hub` (branch `privos-mt`). Copy nguyên khối dưới.

---

Repo: `~/projects/privos-hub` (Rocket.Chat/Meteor fork, TypeScript). Không chạy Hub, chỉ sửa code + test + docs.

## Bối cảnh
MCP app "meeting-agent" ghi âm cuộc họp trong iframe MCP app của Hub và cần gọi Screen Wake Lock API (`navigator.wakeLock.request('screen')`) để màn hình không tắt/sleep trong lúc ghi. Iframe MCP app là `srcdoc` sandbox không `allow-same-origin` (opaque origin), nên Wake Lock chỉ chạy khi thẻ `<iframe>` có Permissions-Policy `allow="screen-wake-lock"`. Hiện Hub chỉ cấp `camera`/`microphone`.

## Hiện trạng đã đọc
- `apps/meteor/client/views/room/mcp-apps/use-mcp-bridge-host.ts:193-198` — `buildSandboxAttrs(permissions)` chỉ nhận `'camera'` và `'microphone'`; deny-by-default, không bao giờ thêm `allow-same-origin` (phải giữ nguyên bất biến này).
- `apps/meteor/client/views/room/mcp-apps/McpAppTab.tsx:302-303` và `:361-362` — iframe với `sandbox={MCP_APP_TAB_SANDBOX}` và **`allow='camera; microphone'` hardcode**; `:334-337` dùng `allow={embedAllowAttribute([], app?.embedPolicy)}`.
- `apps/meteor/client/views/room/mcp-apps/McpAppHost.tsx:160-162` — `sandbox={buildSandboxAttrs()}`, `allow={embedAllowAttribute([], app?.embedPolicy)}`.
- `apps/meteor/client/views/room/mcp-apps/mcp-embed-overlay-host.tsx:133-134` — `sandbox={HOISTED_FRAME_SANDBOX}`, `allow={embed.allow}`.
- Spec: `apps/meteor/client/views/room/mcp-apps/use-mcp-bridge-host.spec.ts:17-28,78`.
- Docs: `~/projects/privos-dev-docs/mcp-app-platform/security-and-data-model.md:18` ("camera/microphone only granted if declared in `_meta.ui.permissions`"), `developer-guide.md:47`.
- Manifest tool: `tools[].._meta.ui.permissions: string[]` (ví dụ meeting-agent khai `["microphone", "screen-wake-lock"]`).

## Yêu cầu
1. **Thêm `screen-wake-lock` vào tập permission hợp lệ của `_meta.ui.permissions`** ở mọi lớp: (a) validator/schema manifest phía server (tìm nơi Hub parse `_meta.ui` của tool — grep `permissions` trong `apps/meteor/server/services/mcp*` và schema manifest), (b) lint CLI `privos-app` trong `~/projects/privos-app-packages` nếu có allowlist, (c) client `buildSandboxAttrs`/`embedAllowAttribute`.
2. **Truyền permission đã khai vào thuộc tính `allow` của iframe** (Permissions-Policy), không phải chỉ `sandbox`: `screen-wake-lock` là feature của Permissions-Policy, không có sandbox token tương ứng. Sửa để `allow` được **dựng từ `_meta.ui.permissions` đã duyệt** thay vì hardcode `'camera; microphone'` (McpAppTab.tsx:303, :362) — giữ hành vi cũ cho app chỉ khai camera/microphone. Áp dụng nhất quán cho 4 chỗ render: McpAppTab (3 iframe), McpAppHost, mcp-embed-overlay-host (`embed.allow`).
3. **Không nới sandbox**: vẫn không `allow-same-origin`; `assertNoSameOrigin` giữ nguyên. Nếu `buildSandboxAttrs` hiện sinh token không chuẩn (`allow-camera`, `allow-microphone` không phải sandbox token hợp lệ) thì ghi chú trong PR, không đổi hành vi ngoài phạm vi trừ khi cần để `allow` hoạt động.
4. **Kiểm tra Permissions-Policy ở document cha**: nếu Hub đặt header `Permissions-Policy` (grep `Permissions-Policy` / `Feature-Policy` trong `apps/meteor/server`, `apps/meteor/app/api`, nginx/helm config trong repo), phải cho phép `screen-wake-lock=(self)` ở top-level, nếu không `allow` trên iframe vô hiệu.
5. **Tests**: mở rộng `use-mcp-bridge-host.spec.ts` — `buildSandboxAttrs(['screen-wake-lock'])` không thêm `allow-same-origin`; hàm dựng `allow` trả `"camera; microphone; screen-wake-lock"` khi khai đủ ba, và chỉ những gì được khai; app không khai gì → `allow` rỗng hoặc như trước. Thêm test cho validator server từ chối giá trị lạ (`"geolocation"`) nhưng chấp nhận `"screen-wake-lock"`.
6. **Docs**: cập nhật `security-and-data-model.md:18` và `developer-guide.md:47` trong `~/projects/privos-dev-docs` liệt kê tập permission hợp lệ: `camera`, `microphone`, `screen-wake-lock`, kèm câu: "Wake Lock chỉ có tác dụng khi document cha cũng cho phép; app phải xin trong user gesture và xin lại sau `visibilitychange`".
7. **Tương thích ngược**: app cũ không khai `permissions` → hành vi y hệt hiện tại. Không yêu cầu re-pair app đang cài; ghi rõ trong PR nếu thay đổi cần admin duyệt lại permission ceiling.

## Nghiệm thu
- `yarn lint` + unit test của thư mục `mcp-apps` xanh.
- Test tay: cài một app có `_meta.ui.permissions: ["microphone","screen-wake-lock"]`; trong iframe chạy `await navigator.wakeLock.request('screen')` sau click → resolve, `sentinel.released === false`; app không khai `screen-wake-lock` → `NotAllowedError`. Kiểm bằng DevTools → Application → Frames → Permissions Policy của iframe có `screen-wake-lock: allowed`.
- Không có iframe MCP nào nhận `allow-same-origin`.

## Đầu ra
- Diff gọn, conventional commit `feat(mcp-apps): allow screen-wake-lock permission for app iframes`.
- Tóm tắt các file sửa, cách `_meta.ui.permissions` chảy từ manifest → server validate → client `allow`, và mọi nơi bạn phát hiện hardcode hoặc allowlist khác chưa cập nhật.
- Liệt kê câu hỏi chưa giải quyết ở cuối (ví dụ: `embedAllowAttribute` định nghĩa ở đâu, `embed.allow` của overlay do ai cung cấp, header Permissions-Policy có tồn tại không).

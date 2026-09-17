---
name: meeting-agent-plan-file-conventions
description: Conventions for the Meeting Agent plan files — Vietnamese prose with English identifiers, hard line caps, frontmatter keys, and a trailing whole-plan consistency sweep
metadata:
  type: project
---

Kế hoạch Meeting Agent (`plans/260917-1358-meeting-agent-mcp-app-elevenlabs-diarization-voice-fingerprint/`) theo quy ước:

- **Văn xuôi tiếng Việt, định danh tiếng Anh** (tên file/hàm/tool/env giữ nguyên tiếng Anh).
- **Trần độ dài cứng: mỗi file ≤ 260 dòng** (plan.md và mọi phase). Sửa xong phải `wc -l` và nén lại nếu vượt — thường nén bằng cách đổi code block dài thành một đoạn văn mô tả, hoặc gộp các dòng danh sách file.
- Frontmatter phase: `phase, title, status, priority, effort, dependencies`. `title` phải khớp `# Phase N: …` ở đầu thân file.
- Mỗi phase theo bố cục: Overview · Requirements · Architecture · Related Code Files (Create/Modify/Delete) · Implementation Steps · Todo · Success Criteria · Risk Assessment.
- plan.md kết thúc bằng `## Red Team Review` + `### Whole-Plan Consistency Sweep` — **mỗi lần đổi kiến trúc phải thêm một đoạn sweep** liệt kê định danh đã bị loại khỏi toàn bộ file, và nêu rõ những lần nhắc tới **có chủ đích** còn lại (tiêu chí fallback, lịch sử audit, tài liệu tham khảo).
- Tên thư mục plan **không** đổi theo kiến trúc (vẫn còn chữ `elevenlabs`) — slug ở cuối plan.md là mỏ neo, đừng đổi tên thư mục.

**Why:** người dùng đọc plan trực tiếp, file dài quá thì mất tác dụng; sweep là cách duy nhất bắt được định danh chết sau khi đổi vendor.

**How to apply:** khi sửa bất kỳ file nào trong plan này, chạy `grep -rn` cho định danh cũ trên cả 9 file rồi cập nhật đoạn sweep, và kiểm `wc -l` trước khi kết thúc.

Xem [[meeting-agent-soniox-switch]].

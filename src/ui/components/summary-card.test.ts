import { describe, expect, it } from 'vitest';

import { withoutRepeatedTitle } from './summary-card.js';

describe('withoutRepeatedTitle', () => {
  it('drops a first heading that repeats the card title', () => {
    expect(withoutRepeatedTitle('## Tóm tắt\nNhóm thống nhất phát hành.', 'Tóm tắt')).toBe('Nhóm thống nhất phát hành.');
    expect(withoutRepeatedTitle('# Summary\n\nWe ship on Friday.', 'Tóm tắt')).toBe('We ship on Friday.');
  });

  it('keeps any other first line', () => {
    expect(withoutRepeatedTitle('## Quyết định\n- Phát hành', 'Tóm tắt')).toBe('## Quyết định\n- Phát hành');
    expect(withoutRepeatedTitle('Tóm tắt nhanh: phát hành thứ Sáu', 'Tóm tắt')).toBe('Tóm tắt nhanh: phát hành thứ Sáu');
  });
});

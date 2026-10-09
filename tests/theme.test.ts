import { describe, expect, it } from 'vitest';
import { tokenColor, vivid } from '../src/renderer/core/theme';

const HEX = /^#[0-9a-f]{6}$/i;

describe('tokenColor', () => {
  it('известный токен даёт цвет-HEX', () => {
    expect(tokenColor('dark', 'keyword')).toMatch(HEX);
    expect(tokenColor('light', 'keyword')).toMatch(HEX);
  });

  it('частное правило важнее общего', () => {
    // keyword.control красится иначе, чем keyword.
    expect(tokenColor('dark', 'keyword.control')).not.toBe(tokenColor('dark', 'keyword'));
  });

  it('токен с уточнением использует правило родителя', () => {
    // string.escape и string — один ключ палитры.
    expect(tokenColor('dark', 'string.escape')).toBe(tokenColor('dark', 'string'));
  });

  it('неизвестный токен → null (цвет текста по умолчанию)', () => {
    expect(tokenColor('dark', 'operator.weird')).toBeNull();
    expect(tokenColor('dark', '')).toBeNull();
  });

  it('тёмная и светлая схемы дают разные цвета', () => {
    expect(tokenColor('dark', 'keyword')).not.toBe(tokenColor('light', 'keyword'));
  });
});

describe('vivid', () => {
  it('возвращает корректный HEX (вход — без решётки)', () => {
    expect(vivid('569cd6', 'dark')).toMatch(HEX);
    expect(vivid('0000ff', 'light')).toMatch(HEX);
  });

  it('цвет не остаётся прежним (сдвиг есть)', () => {
    expect(vivid('569cd6', 'dark')).not.toBe('#569cd6');
    expect(vivid('569cd6', 'dark').slice(1)).not.toBe('569cd6');
  });
});

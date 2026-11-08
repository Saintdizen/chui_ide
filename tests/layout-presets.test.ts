import { describe, expect, it } from 'vitest';
import { DEFAULT_LAYOUT } from '../src/shared/api/settings';
import { dropLayout, findLayout, sanitizePresets, saveLayout } from '../src/shared/layout-presets';

/**
 * Именованные раскладки. Главное, что ломается: «сохранил под тем же
 * именем» должно заменять, а не плодить двойников; кривая запись из файла
 * настроек не должна ронять меню целиком.
 */
const wide = { ...DEFAULT_LAYOUT, sidebarSize: 400, editorVisible: false };

describe('saveLayout', () => {
  it('добавляет новую', () => {
    expect(saveLayout([], 'дебаг', wide).map((entry) => entry.name)).toEqual(['дебаг']);
  });

  it('то же имя — заменяет, а не дублирует', () => {
    const once = saveLayout([], 'дебаг', DEFAULT_LAYOUT);
    const twice = saveLayout(once, 'дебаг', wide);
    expect(twice).toHaveLength(1);
    expect(twice[0]!.layout.sidebarSize).toBe(400);
  });

  it('имя обрезается по краям', () => {
    expect(saveLayout([], '  дебаг  ', wide)[0]!.name).toBe('дебаг');
  });

  it('пустое имя отбрасывается: пункт без имени не выбрать', () => {
    expect(saveLayout([], '   ', wide)).toEqual([]);
  });

  it('чужая раскладка не меняется', () => {
    const list = saveLayout([], 'ревизия', DEFAULT_LAYOUT);
    saveLayout(list, 'дебаг', wide);
    expect(list).toHaveLength(1);
  });
});

describe('dropLayout и findLayout', () => {
  it('удаляет по имени и не трогает остальные', () => {
    const list = saveLayout(saveLayout([], 'a', wide), 'b', DEFAULT_LAYOUT);
    expect(dropLayout(list, 'a').map((entry) => entry.name)).toEqual(['b']);
  });

  it('нет такой — список тот же (не пустой)', () => {
    const list = saveLayout([], 'a', wide);
    expect(dropLayout(list, 'b')).toHaveLength(1);
  });

  it('находит раскладку', () => {
    expect(findLayout(saveLayout([], 'дебаг', wide), 'дебаг')?.sidebarSize).toBe(400);
    expect(findLayout(saveLayout([], 'дебаг', wide), 'нет')).toBeNull();
  });
});

describe('sanitizePresets', () => {
  it('кривые записи выбрасываются, целые остаются', () => {
    const raw = [
      { name: 'дебаг', layout: wide },
      { name: '', layout: wide },
      { name: 'без раскладки' },
      null,
      'строка',
    ];
    expect(sanitizePresets(raw).map((entry) => entry.name)).toEqual(['дебаг']);
  });

  it('двойник по имени остаётся один', () => {
    const raw = [
      { name: 'a', layout: wide },
      { name: 'a', layout: DEFAULT_LAYOUT },
    ];
    const result = sanitizePresets(raw);
    expect(result).toHaveLength(1);
    // Побеждает первый: второй — скорее остатки прошлой записи.
    expect(result[0]!.layout.sidebarSize).toBe(400);
  });

  it('не массив — пусто, без падения', () => {
    expect(sanitizePresets(undefined)).toEqual([]);
    expect(sanitizePresets({ name: 'a' })).toEqual([]);
  });

  it('раскладка доводится до полной', () => {
    const [entry] = sanitizePresets([{ name: 'a', layout: { sidebarSize: 300 } }]);
    expect(entry!.layout.editorVisible).toBe(DEFAULT_LAYOUT.editorVisible);
  });
});

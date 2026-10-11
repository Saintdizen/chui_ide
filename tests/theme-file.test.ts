import { afterEach, describe, expect, it } from 'vitest';
import {
  CHROME_KEYS,
  TOKEN_KEYS,
  parseThemeFile,
  serializeThemeFile,
  sanitizeThemeFile,
} from '../src/shared/theme-file';
import {
  buildTheme,
  setThemeOverrides,
  themeCssVariables,
  themeTemplate,
  tokenColor,
} from '../src/renderer/core/theme';

afterEach(() => {
  // Переопределения — состояние модуля: тесты не должны влиять друг на друга.
  setThemeOverrides(null);
});

describe('parseThemeFile', () => {
  it('принимает частичную тему и нормализует цвета', () => {
    const result = parseThemeFile(
      JSON.stringify({
        name: '  Моя тема  ',
        scheme: 'dark',
        chrome: { background: '#ABC', text: '#FFEEDDCC' },
        tokens: { keyword: '#FF00AA' },
      }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.name).toBe('Моя тема');
    expect(result.theme.scheme).toBe('dark');
    // #ABC разворачивается в #AABBCC, регистр приводится к нижнему.
    expect(result.theme.chrome.background).toBe('#aabbcc');
    expect(result.theme.chrome.text).toBe('#ffeeddcc');
    expect(result.theme.tokens.keyword).toBe('#ff00aa');
  });

  it('незаданные роли остаются пустыми: тема частичная', () => {
    const result = parseThemeFile(JSON.stringify({ name: 'X', scheme: 'light', chrome: { background: '#ffffff' } }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.theme.chrome.background).toBe('#ffffff');
    expect(result.theme.chrome.accent).toBeUndefined();
    expect(result.theme.tokens).toEqual({});
  });

  it('требует имя', () => {
    const result = parseThemeFile(JSON.stringify({ scheme: 'dark' }));
    expect(result).toEqual({ ok: false, error: 'не задано имя темы («name»)' });
  });

  it('знает только две схемы', () => {
    const result = parseThemeFile(JSON.stringify({ name: 'X', scheme: 'sepia' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('scheme');
  });

  it('ловит опечатку в имени роли', () => {
    const result = parseThemeFile(JSON.stringify({ name: 'X', scheme: 'dark', chrome: { bg: '#000000' } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('chrome.bg');
  });

  it('ловит не-цвет', () => {
    const result = parseThemeFile(JSON.stringify({ name: 'X', scheme: 'dark', tokens: { keyword: 'not-a-color' } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toContain('tokens.keyword');
  });

  it('не-объект и битый JSON — понятная ошибка', () => {
    expect(parseThemeFile('[]')).toEqual({ ok: false, error: 'тема — это объект JSON' });
    expect(parseThemeFile('{ не json')).toEqual({ ok: false, error: 'файл не читается как JSON' });
  });
});

describe('sanitizeThemeFile', () => {
  it('null и мусор читает как «темы нет»', () => {
    expect(sanitizeThemeFile(null)).toBeNull();
    expect(sanitizeThemeFile(undefined)).toBeNull();
    expect(sanitizeThemeFile({ name: 'X' })).toBeNull();
    expect(sanitizeThemeFile('строка')).toBeNull();
  });

  it('корректную тему возвращает', () => {
    const theme = sanitizeThemeFile({ name: 'X', scheme: 'dark', chrome: { background: '#012' } });
    expect(theme?.chrome.background).toBe('#001122');
  });
});

describe('serializeThemeFile', () => {
  it('переживает круг «сохранить → прочитать»', () => {
    const theme = parseThemeFile(JSON.stringify({ name: 'Круг', scheme: 'dark', tokens: { comment: '#123456' } }));
    expect(theme.ok).toBe(true);
    if (!theme.ok) return;
    const back = parseThemeFile(serializeThemeFile(theme.theme));
    expect(back.ok).toBe(true);
    if (!back.ok) return;
    expect(back.theme).toEqual(theme.theme);
  });
});

describe('ключи ролей совпадают с палитрой', () => {
  it('шаблон покрывает ровно объявленные роли', () => {
    const template = themeTemplate('dark');
    expect(Object.keys(template.chrome).sort()).toEqual([...CHROME_KEYS].sort());
    expect(Object.keys(template.tokens).sort()).toEqual([...TOKEN_KEYS].sort());
  });

  it('значения шаблона — цвета с решёткой', () => {
    const template = themeTemplate('light');
    for (const value of Object.values(template.chrome)) expect(value).toMatch(/^#[0-9a-f]{6,8}$/i);
    for (const value of Object.values(template.tokens)) expect(value).toMatch(/^#[0-9a-f]{6,8}$/i);
  });
});

describe('setThemeOverrides', () => {
  it('переопределяет цвет токена и фон редактора, а снятие возвращает встроенное', () => {
    const before = tokenColor('dark', 'keyword');
    setThemeOverrides({
      name: 'X',
      scheme: 'dark',
      chrome: { background: '#000000' },
      tokens: { keyword: '#ab12cd' },
    });

    expect(tokenColor('dark', 'keyword')).toBe('#ab12cd');
    expect(buildTheme('dark').colors!['editor.background']).toBe('#000000');

    setThemeOverrides(null);
    expect(tokenColor('dark', 'keyword')).toBe(before);
    expect(buildTheme('dark').colors!['editor.background']).not.toBe('#000000');
  });
});

describe('themeCssVariables', () => {
  it('отдаёт CSS-переменные обвязки с решёткой', () => {
    const vars = themeCssVariables('dark');
    expect(vars['--text_color']).toMatch(/^#/);
    expect(vars['--editor_background']).toMatch(/^#/);
    expect(vars['--blue_prime_background']).toMatch(/^#/);
    expect(vars['--popup_background']).toMatch(/^#/);
  });

  it('учитывает переопределения темы из файла', () => {
    setThemeOverrides({ name: 'X', scheme: 'dark', chrome: { background: '#101418' }, tokens: {} });
    expect(themeCssVariables('dark')['--editor_background']).toBe('#101418');
    expect(themeCssVariables('dark')['--main_background']).toBe('#101418');
  });
});

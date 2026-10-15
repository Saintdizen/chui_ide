import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { COMPONENT_PARTS, readMainCss, readStyle } from './style-files';

/**
 * Страж палитры и шкал: значения живут в `theme.css`, а правила берут их токенами.
 *
 *   • цвет — только `var(--…)` из палитры. Своё число в правиле не меняется вместе
 *     со схемой и выпадает из неё: на светлой теме остаётся тёмный оттенок;
 *   • скругление и кегль — ступени шкалы, а не числа «на глаз»: `4px` в одном месте
 *     и `5px` в соседнем — это не решение, а следы правок;
 *   • у волнистого подчёркивания цвет волны нарисован картинкой (в data URI
 *     переменную не подставить), поэтому там число — и оно обязано совпадать с
 *     токеном `--severity_*`, иначе значок в панели проблем разойдётся с линией в
 *     тексте.
 *
 * Исключения, которые сторож знает и пропускает: `#000` в масках (там это не цвет, а
 * «непрозрачно»), запасное значение внутри `var(--…, #hex)` и `inherit`.
 */

const STYLES = resolve(process.cwd(), 'src/renderer/styles');
const THEME = readFileSync(resolve(STYLES, 'theme.css'), 'utf8');
/** Компоненты: их правила обязаны брать цвета и шкалы из палитры. */
const COMPONENTS = COMPONENT_PARTS.map((name) => ({ name, css: readStyle(name) }));

/** Правила без комментариев: в пояснениях числа и оттенки — это нормально. */
function rulesOnly(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('цвета берутся из палитры', () => {
  /** Свойства, которые что-то красят: в масках и градиентах цвета ищут другое. */
  const PAINT = ['color', 'background', 'background-color', 'border-color', 'border-top-color', 'fill', 'stroke'];

  it('в правилах компонентов нет своих hex-цветов', () => {
    const offenders: string[] = [];
    for (const { name, css } of COMPONENTS) {
      for (const [whole, property, value] of rulesOnly(css).matchAll(
        /(^|[\s;{])(color|background|background-color|border-color|border-top-color|fill|stroke)\s*:\s*([^;}]+)/g,
      )) {
        void whole;
        if (!PAINT.includes(property ?? '')) continue;
        const text = value ?? '';
        // Картинка (data URI) и запасное значение `var(--token, #hex)` — не свой цвет.
        if (text.includes('url(')) continue;
        if (/var\([^)]*,/.test(text)) continue;
        for (const hex of text.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) offenders.push(`${name}: ${property}: ${hex[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('в масках `#000` — это не цвет, сторож его не считает', () => {
    // Маска берёт прозрачность, а не оттенок: `#000` там значит «непрозрачно».
    const MAIN = rulesOnly(readMainCss());
    expect(MAIN).toMatch(/mask-image:[^;]*#000/);
  });
});

describe('шкалы скруглений и кеглей — без чисел по правилам', () => {
  it('скругление задаётся ступенью, а не числом в px', () => {
    const offenders: string[] = [];
    for (const { name, css } of COMPONENTS) {
      for (const [, value] of rulesOnly(css).matchAll(/border-radius\s*:\s*([^;}]+)/g)) {
        const text = (value ?? '').trim();
        // `0` — это «снять скругление», а не ступень.
        if (text === '0') continue;
        if (/^\d+(?:\.\d+)?px$/.test(text)) offenders.push(`${name}: ${text}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('кегль — ступень шкалы (`px` встречается только в самой шкале)', () => {
    const offenders: string[] = [];
    for (const { name, css } of COMPONENTS) {
      for (const [, value] of rulesOnly(css).matchAll(/font-size\s*:\s*([^;}]+)/g)) {
        const text = (value ?? '').trim();
        if (/^\d+(?:\.\d+)?px$/.test(text)) offenders.push(`${name}: ${text}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('палитра держит шкалы целиком', () => {
  it('в theme.css объявлены ступени скруглений и кеглей', () => {
    for (const token of [
      '--radius_2xs:',
      '--radius_xs:',
      '--radius_sm:',
      '--radius_md:',
      '--radius_pill:',
      '--radius_circle:',
      '--font_micro_size:',
      '--font_small_size:',
      '--font_labels_size:',
      '--font_default_size:',
      '--font_display_size:',
    ]) {
      expect(THEME, token).toContain(token);
    }
  });

  it('цвета серьёзности пометки объявлены в палитре', () => {
    for (const token of ['--severity_error:', '--severity_warning:', '--severity_info:']) {
      expect(THEME, token).toContain(token);
    }
  });
});

describe('волна пометки совпадает с цветом серьёзности', () => {
  const EDITOR = readFileSync(resolve(STYLES, 'editor.css'), 'utf8');

  /** Оттенок токена без решётки: в data URI он записан как `%23rrggbb`. */
  function tokenHex(name: string): string {
    const match = THEME.match(new RegExp(`${name}:\\s*#([0-9a-fA-F]{6})`));
    expect(match, name).not.toBeNull();
    return match![1]!.toLowerCase();
  }

  it('волна ошибки, предупреждения и подсказки — того же цвета, что токены', () => {
    for (const [suffix, token] of [
      ['is-error', '--severity_error'],
      ['is-warning', '--severity_warning'],
      ['is-info', '--severity_info'],
    ] as const) {
      const rule = EDITOR.match(new RegExp(`\\.own-editor-squiggly-rect\\.${suffix}\\s*\\{([^}]*)\\}`))?.[1] ?? '';
      expect(rule, suffix).toContain(`%23${tokenHex(token)}`);
    }
  });
});

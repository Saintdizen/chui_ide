import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MONACO_THEMES, tokenColor, tokenStyle, vivid } from '../src/renderer/core/theme';
import { WINDOW_BACKGROUND } from '../src/shared/colors';

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

  it('роль function окрашена и отличается от идентификатора', () => {
    // В VS Code Dark+ функции — жёлтые (#DCDCAA), идентификаторы — голубые.
    expect(tokenColor('dark', 'function')).toMatch(HEX);
    expect(tokenColor('dark', 'function')).not.toBe(tokenColor('dark', 'identifier'));
    expect(tokenColor('light', 'function')).not.toBe(tokenColor('light', 'identifier'));
  });

  it('роль variable окрашена как идентификатор', () => {
    // Своей краски у переменных в VS Code нет — тот же цвет, но правило нужно:
    // иначе `variable` из грамматик Makefile/shell остаётся неокрашенным.
    expect(tokenColor('dark', 'variable')).toMatch(HEX);
    expect(tokenColor('dark', 'variable')).toBe(tokenColor('dark', 'identifier'));
    expect(tokenColor('dark', 'variable.parameter')).toBe(tokenColor('dark', 'identifier'));
  });
});

/* ── Подсветка читается без цвета ───────────────────────────────────────── */

/**
 * Не полагайтесь на цвет как на единственный носитель смысла. Для кода это
 * значит, что часть ролей различается ещё и начертанием: если сделать тему в
 * оттенках серого, комментарий и ключевое слово всё равно отличаются от обычного
 * текста. Сторож держит этот контракт: правила без нецветового признака падают.
 * Сам список начертаний живёт в `TOKEN_RULES` рядом с цветом — одна таблица.
 */
describe('подсветка различает роли и без цвета', () => {
  it('комментарий — курсив, ключевое слово — полужирное', () => {
    expect(tokenStyle('dark', 'comment').italic).toBe(true);
    expect(tokenStyle('light', 'comment').italic).toBe(true);
    expect(tokenStyle('dark', 'keyword').bold).toBe(true);
    expect(tokenStyle('light', 'keyword').bold).toBe(true);
    // Управляющие конструкции — тоже ключевые слова.
    expect(tokenStyle('dark', 'keyword.control').bold).toBe(true);
  });

  it('начертание не мешает цвету: обе части оформления на месте', () => {
    const style = tokenStyle('dark', 'keyword');
    expect(style.color).toMatch(HEX);
    expect(style.bold).toBe(true);
    // Оформление и цвет берутся из одного правила — цвет совпадает с tokenColor.
    expect(style.color).toBe(tokenColor('dark', 'keyword'));
  });

  it('токен без правила — без оформления', () => {
    expect(tokenStyle('dark', 'operator.weird')).toEqual({ color: null, italic: false, bold: false });
  });
});

/* ── Контраст палитры КОДА (WCAG AA) ────────────────────────────────────── */

/**
 * Тот же порог 4.5:1, что и для интерфейса, применяем к подсветке кода: код —
 * обычный текст, а «слишком бледные комментарии — ошибка». Сторож проверяет
 * каждую роль палитры на полотне редактора, поэтому
 * правка цвета, уводящая токен ниже нормы, падает здесь.
 *
 * Полотно берём как реальный фон: в тёмной схеме — `--editor_background`,
 * в светлой — тоже (он белый). Токены без цвета (операторы, разделители)
 * наследуют цвет текста и не проверяются: список типов ниже — те, у которых
 * есть своё правило в `TOKEN_RULES`.
 */
const CODE_TOKEN_TYPES: readonly string[] = [
  'comment',
  'string',
  'string.escape',
  'number',
  'keyword',
  'keyword.control',
  'identifier',
  'function',
  'type',
  'constant',
  'tag',
  'attribute.name',
  'variable',
];

describe('контраст подсветки кода (WCAG AA)', () => {
  for (const scheme of ['dark', 'light'] as const) {
    it(`${scheme}: цвет токена на полотне — не ниже 4.5:1`, () => {
      const tokens = schemeTokens(scheme);
      const background = parseColor(tokens.get('editor_background') ?? '#000000');

      for (const type of CODE_TOKEN_TYPES) {
        const color = tokenColor(scheme, type);
        expect(color, `${scheme}: ${type} должен быть окрашен`).not.toBeNull();
        expect(contrast(parseColor(color!), background), `${scheme}: ${type}`).toBeGreaterThanOrEqual(4.5);
      }
    });
  }

  it('комментарий не бледнее прочего текста кода', () => {
    // Бледный комментарий — ошибка. Сторож брал бы и так, но здесь это
    // названо прямо: комментарий — самая частая причина провала.
    for (const scheme of ['dark', 'light'] as const) {
      const tokens = schemeTokens(scheme);
      const background = parseColor(tokens.get('editor_background') ?? '#000000');
      const comment = contrast(parseColor(tokenColor(scheme, 'comment')!), background);
      expect(comment, `${scheme}: comment`).toBeGreaterThanOrEqual(4.5);
    }
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

/* ── Контраст палитры (WCAG AA) ─────────────────────────────────────────── */

/**
 * Сторож читает `styles/theme.css` — тот же файл, из которого цвета берут
 * компоненты, — и проверяет пары «цветной текст на фоне» на контраст не ниже
 * 4.5:1 (WCAG AA для обычного текста). Правка палитры, уводящая цвет за норму,
 * падает здесь, а не обнаруживается глазом: светлая схема прощает такое дольше,
 * чем тёмная.
 *
 * Порог 4.5:1 берём для всего, что красится в CSS через `color:`: подписи,
 * ссылки, состояния git и значки файлов — это текст и мелкие глифы, а не
 * крупная графика. Ступени `--text_color_secondary`, `--text_color_disabled`,
 * `--text_color_tertiary` и `--placeholder_text_color` исключены намеренно: это
 * тихие тона, и
 * светлая схема сознательно уходит в них ниже нормы ради тишины (см. `main.css`
 * про `reasoning-text`), поэтому требовать от них 4.5:1 — значит ломать замысел.
 */
const THEME_CSS = readFileSync(resolve(process.cwd(), 'src/renderer/styles/theme.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

/** `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()`/`rgba()` → каналы 0..255 и альфа 0..1. */
function parseColor(value: string): Rgba {
  const text = value.trim();
  if (text.startsWith('#')) {
    const raw = text.slice(1);
    const hex = raw.length <= 4 ? [...raw].map((char) => char + char).join('') : raw;
    return {
      r: Number.parseInt(hex.slice(0, 2), 16),
      g: Number.parseInt(hex.slice(2, 4), 16),
      b: Number.parseInt(hex.slice(4, 6), 16),
      a: hex.length >= 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
    };
  }
  const [r = 0, g = 0, b = 0, a = 1] = text.match(/[\d.]+/g)?.map(Number) ?? [];
  return { r, g, b, a };
}

/** Полупрозрачный цвет поверх непрозрачного фона — как накладывает браузер. */
function over(fg: Rgba, bg: Rgba): Rgba {
  const blend = (front: number, back: number): number => front * fg.a + back * (1 - fg.a);
  return { r: blend(fg.r, bg.r), g: blend(fg.g, bg.g), b: blend(fg.b, bg.b), a: 1 };
}

function channelLuminance(value: number): number {
  const channel = value / 255;
  return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

function luminance(color: Rgba): number {
  return 0.2126 * channelLuminance(color.r) + 0.7152 * channelLuminance(color.g) + 0.0722 * channelLuminance(color.b);
}

/** Контраст по WCAG: отношение яркостей светлого и тёмного из двух цветов. */
function contrast(fg: Rgba, bg: Rgba): number {
  const solidBg = over(bg, { r: 255, g: 255, b: 255, a: 1 });
  const [lighter, darker] = [luminance(over(fg, solidBg)), luminance(solidBg)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Значения `--токен` из блока: имя без `--` → значение. */
function readTokens(block: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const [, name, value] of block.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) out.set(name, value.trim());
  return out;
}

/**
 * `var(--другой)` → значение другого токена. Часть токенов — роли поверх ступеней
 * лестницы высоты (`--main_background: var(--surface_window)`), и без разворота
 * такой токен читался бы строкой «var(…)», а не цветом: сравнения контраста
 * молча получали бы чёрный. Разворот рекурсивный, с ограничением глубины.
 */
function resolveToken(value: string, tokens: Map<string, string>, depth = 0): string {
  const match = value.match(/^var\(\s*--([\w-]+)\s*\)$/);
  if (!match || depth > 8) return value;
  const next = tokens.get(match[1]!);
  return next === undefined ? value : resolveToken(next.trim(), tokens, depth + 1);
}

/** Тёмная схема — базовый `:root`; светлая — `:root` в `@media` поверх базовых значений. */
function schemeTokens(scheme: 'dark' | 'light'): Map<string, string> {
  const base = THEME_CSS.match(/^:root\s*\{([\s\S]*?)^\}/m)?.[1] ?? '';
  const tokens = readTokens(base);
  if (scheme === 'light') {
    const light = THEME_CSS.match(/@media\s*\(prefers-color-scheme:\s*light\)\s*\{([\s\S]*?)^\}/m)?.[1] ?? '';
    for (const [name, value] of readTokens(light)) tokens.set(name, value);
  }
  for (const [name, value] of tokens) tokens.set(name, resolveToken(value, tokens));
  return tokens;
}

/** Пары «цвет на фоне»: первый цвет читается на втором. */
const ON_BACKGROUND: ReadonlyArray<readonly [string, string]> = [
  ['--text_color', '--element_background_2'],
  ['--text_color', '--main_background'],
  ['--text_color_error', '--element_background_2'],
  ['--link_color', '--element_background_2'],
  // Всплывающий слой — отдельная поверхность со своим значением (`--surface_popup`),
  // поэтому текст на нём проверяем отдельно: в тёмной схеме он светлее карточки.
  ['--text_color', '--popup_background'],
  ['--text_color_error', '--popup_background'],
  ['--link_color', '--popup_background'],
];

/** Цвета, что читаются на поверхности карточки: состояния git и значки файлов. */
const ON_CARD: readonly string[] = [
  '--git_added',
  '--green_prime_background',
  '--git_modified',
  '--git_deleted',
  '--git_renamed',
  '--git_conflicted',
  '--file_text',
  '--file_code',
  '--file_js',
  '--file_ts',
  '--file_python',
  '--file_json',
  '--file_markdown',
  '--file_css',
  '--file_html',
  '--file_shell',
  '--file_yaml',
  '--file_config',
  '--file_database',
  '--file_docker',
  '--file_image',
  '--file_archive',
  '--file_lock',
  '--file_git',
  '--folder_default',
  '--folder_special',
  '--folder_open',
];

describe('контраст палитры (WCAG AA)', () => {
  for (const scheme of ['dark', 'light'] as const) {
    it(`${scheme}: цветной текст и значки — не ниже 4.5:1`, () => {
      const tokens = schemeTokens(scheme);
      const color = (name: string): Rgba => {
        const raw = tokens.get(name.slice(2));
        expect(raw, `токен ${name} не объявлен в theme.css`).toBeDefined();
        return parseColor(raw!);
      };

      const pairs: Array<readonly [string, Rgba, Rgba]> = [
        ...ON_BACKGROUND.map(([fg, bg]) => [fg, color(fg), color(bg)] as const),
        ...ON_CARD.map((token) => [token, color(token), color('--element_background_2')] as const),
      ];

      for (const [name, fg, bg] of pairs) {
        expect(contrast(fg, bg), `${scheme}: ${name}`).toBeGreaterThanOrEqual(4.5);
      }
    });

    it(`${scheme}: белый текст на заливке кнопки и опасного действия — не ниже 4.5:1`, () => {
      const tokens = schemeTokens(scheme);
      const color = (name: string): Rgba => {
        const raw = tokens.get(name.slice(2));
        expect(raw, `токен ${name} не объявлен в theme.css`).toBeDefined();
        return parseColor(raw!);
      };

      // Заливки — свой токен (`--accent_fill`, `--danger_fill`), а не сам акцент:
      // под белым текстом акцент не проходит (см. доккомментарий в theme.css).
      for (const fill of ['--accent_fill', '--danger_fill']) {
        expect(
          contrast(color('--text_color_hover'), color(fill)),
          `${scheme}: текст на ${fill}`,
        ).toBeGreaterThanOrEqual(4.5);
      }
    });
  }
});

/* ── Белый текст — только на цветной заливке ────────────────────────────── */

/**
 * `--text_color_hover` — это чистый белый, и он задуман как «текст НА цветной
 * заливке» (кнопка действия, бейдж). На нейтральном фоне он ломается: в светлой
 * схеме белое на белом не видно вовсе. Ровно это и было в трёх правилах
 * (имя класса в панели тестов, кнопка «к последнему сообщению», кнопка управления
 * окружением), где «ярче при наведении» получалось белым. Сторож держит контракт:
 * белый текст допустим только там, где тем же правилом задана заливка.
 */
describe('белый текст только на цветной заливке', () => {
  const MAIN_CSS = readFileSync(resolve(process.cwd(), 'src/renderer/styles/main.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const FILLS = ['--accent_fill', '--danger_fill'];

  it('color: var(--text_color_hover) встречается лишь вместе с заливкой', () => {
    const offenders: string[] = [];
    for (const [, selector, body] of MAIN_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/color:\s*var\(--text_color_hover\)/.test(body ?? '')) continue;
      const filled = FILLS.some((token) => new RegExp(`background:\\s*var\\(${token}\\)`).test(body ?? ''));
      if (!filled) offenders.push(selector!.trim());
    }
    expect(offenders).toEqual([]);
  });
});

/* ── Иерархия: уровни, а не оттенки ─────────────────────────────────────── */

/**
 * Текст задаёт не набор цветов, а ЛЕСТНИЦУ значимости: основной → вторичный →
 * третичный → подсказка места. Уровень ниже — значит тише, и ступени не должны
 * сходиться или менять порядок: слияние двух уровней убирает различие, а
 * перестановка делает «менее важное» заметнее «более важного».
 *
 * Сторож держит порядок по непрозрачности текста: она и задаёт ступень. Роли
 * `secondary` и `disabled` делят значение намеренно — это разные смыслы
 * («тише» и «недоступно») при общем оттенке, и равенство тут допустимо; строго
 * убывают остальные переходы.
 */
describe('уровни текста убывают по значимости', () => {
  const LADDER = [
    '--text_color',
    '--text_color_secondary',
    '--text_color_tertiary',
    '--placeholder_text_color',
  ] as const;

  for (const scheme of ['dark', 'light'] as const) {
    it(`${scheme}: ступени идут по порядку и не сходятся`, () => {
      const tokens = schemeTokens(scheme);
      const alpha = LADDER.map((name) => {
        const raw = tokens.get(name.slice(2));
        expect(raw, `токен ${name} не объявлен в theme.css`).toBeDefined();
        return parseColor(raw!).a;
      });

      for (let i = 1; i < alpha.length; i += 1) {
        expect(alpha[i]!, `${scheme}: ${LADDER[i]} не должен быть ярче ${LADDER[i - 1]}`).toBeLessThan(alpha[i - 1]!);
      }

      // `disabled` — состояние, а не ступень: он не громче вторичного текста.
      const disabled = parseColor(tokens.get('text_color_disabled')!).a;
      expect(disabled, `${scheme}: disabled не должен быть ярче secondary`).toBeLessThanOrEqual(alpha[1]!);
    });
  }
});

/**
 * Поверхности образуют лестницу высоты: окно → содержимое → всплывающий слой.
 * Сторож требует, чтобы всплывающий слой БЫЛ отдельной ступенью, а не копией
 * содержимого: именно так и было — `--popup_background` повторял цвет карточки,
 * хотя заголовок палитры обещал приподнятую поверхность. В светлой
 * схеме ступень совпадает с содержимым: выше белого подниматься некуда, и слой
 * отделяет тень.
 */
describe('поверхности — лестница высоты', () => {
  it('тёмная схема: всплывающий слой светлее содержимого', () => {
    const tokens = schemeTokens('dark');
    const content = luminance(parseColor(tokens.get('surface_content')!));
    const popup = luminance(parseColor(tokens.get('surface_popup')!));
    expect(popup).toBeGreaterThan(content);
  });

  it('светлая схема: всплывающий слой не темнее содержимого', () => {
    const tokens = schemeTokens('light');
    const content = luminance(parseColor(tokens.get('surface_content')!));
    const popup = luminance(parseColor(tokens.get('surface_popup')!));
    expect(popup).toBeGreaterThanOrEqual(content);
  });

  it('окно темнее содержимого в обеих схемах (слой ниже лежит под слоем выше)', () => {
    for (const scheme of ['dark', 'light'] as const) {
      const tokens = schemeTokens(scheme);
      const window = luminance(parseColor(tokens.get('surface_window')!));
      const content = luminance(parseColor(tokens.get('surface_content')!));
      // Тёмная схема: содержимое светлее окна. Светлая: содержимое светлее (окно — серое).
      expect(content, `${scheme}: содержимое`).toBeGreaterThan(window);
    }
  });

  /**
   * Материал всплывающего слоя обязан строиться на его же ступени, а не на карточке:
   * иначе наши попапы со стеклом выходят темнее меню Monaco (те берут непрозрачный
   * `--popup_background`), и подъём теряется. Так уже было — `--popup_background`
   * починили, а материал остался на цвете карточки; сторож не даёт повторить.
   */
  it('стеклянный материал стоит на ступени попапа, а не карточки', () => {
    for (const scheme of ['dark', 'light'] as const) {
      const material = schemeTokens(scheme).get('popup_material')!;
      expect(material, `${scheme}: база материала`).toMatch(/var\(--(popup_background|surface_popup)\)/);
      expect(material, `${scheme}: материал не должен строиться на карточке`).not.toMatch(
        /var\(--element_background_2\)/,
      );
    }
    // Плотная поверхность под «уменьшить прозрачность» — на той же ступени попапа.
    const reduced = THEME_CSS.match(/@media\s*\(prefers-reduced-transparency:\s*reduce\)\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(reduced).toMatch(/--popup_material:\s*var\(--popup_background\)/);
  });
});

/**
 * Линии — тоже лестница: от почти незаметных направляющих отступа внутри кода
 * до явных границ панелей. Направляющая обязана быть ТИШЕ границы, иначе
 * служебная сетка спорит с каркасом интерфейса. Направляющие живут в палитре
 * Monaco (`core/theme.ts`, Monaco не читает CSS-переменные), границы — в
 * `theme.css`, поэтому сторож сводит обе таблицы и сравнивает их на своих фонах.
 */
describe('линии: направляющая тише границы', () => {
  const cssTokens = schemeTokens;
  for (const scheme of ['dark', 'light'] as const) {
    it(`${scheme}: направляющая отступа тише границы панели`, () => {
      const guide = parseColor(MONACO_THEMES[scheme].colors!['editorIndentGuide.background1']!);
      const editor = parseColor(MONACO_THEMES[scheme].colors!['editor.background']!);
      const border = parseColor(cssTokens(scheme).get('border_color')!);
      const content = parseColor(cssTokens(scheme).get('element_background_2')!);

      expect(contrast(guide, editor), `${scheme}: направляющая`).toBeLessThan(contrast(border, content));
    });
  }
});

/* ── Состав контекста: доли различимы ───────────────────────────────────── */

/* ── Фон окна не расходится с палитрой ─────────────────────────────────── */

/**
 * `BrowserWindow` красит себя до отрисовки страницы, поэтому его фон задаётся
 * в main-процессе (`shared/colors.ts`), а не в CSS. Значение обязано совпадать с
 * токенами `theme.css`, иначе при смене палитры окно мигало бы чужим цветом.
 * Сторож связывает две копии одного цвета — тёмную с `--element_background_2`,
 * светлую с `--main_background` — и падает, если их разведут.
 */
describe('фон окна совпадает с палитрой', () => {
  it('тёмная схема — как --element_background_2', () => {
    expect(WINDOW_BACKGROUND.dark.toLowerCase()).toBe(schemeTokens('dark').get('element_background_2')?.toLowerCase());
  });

  it('светлая схема — как --main_background', () => {
    expect(WINDOW_BACKGROUND.light.toLowerCase()).toBe(schemeTokens('light').get('main_background')?.toLowerCase());
  });
});

/**
 * Диаграмма состава контекста красит каждую долю своим оттенком: и в полосе
 * заполнения, и в списке под ней. Если две доли получают один цвет, они
 * читаются как одна — ровно это и было: «инструменты» и «файлы» делили жёлтый,
 * а результаты и файлы тянули цвета git. Сторож держит набор из пяти долей
 * попарно различимым в обеих схемах — новая доля с занятым цветом падает тут.
 */
describe('доли контекста различимы', () => {
  const KEYS = ['system', 'tools', 'messages', 'results', 'files'] as const;

  for (const scheme of ['dark', 'light'] as const) {
    it(`${scheme}: пять долей — пять разных цветов`, () => {
      const tokens = schemeTokens(scheme);
      const colors = KEYS.map((key) => {
        const raw = tokens.get(`context_seg_${key}`);
        expect(raw, `токен --context_seg_${key} не объявлен в theme.css`).toBeDefined();
        return raw!.trim().toLowerCase();
      });
      expect(new Set(colors).size).toBe(KEYS.length);
    });
  }
});

/* ── Каждый токен объявлен ──────────────────────────────────────────────── */

/**
 * `font-size: var(--font_small_size)` без объявления токена — не опечатка ради
 * опечатки: у `var()` без fallback значение недействительно, и свойство
 * откатывается к унаследованному. Так замена литералов 11px/10px на «токены»,
 * которых нет, тихо увеличила бы весь мелкий текст до 12px. Сторож читает те же
 * файлы стилей и падает на любом `var(--…)` без объявления и без fallback.
 *
 * `--vscode-*` пропускаем: их пишет сам Monaco в рантайме, в наших файлах их нет.
 */
describe('токены стилей объявлены', () => {
  const STYLE_FILES = ['theme.css', 'main.css', 'monaco.css'].map((name) =>
    resolve(process.cwd(), 'src/renderer/styles', name),
  );

  it('нет var(--…) без объявления и без запасного значения', () => {
    const defined = new Set<string>();
    const used = new Set<string>();
    for (const file of STYLE_FILES) {
      const css = readFileSync(file, 'utf8');
      for (const [, name] of css.matchAll(/--([\w-]+)\s*:/g)) defined.add(name);
      // Запятая вторым символом — есть fallback, такой `var()` безопасен.
      for (const [, name, next] of css.matchAll(/var\(\s*--([\w-]+)\s*([,)])/g)) {
        if (next === ',') continue;
        used.add(name);
      }
    }

    const missing = [...used].filter((name) => !defined.has(name) && !name.startsWith('vscode-'));
    expect(missing).toEqual([]);
  });
});

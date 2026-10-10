import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Движение — только по делу и только короткое (HIG «Add motion purposefully»,
 * «brevity and precision»). Сторож держит техническую сторону этого правила:
 *
 *   1. `@keyframes` меняют лишь `transform` и `opacity` — то, что браузер
 *      отрисовывает на композиторе. Анимация `width`/`top`/`margin` заставляет
 *      пересчитывать раскладку на каждом кадре: это и медленно, и «дёргано»;
 *   2. у `transition` нет литеральных длительностей — время берётся из ступеней
 *      шкалы `--motion_instant`/`--motion_fast`/`--motion_base`/`--motion_slow`.
 *      «Свои» 120ms/300ms рядом с общей шкалой и есть та самая небрежность, от
 *      которой предостерегает brevity.
 *
 * Что движение осмысленно (а не украшение ради) — сторож не проверит: это
 * вопрос ревью. Здесь ловится лишь то, что нарушает правило молча.
 */
const STYLE_FILES = ['theme.css', 'main.css', 'monaco.css'].map((name) =>
  resolve(process.cwd(), 'src/renderer/styles', name),
);

/** Свойства, которые трогать анимацией дорого: они тянут за собой раскладку. */
const LAYOUT_PROPERTIES = [
  'width',
  'height',
  'min-width',
  'max-width',
  'min-height',
  'max-height',
  'margin',
  'padding',
  'inset',
  'top',
  'left',
  'right',
  'bottom',
  'font-size',
  'line-height',
  'flex-basis',
  'flex-grow',
  'gap',
  'grid-template-columns',
  'grid-template-rows',
];

/** Имена свойств из `transition: …;`: первый токен каждой части через запятую. */
function transitionProperties(value: string): string[] {
  return value
    .split(',')
    .map((part) => part.trim().split(/\s+/)[0] ?? '')
    .filter((name) => name.length > 0);
}

describe('анимация не трогает раскладку', () => {
  it('@keyframes меняют только transform и opacity', () => {
    const offenders: string[] = [];
    for (const file of STYLE_FILES) {
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      // Один уровень вложенности: тело кадра — это список блоков `селектор { … }`.
      for (const [, name, body] of css.matchAll(/@keyframes\s+([\w-]+)\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g)) {
        for (const [, property] of (body ?? '').matchAll(/([a-z-]+)\s*:/g)) {
          if (property !== 'transform' && property !== 'opacity') offenders.push(`${name}: ${property}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('transition не анимирует геометрию', () => {
    const offenders: string[] = [];
    for (const file of STYLE_FILES) {
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const [, value] of css.matchAll(/transition\s*:\s*([^;]+);/g)) {
        for (const property of transitionProperties(value ?? '')) {
          if (LAYOUT_PROPERTIES.includes(property)) offenders.push(property);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('длительность движения — из общей шкалы', () => {
  it('в transition нет литеральных секунд и миллисекунд', () => {
    const offenders: string[] = [];
    for (const file of STYLE_FILES) {
      const css = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      for (const [whole, value] of css.matchAll(/transition\s*:\s*([^;]+);/g)) {
        // Время должно приходить из `--motion_*`, а не быть числом в объявлении.
        if (/\d+(?:\.\d+)?m?s\b/.test(value ?? '')) offenders.push((whole ?? '').trim());
      }
    }
    expect(offenders).toEqual([]);
  });
});

/* ── Шкала длительностей — четыре ступени ────────────────────────────────── */

/**
 * Длительность берётся ступенями, а не «на глаз»: Instant (0), Fast (150),
 * Normal (250), Slow (350). Ступень выбирают по назначению — частые действия
 * мгновенны, всплывающий слой идёт Normal, модальное окно Slow. Так движение
 * остаётся предсказуемым, а «свои» 120/300 ms рядом со шкалой не заводятся.
 */
describe('шкала движения — четыре ступени', () => {
  const THEME = readFileSync(resolve(process.cwd(), 'src/renderer/styles/theme.css'), 'utf8');
  const MAIN = readFileSync(resolve(process.cwd(), 'src/renderer/styles/main.css'), 'utf8');

  it('в theme.css объявлены все четыре ступени с ожидаемыми значениями', () => {
    expect(THEME).toMatch(/--motion_instant:\s*0s;/);
    expect(THEME).toMatch(/--motion_fast:\s*0\.15s;/);
    expect(THEME).toMatch(/--motion_base:\s*0\.25s;/);
    expect(THEME).toMatch(/--motion_slow:\s*0\.35s;/);
  });

  it('модальное окно — ступень Slow, а не Normal', () => {
    // У `.modal` две роли: общий материал слоя и само окно. Берём блок с анимацией.
    expect(MAIN).toMatch(/\.modal\s*\{[^}]*animation:\s*popup-fade\s+var\(--motion_slow\)/);
  });

  it('всплывающий слой — ступень Normal', () => {
    expect(MAIN).toMatch(/\.palette\s*\{[^}]*animation:\s*popup-fade\s+var\(--motion_base\)/);
  });
});

/* ── Движение можно отключить (HIG «Make motion optional») ───────────────── */

describe('движение отключается системной настройкой', () => {
  const MAIN = readFileSync(resolve(process.cwd(), 'src/renderer/styles/main.css'), 'utf8');
  // Тело блока `@media (prefers-reduced-motion: reduce) { … }`: закрывающая скобка
  // стоит в начале строки, вложенные — с отступом.
  const REDUCE = MAIN.match(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';

  it('есть блок reduce motion и он гасит переходы и анимации', () => {
    expect(REDUCE).not.toBe('');
    expect(REDUCE).toMatch(/animation-duration:\s*0\.01ms/);
    expect(REDUCE).toMatch(/transition-duration:\s*0\.01ms/);
  });

  it('появление слоя — кросс-фейд, а не слайд', () => {
    // Под reduce всплывающие слои берут `popup-fade`, а он двигает только прозрачность.
    expect(REDUCE).toMatch(/animation-name:\s*popup-fade/);
    const fade = MAIN.match(/@keyframes\s+popup-fade\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(fade).not.toBe('');
    expect(fade).not.toMatch(/transform/);
  });

  it('бесконечные индикаторы «в работе» под reduce замирают', () => {
    // Пульс — единственная бесконечная анимация; у каждой должен быть стоп.
    for (const name of ['tab-pulse', 'activity-dot', 'activity-pulse']) {
      expect(MAIN).toContain(`@keyframes ${name}`);
    }
    expect(REDUCE).toMatch(/animation:\s*none/);
  });

  /* ── Батарея: движется только видимое, тяжёлые жесты — по кадру ────────── */

  /**
   * HIG отдельно предупреждает: анимации тратят заряд, а IDE работает часами.
   * Отсюда три правила, и все три проверяемы: (1) бесконечных анимаций ровно
   * столько, сколько нужно, и все они — индикаторы «в работе»; (2) скрытые
   * поверхности убраны через `display: none`, поэтому их анимации не крутятся
   * за кадром; (3) жест, пишущий в раскладку, не чаще кадра.
   */
  it('бесконечных анимаций ровно три — все индикаторы «в работе»', () => {
    const names = [...MAIN.matchAll(/animation:\s*([\w-]+)[^;]*\binfinite\b/g)].map((match) => match[1]);
    expect(names.length).toBeGreaterThan(0);
    expect(new Set(names)).toEqual(new Set(['tab-pulse', 'activity-dot', 'activity-pulse']));
  });

  it('скрытые панели гасят свои анимации — их убирают через display: none', () => {
    // Панель на `display: none` не рисуется, и анимации внутри неё останавливаются
    // сами. Если заменить это на opacity/visibility, анимации продолжатся невидимо.
    for (const selector of [
      '.app.is-sidebar-hidden .sidebar',
      '.app.is-right-hidden .right-panel',
      '.app.is-dock-hidden .dock-wrap',
    ]) {
      const rule = MAIN.match(new RegExp(`${selector.replace(/[.]/g, '\\.')}[\\s\\S]{0,160}?display:\\s*none`));
      expect(rule, `${selector} → display: none`).not.toBeNull();
    }
  });

  it('перетаскивание разделителя пишет размер не чаще кадра', () => {
    // pointermove приходит сотни раз в секунду; запись размера на каждое событие
    // пересчитывала бы раскладку чаще, чем экран показывает кадр.
    const LAYOUT = readFileSync(resolve(process.cwd(), 'src/renderer/ui/layout.ts'), 'utf8');
    expect(LAYOUT).toMatch(/requestAnimationFrame/);
    expect(LAYOUT).toMatch(/cancelAnimationFrame/);
  });

  it('меню Monaco в теневом корне тоже уважает reduce motion', () => {
    // Правила страницы в теневой корень не доходят: у него своя копия.
    const chrome = readFileSync(resolve(process.cwd(), 'src/renderer/core/monaco-chrome.ts'), 'utf8');
    expect(chrome).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
    expect(chrome).toMatch(/animation-name:\s*popup-fade/);
  });
});

/* ── Частые действия — без движения (HIG «avoid motion in frequent actions») ── */

/**
 * HIG: не добавляйте движение к взаимодействиям, которые повторяются часто.
 * В IDE это переключение вкладок и ходьба по списку/палитре стрелками: подсветка
 * обязана вставать мгновенно. Переход на таком элементе — это и есть «анимация
 * частого действия»: 150 ms подсветка догоняет курсор, и интерфейс кажется
 * вязким. Сторож падает, если частый селектор снова получит `transition`.
 *
 * Тут только техническая половина правила (нет перехода). Что появление окна —
 * редкое и может анимироваться, а переключение вкладки — нет, сторож не решает:
 * список частых селекторов ведёт человек.
 */
describe('частые действия не анимируются', () => {
  const MAIN = readFileSync(resolve(process.cwd(), 'src/renderer/styles/main.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );

  /** Элементы, которые трогают сотни раз в день: вкладки, списки, палитра, меню. */
  const FREQUENT = ['.tab', '.dock-tab', '.term-tab', '.palette-item', '.select-item', '.context-item', '.tree-row'];

  it('у вкладок и пунктов списков нет transition', () => {
    const offenders: string[] = [];
    for (const [, selector, body] of MAIN.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      const parts = (selector ?? '').split(',').map((part) => part.trim());
      if (!parts.some((part) => FREQUENT.includes(part))) continue;
      if (/transition\s*:/.test(body ?? '')) offenders.push(selector!.trim().replace(/\s+/g, ' '));
    }
    expect(offenders).toEqual([]);
  });
});

/* ── Раскрытие идёт в сторону появления (HIG «realistic feedback motion») ─── */

/**
 * HIG: движение должно следовать ожиданию — элемент выезжает оттуда, где он
 * появился. Дети раскрытой папки появляются ПОД родителем и выезжают сверху вниз;
 * всплыть снизу — значит соврать о том, откуда они пришли.
 *
 * Сторож держит лишь направление и связь класса с кадром: что жест раскрытия
 * вообще стоит анимировать — вопрос ревью.
 */
describe('раскрытие дерева идёт в сторону появления', () => {
  const MAIN = readFileSync(resolve(process.cwd(), 'src/renderer/styles/main.css'), 'utf8');

  it('дети раскрытой папки въезжают сверху вниз', () => {
    const reveal = MAIN.match(/@keyframes\s+tree-reveal\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(reveal).not.toBe('');
    // Старт выше финала (отрицательный сдвиг) — строка идёт вниз, из-под родителя.
    expect(reveal).toMatch(/translateY\(\s*-[\d.]/);
    // И эта анимация повешена на класс, которым проводник метит новых детей.
    expect(MAIN).toMatch(/\.tree-row\.is-entering\s*\{[^}]*animation:\s*tree-reveal/);
  });

  it('проводник метит новых детей классом is-entering', () => {
    const source = readFileSync(resolve(process.cwd(), 'src/renderer/ui/explorer.ts'), 'utf8');
    expect(source).toMatch(/is-entering/);
    // Класс ставится именно детям раскрытой папки, а не всем строкам подряд.
    expect(source).toMatch(/dir === revealChildrenOf/);
  });
});

/* ── Слой с блюром не двигается: это дорого для GPU (HIG «battery») ────────── */

/**
 * `backdrop-filter` пересчитывается КаЖДЫЙ кадр, пока слой движется или
 * масштабируется, а `scale` ещё и меняет область сэмплирования фона — самый
 * дорогой случай. Поэтому любой слой с блюром появляется КРОСС-ФЕЙДОМ (только
 * `opacity`): при одной прозрачности блюр кэшируется. Сдвиг остаётся лишь у
 * поверхностей без блюра — там он бесплатен.
 */
describe('слой с блюром появляется кросс-фейдом, а не сдвигом', () => {
  const MAIN = readFileSync(resolve(process.cwd(), 'src/renderer/styles/main.css'), 'utf8');

  /** Материал с блюром: тот же список, что у `backdrop-filter` в начале файла. */
  const BLURRED = [
    '.select-popup',
    '.context-menu',
    '.composer-menu',
    '.session-info',
    '.popover',
    '.palette',
    '.toast',
    '.modal',
  ];

  it('каждый слой с backdrop-filter появляется только прозрачностью', () => {
    for (const selector of BLURRED) {
      const rule = MAIN.match(new RegExp(`\\${selector}\\s*\\{[^}]*animation:\\s*popup-fade`));
      expect(rule, `${selector} → popup-fade`).not.toBeNull();
    }
  });

  it('popup-fade не трогает transform', () => {
    const fade = MAIN.match(/@keyframes\s+popup-fade\s*\{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(fade).not.toBe('');
    expect(fade).not.toMatch(/transform/);
  });

  it('сдвиг остаётся только у поверхностей без блюра', () => {
    // Клон лончера — без backdrop-filter, ему сдвиг ничего не стоит.
    expect(MAIN).toMatch(/\.launcher-clone\s*\{[^}]*animation:\s*popup-in/);
  });
});

/* ── Чего в IDE быть не должно (HIG «Чего избегать») ─────────────────────── */

/**
 * Список раздражителей из HIG и сторож по каждому, что зависит от нашего кода:
 *   • сохранение файла — мгновенно, лишь статичная точка «не сохранён»;
 *   • переключение вкладок — мгновенно (уже стережёт блок `частые действия`);
 *   • ошибки и предупреждения — статичная подсветка, без пульса;
 *   • автодополнение — появляется без анимации появления;
 *   • открытие проекта — прогресс текстом, без блокирующей анимации;
 *   • всё движение уважает Reduce Motion (уже стережёт блок выше).
 * Здесь — то, что ни один из прежних сторожей не ловил.
 */
describe('нет анимации там, где она раздражает', () => {
  const MAIN = readFileSync(resolve(process.cwd(), 'src/renderer/styles/main.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );
  const MONACO = readFileSync(resolve(process.cwd(), 'src/renderer/styles/monaco.css'), 'utf8').replace(
    /\/\*[\s\S]*?\*\//g,
    '',
  );

  it('точка «не сохранён» статична — сохранение не анимируется', () => {
    const dirty = MAIN.match(/\.tab-dirty\s*\{[^}]*\}/)?.[0] ?? '';
    expect(dirty).not.toBe('');
    expect(dirty).not.toMatch(/animation\s*:/);
  });

  it('ошибки и предупреждения подсвечиваются статично, без пульса', () => {
    // Ни одно правило, чей селектор говорит про ошибку или опасность, не анимируется:
    // статичная подсветка + волнистое подчёркивание Monaco, а не мигающий значок.
    const offenders: string[] = [];
    for (const [, selector, body] of MAIN.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (!/(error|danger|warning|problem)/i.test(selector ?? '')) continue;
      if (/animation\s*:/.test(body ?? '')) offenders.push(selector!.trim().replace(/\s+/g, ' '));
    }
    expect(offenders).toEqual([]);
  });

  it('автодополнение появляется без анимации появления', () => {
    const suggest = MONACO.match(/\.monaco-editor \.suggest-widget[^{]*\{[^}]*\}/)?.[0] ?? '';
    expect(suggest).not.toBe('');
    expect(suggest).not.toMatch(/animation\s*:/);
  });

  it('открытие проекта — прогресс текстом, без блокирующего слоя появления', () => {
    // Прогресс клонирования/открытия — обычная строка, а не анимированный оверлей,
    // который держал бы интерфейс; сам он анимации появления не несёт.
    const progress = MAIN.match(/\.launcher-progress\s*\{[^}]*\}/)?.[0] ?? '';
    expect(progress).not.toBe('');
    expect(progress).not.toMatch(/animation\s*:/);
  });
});

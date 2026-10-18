import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readStyle } from './style-files';

/**
 * Сторож подсказок: системных быть не должно, все — в стилях приложения.
 *
 * Атрибут `title` рисует подсказку средствами ОС: чужой шрифт, чужая рамка, своя
 * задержка, а на части платформ — отдельное окно поверх интерфейса. Мы показываем
 * свой слой (`ui/tooltip.ts`), а `title` на время показа снимаем, иначе системная
 * вылезла бы поверх нашей.
 *
 * Сторож держит три вещи, которые легко потерять при правке:
 *   • наведение ловится на ДОКУМЕНТЕ — тогда новая кнопка с `title` показывает
 *     подсказку сама, и никого не надо к ней подключать;
 *   • `title` снимается и ВОЗВРАЩАЕТСЯ: без возврата подсказка пропала бы навсегда,
 *     а вместе с ней и текст для читалки, у кого `title` — единственная подпись;
 *   • подсказка берёт вид из общей палитры и лежит выше прочих всплывающих слоёв:
 *     её показывают и у пункта открытого списка, и у кнопки в модальном окне.
 */

const RENDERER = resolve(process.cwd(), 'src/renderer');

function source(path: string): string {
  return readFileSync(resolve(RENDERER, path), 'utf8');
}

const TOOLTIP = source('ui/tooltip.ts');

describe('подсказка — свой слой, а не системная', () => {
  it('на время показа `title` снимается и возвращается обратно', () => {
    expect(TOOLTIP).toMatch(/target\.removeAttribute\('title'\)/);
    expect(TOOLTIP).toMatch(/setAttribute\('title', shown\.title\)/);
  });

  it('наведение ловится на документе — новые кнопки не требуют проводки', () => {
    expect(TOOLTIP).toMatch(/document\.addEventListener\(\s*'mouseover'/);
    expect(TOOLTIP).toMatch(/closest\('\[title\]'\)/);
  });

  it('подсказка гаснет от нажатия, клавиши, прокрутки и смены кадра', () => {
    for (const event of ["'mousedown'", "'keydown'", "'wheel'", "'scroll'", "'resize'", "'blur'"]) {
      expect(TOOLTIP, event).toContain(event);
    }
  });

  it('подсказка ставится у элемента и не уходит за край окна', () => {
    expect(TOOLTIP).toMatch(/getBoundingClientRect\(\)/);
    expect(TOOLTIP).toMatch(/window\.innerHeight/);
    expect(TOOLTIP).toMatch(/window\.innerWidth/);
  });

  it('слой один на окно: повторная установка второго не заводит', () => {
    expect(TOOLTIP).toMatch(/querySelector\('\.app-tooltip'\)/);
  });
});

describe('обе точки входа ставят подсказки', () => {
  it('окно IDE', () => {
    expect(source('app.ts')).toMatch(/installTooltips\(\)/);
  });

  it('стартовое окно', () => {
    expect(source('ui/launcher.ts')).toMatch(/installTooltips\(\)/);
  });
});

describe('вид подсказки — из общей палитры и выше прочих слоёв', () => {
  const CHROME = readStyle('chrome.css');
  const THEME = readStyle('theme.css');
  const rule = CHROME.match(/\.app-tooltip\s*\{([^}]*)\}/)?.[1] ?? '';

  const layer = (name: string): number => Number(THEME.match(new RegExp(`${name}:\\s*(\\d+)`))?.[1]);

  it('правило есть и берёт слой из палитры', () => {
    expect(rule).not.toBe('');
    expect(rule).toContain('z-index: var(--layer_tooltip)');
    expect(THEME).toMatch(/--layer_tooltip:\s*\d+;/);
  });

  it('подсказка выше модального окна, уведомлений и списка селекта', () => {
    for (const under of ['--layer_modal', '--layer_toast', '--layer_select']) {
      expect(layer('--layer_tooltip'), under).toBeGreaterThan(layer(under));
    }
  });

  it('наведение на себя отключено — иначе подсказка отбирала бы его у кнопки', () => {
    expect(rule).toContain('pointer-events: none');
  });

  it('появление — кросс-фейдом, как у прочих слоёв', () => {
    expect(rule).toMatch(/animation:\s*popup-fade/);
  });

  // Подсказка всплывает над панелью, полотном и полосой вкладок. Плотная плашка на
  // них читалась по-разному (над полотном — серая плитка, над тёмной панелью почти
  // сливалась), поэтому фон у неё — тот же материал, что у меню и поповеров, вместе
  // с блюром. Сторож в живом окне — `npm run probe:tooltip`.
  it('фон — материал всплывающих слоёв, а не плотная плашка', () => {
    expect(rule).toContain('background: var(--popup_material)');
    expect(rule).not.toContain('background: var(--popup_background)');
  });

  // Подсказка часто несёт путь: `/home/…/package.json` — одно слово без пробелов.
  // Без переноса внутри слова текст вылезал за `max-width` и подложка кончалась
  // раньше текста — подсказка читалась как «без фона». Сторож в живом окне —
  // раздел про точный длинный путь в `npm run probe:tooltip`.
  it('длинный путь переносится, а не вылезает за подложку', () => {
    expect(rule).toContain('overflow-wrap: anywhere');
    expect(rule).toContain('white-space: pre-line');
  });

  it('подсказка в списке слоёв с блюром фона', () => {
    const materials = CHROME.match(/\{[^}]*backdrop-filter:\s*var\(--popup_filter\)[^}]*\}/g) ?? [];
    const block = (CHROME.match(/[^}]*\.app-tooltip[^}]*\{[^}]*backdrop-filter:[^}]*\}/) ?? [''])[0];
    expect(materials.length).toBeGreaterThan(0);
    expect(block).toContain('.app-tooltip');
  });
});

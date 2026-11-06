import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Страж доступности там, где она легко теряется при правке.
 *
 * Свой UI без фреймворка не даёт ролей «из коробки»: разметку и связи объявляем сами,
 * и стоит кому-то переписать разметку — читалка сразу замолчит, а глазами этого не
 * видно. Сторож держит то, что уже сделано и что проверяемо по тексту модулей:
 *
 *   • уведомление объявляется читалке (`role` и живая область в контейнере);
 *   • у полосы вкладок есть роль, выбор и ход стрелками;
 *   • папка дерева говорит, раскрыта ли она;
 *   • «идёт чтение» — это `status`, а не просто серые полоски;
 *   • долгая работа — `progressbar` со значением, а не только полоска.
 *
 * Что НЕ объявлено — тоже осознанно и записано в README: роль `tree` была
 * снята без хода стрелками, а не навсегда — теперь она есть и держится проверкой выше.
 */

const UI = resolve(process.cwd(), 'src/renderer/ui');

function source(name: string): string {
  return readFileSync(resolve(UI, name), 'utf8');
}

/** Хост приложения: здесь живёт подключение хуков к проводнику. */
const APP = readFileSync(resolve(process.cwd(), 'src/renderer/app.ts'), 'utf8');

describe('уведомления объявляются читалке', () => {
  const TOAST = source('toast.ts');

  it('живая область живёт в контейнере, а не создаётся с тостом', () => {
    // Читалка замечает подмену содержимого только у узла, который уже был в документе.
    expect(TOAST).toMatch(/class: 'toasts',[\s\S]{0,120}aria-live': 'polite'/);
  });

  it('ошибка объявляется сразу, прочее — когда читалка дойдёт', () => {
    expect(TOAST).toMatch(/role: kind === 'error' \? 'alert' : 'status'/);
  });
});

describe('полоса вкладок умеет то, что обещает ролью', () => {
  const TABS = source('tabs.ts');

  it('полоса — tablist, вкладка — tab с выбором', () => {
    expect(TABS).toMatch(/class: 'tabs', role: 'tablist'/);
    expect(TABS).toMatch(/role: 'tab'/);
    expect(TABS).toMatch(/'aria-selected': path === active \? 'true' : 'false'/);
  });

  it('стрелки и Enter ходят по полосе', () => {
    expect(TABS).toMatch(/onTabKey/);
    for (const key of ["'ArrowRight'", "'ArrowLeft'", "'Home'", "'End'", "'Enter'", "'Delete'"]) {
      expect(TABS, key).toContain(key);
    }
  });

  it('в полосе один Tab: фокусируема только активная вкладка', () => {
    expect(TABS).toMatch(/tabindex: path === active \? '0' : '-1'/);
  });

  it('пересборка полосы не теряет фокус', () => {
    expect(TABS).toMatch(/hadFocus = element\.contains\(document\.activeElement\)/);
    expect(TABS).toMatch(/if \(hadFocus\) activeTab\?\.focus\(\)/);
  });

  it('вкладка и её область связаны в обе стороны', () => {
    // Иначе читалка знает, что вкладка выбрана, но не знает, что после выбора
    // изменилось: вкладка — это обещание «вот здесь содержимое этой вкладки».
    // От вкладки к области — `aria-controls`, обратно — `aria-labelledby`.
    expect(TABS).toMatch(/'aria-controls': FILE_PANEL_ID/);
    expect(TABS).toMatch(/'aria-controls': PAGE_PANEL_ID\(page\.id\)/);
    // У каждой вкладки есть имя: на него и указывает панель.
    expect(TABS).toMatch(/id: tabId\(String\(index\)\)/);
    expect(TABS).toMatch(/id: tabId\(`page-\$\{page\.id\}`\)/);
  });

  it('область редактора — панель, которую называет выбранная вкладка', () => {
    const LAYOUT = source('layout.ts');
    expect(LAYOUT).toMatch(/role: 'tabpanel'/);
    // Имя общее с полосой: одна константа, а не две строки, которые разъедутся.
    expect(LAYOUT).toMatch(/id: FILE_PANEL_ID/);
    // И подключено, а не только объявлено: имя панели ставит хозяин каркаса.
    expect(APP).toMatch(/const tabName = activeTabId\(tabSources\)/);
    expect(APP).toMatch(/island\.setAttribute\('aria-labelledby', tabName\)/);
    // Нечего называть — атрибут снимается, а не указывает в пустоту.
    expect(APP).toMatch(/if \(tabName === ''\) island\.removeAttribute\('aria-labelledby'\)/);
  });
});

describe('папка дерева говорит, раскрыта ли она', () => {
  const EXPLORER = source('explorer.ts');

  it('у папки есть `aria-expanded`, у строки — `aria-selected`', () => {
    expect(EXPLORER).toMatch(/isDirectory \? \{ 'aria-expanded': isExpanded \? 'true' : 'false' \} : \{\}/);
    // Было `aria-current`: он говорит «текущая в наборе ссылок», а у нас это
    // ВЫДЕЛЕННАЯ строка дерева — для дерева положено `aria-selected`.
    expect(EXPLORER).toMatch(/'aria-selected': 'true'/);
  });

  it('роль `tree` и `treeitem` выставлены вместе с ходом стрелками', () => {
    // Раньше роли НЕ было намеренно: `treeitem` обещает клавиатурный ход внутри
    // дерева, а хода не было — объявить роль значило соврать читалке. Теперь
    // ход есть (`core/tree-walk.ts`), поэтому и роль, и место в наборе честные.
    expect(EXPLORER).toMatch(/role: 'tree'/);
    expect(EXPLORER).toMatch(/role: 'treeitem'/);
    expect(EXPLORER).toMatch(/'aria-level'/);
    expect(EXPLORER).toMatch(/'aria-setsize'/);
    expect(EXPLORER).toMatch(/'aria-posinset'/);
  });

  it('ход по дереву действительно подключён, а не только объявлен', () => {
    // Иначе роль снова врёт: объявленный договор должен вызываться.
    expect(EXPLORER).toMatch(/walkTree\(walkRows\(\)/);
  });

  it('текущую строку называет само дерево — через `aria-activedescendant`', () => {
    // Фокус живёт на контейнере (`tabindex=-1`), а строки пересоздаются каждую
    // отрисовку: без `aria-activedescendant` читалка не знает, какая строка
    // текущая, — и роль `tree` опять превращается в обещание без содержания.
    expect(EXPLORER).toMatch(/'aria-activedescendant': ''/);
    expect(EXPLORER).toMatch(/setAttribute\('aria-activedescendant', selectedIndex < 0 \? '' : treeRowId\(selectedIndex\)\)/);
    // Имя строки — от её места в наборе: индекс берётся у тех строк, что попали
    // в набор, а место в наборе считается по всему набору, не по окну.
    expect(EXPLORER).toMatch(/index === undefined \? \{\} : \{ id: treeRowId\(index\) \}/);
    // Строка, которой уже нет (свернули, отфильтровали), не называется.
    expect(EXPLORER).toMatch(/flatRows\.findIndex\(rowIsPath\(selected\)\)/);
  });

  it('`Ctrl+Enter` на файле открывает в соседнюю панель', () => {
    // Shift+↑/↓ (диапазон) и буквенный переход уже есть в `core/tree-walk.ts` и
    // `core/tree-typeahead.ts`; оставалась одна дверь без клавиши — открыть вбок.
    // Порядок тот же, что у выбора символа: сначала делим, потом открываем.
    expect(EXPLORER).toMatch(/applyWalk\(action, event\)/);
    expect(EXPLORER).toMatch(/event\.ctrlKey \|\| event\.metaKey/);
    expect(EXPLORER).toMatch(/if \(side\) deps\.splitEditor\?\.\(\);/);
    expect(APP).toMatch(/splitEditor: \(\) => \{/);
    expect(APP).toMatch(/if \(!editors\.isSplit\) editors\.splitEditor\(\);/);
  });
});

describe('долгая работа говорит читалке, сколько прошло', () => {
  const STATUS = source('statusbar.ts');

  it('полоса объявлена как `progressbar`, а не как текст', () => {
    expect(STATUS).toMatch(/class: 'status-item status-meter is-metered', role: 'progressbar'/);
  });

  it('значения обновляются вместе с шириной', () => {
    expect(STATUS).toMatch(/setAttribute\('aria-valuemin', '0'\)/);
    expect(STATUS).toMatch(/setAttribute\('aria-valuemax', '100'\)/);
    expect(STATUS).toMatch(/setAttribute\('aria-valuenow', String\(percent\)\)/);
    expect(STATUS).toMatch(/setAttribute\('aria-valuetext', meter\.label\)/);
  });

  it('бегущая без процента работа не обещает числа', () => {
    // `aria-valuenow` у неё убран: иначе читалка скажет «0 процентов» о работе,
    // которая идёт. Скрытая полоса молчит совсем — значений и подписи у неё нет.
    expect(STATUS).toMatch(/const known = !\(meter\.busy && meter\.fill === 0\);/);
    expect(STATUS).toMatch(/if \(!meter\.hidden && known\) meterItem\.setAttribute\('aria-valuenow'/);
    expect(STATUS).toMatch(/else meterItem\.removeAttribute\('aria-valuenow'\);/);
    expect(STATUS).toMatch(/else meterItem\.removeAttribute\('aria-valuetext'\);/);
  });
});

describe('ожидание чтения — это статус, а не только полоски', () => {
  const LOADING = source('loading.ts');

  it('строка и силуэт объявлены как `status`', () => {
    expect(LOADING).toMatch(/class: 'loading-note', role: 'status'/);
    expect(LOADING).toMatch(/class: 'skeleton', role: 'status'/);
  });

  it('силуэт называют словами для читалки', () => {
    expect(LOADING).toContain("'aria-label': 'Идёт чтение'");
  });
});

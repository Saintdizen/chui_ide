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
 *   • «идёт чтение» — это `status`, а не просто серые полоски.
 *
 * Что НЕ объявлено — тоже осознанно и записано в README: роль `tree` у проводника
 * не выставлена, потому что она обещает ход стрелками внутри дерева, а его у нас нет.
 */

const UI = resolve(process.cwd(), 'src/renderer/ui');

function source(name: string): string {
  return readFileSync(resolve(UI, name), 'utf8');
}

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
});

describe('папка дерева говорит, раскрыта ли она', () => {
  it('у папки есть `aria-expanded`, у выбранной строки — `aria-current`', () => {
    const EXPLORER = source('explorer.ts');
    expect(EXPLORER).toMatch(/isDirectory \? \{ 'aria-expanded': isExpanded \? 'true' : 'false' \} : \{\}/);
    expect(EXPLORER).toMatch(/'aria-current': 'true'/);
  });

  it('роль `tree` не выставлена — хода стрелками по дереву у нас нет', () => {
    // Так честнее: `treeitem` обещает клавиатурный ход внутри дерева, которого нет.
    expect(source('explorer.ts')).not.toMatch(/role: 'tree('|item')/);
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

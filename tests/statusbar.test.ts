import { describe, expect, it, vi } from 'vitest';
import { installMiniDom } from './helpers/mini-dom';
import { createStatusBar } from '../src/renderer/ui/statusbar';

/**
 * П.21: статусная строка — орган управления, а не справка.
 *
 * Слоты с действием были кнопками и раньше, но читалка видела набор чисел и букв:
 * «12:3» и «LF» — это не имена. Теперь у каждого такого слота есть слова, у самой
 * полосы — роль `toolbar`, а безымянных кнопок в ней не остаётся.
 *
 * Стенд — `tests/helpers/mini-dom.ts`: настоящий DOM не нужен, проверяем имена
 * и роль, а не то, как полоса нарисована.
 */

installMiniDom();

function bar() {
  const noop = vi.fn();
  const view = createStatusBar({
    openGitManager: noop,
    openPythonEnv: noop,
    openNodeEnv: noop,
    openProblems: noop,
    forceHighlight: noop,
    cancelWork: noop,
    openLsp: noop,
    runCommand: noop,
    openChoice: noop,
  });
  view.update({
    eol: 'LF',
    encoding: 'UTF-8',
    language: 'TypeScript',
    line: 12,
    column: 3,
    tabSize: 2,
    useTabs: false,
  });
  return view.element;
}

/** Имя, которое прочитает читалка: `aria-label`, иначе — текст узла. */
function nameOf(element: Element): string {
  return (element.getAttribute('aria-label') ?? element.textContent ?? '').trim();
}

describe('статусная строка: клавиатура и читалка', () => {
  it('полоса — панель инструментов с именем, а не голый div', () => {
    const root = bar();
    expect(root.getAttribute('role')).toBe('toolbar');
    expect(root.getAttribute('aria-label')).not.toBe('');
  });

  it('у каждой видимой кнопки есть имя словами, а не только значение', () => {
    // Скрытый слот пропускаем: он не показывается ни глазом, ни читалкой.
    const buttons = [...bar().querySelectorAll('button')].filter(
      (button) => (button as HTMLElement).hidden !== true,
    );
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      // «12:3» и «LF» именем не считаются: имя — это фраза, в ней есть пробел.
      expect(nameOf(button)).toMatch(/\s/);
    }
  });

  it('«строка:столбец» называются по-человечески и идут за кареткой', () => {
    const root = bar();
    const position = [...root.querySelectorAll('button')].find(
      (button) => button.textContent === '12:3',
    );
    expect(position).toBeTruthy();
    expect(position?.getAttribute('aria-label')).toBe('Строка 12, столбец 3');
  });
});

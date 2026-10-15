import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Страж каркаса модальных окон (`src/renderer/ui/modal.ts`).
 *
 * Окон в интерфейсе два десятка, и раньше каждое строило задник, шапку и кнопку
 * «закрыть» само, а обработчик Escape вешало на `document` НАВСЕГДА — даже у
 * скрытого окна. Теперь разметка и поведение живут в одном месте, и сторож держит
 * две вещи, которые легко потерять по отдельности:
 *
 *   1. ни одно окно не собирает каркас заново — все идут через `createModal`;
 *   2. сам каркас умеет то, ради чего он заведён: Escape только пока окно открыто,
 *      Tab по кругу, `aria-modal` и возврат фокуса.
 *
 * Проверка по тексту модулей: DOM-тестов у проекта нет (vitest идёт в окружении
 * node, без jsdom), а поведение окна вживую смотрит `npm run probe:editor`.
 */

const UI_DIR = resolve(process.cwd(), 'src/renderer/ui');
const MODAL_SHELL = readFileSync(resolve(UI_DIR, 'modal.ts'), 'utf8');

/** Модули, которые показывают модальное окно: `*-modal.ts` плюс окна-инструменты. */
function modalModules(): string[] {
  return readdirSync(UI_DIR)
    .filter((name) => name.endsWith('-modal.ts'))
    .concat(['regex-tester.ts', 'structural-search.ts'])
    .sort();
}

/** Исходник модуля без комментариев: строки в шапке не должны считаться кодом. */
function codeOf(name: string): string {
  return readFileSync(resolve(UI_DIR, name), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
}

describe('каркас модальных окон', () => {
  it('каждое окно строится через `createModal`, а не своим задником', () => {
    const offenders = modalModules().filter((name) => !codeOf(name).includes('createModal'));
    expect(offenders).toEqual([]);
  });

  it('задник (`modal-backdrop`) строит ТОЛЬКО каркас', () => {
    const owners = readdirSync(UI_DIR)
      .filter((name) => name.endsWith('.ts'))
      .filter((name) => codeOf(name).includes('modal-backdrop'));
    expect(owners).toEqual(['modal.ts']);
  });

  it('Escape слушается только пока окно открыто и снимается при закрытии', () => {
    expect(MODAL_SHELL).toContain("document.addEventListener('keydown', onKeyDown, true)");
    expect(MODAL_SHELL).toContain("document.removeEventListener('keydown', onKeyDown, true)");
    // Слушатель ставится на следующем тике: иначе окно закрыло бы то же нажатие,
    // которым его открыли.
    expect(MODAL_SHELL).toMatch(/setTimeout\(\(\) => \{[\s\S]*?addEventListener\('keydown'/);
  });

  it('окно объявлено диалогом и подписано заголовком', () => {
    expect(MODAL_SHELL).toContain("role: 'dialog'");
    expect(MODAL_SHELL).toContain("'aria-modal': 'true'");
    // Имя берётся у заголовка (`aria-labelledby`), а не у застывшего `aria-label`:
    // текст заголовка меняется при каждом открытии.
    expect(MODAL_SHELL).toContain("'aria-labelledby': titleId");
  });

  it('Tab не выходит за пределы окна', () => {
    expect(MODAL_SHELL).toContain('focusableIn');
    expect(MODAL_SHELL).toMatch(/event\.key === 'Tab'/);
    expect(MODAL_SHELL).toMatch(/event\.shiftKey/);
  });

  it('фокус возвращается туда, откуда его забрали', () => {
    expect(MODAL_SHELL).toMatch(/restoreFocus = document\.activeElement/);
    expect(MODAL_SHELL).toMatch(/target\.focus\(\)/);
  });

  it('фон помечается `aria-hidden`, пока окно открыто', () => {
    expect(MODAL_SHELL).toContain('setBackgroundHidden');
    expect(MODAL_SHELL).toContain("app.setAttribute('aria-hidden', 'true')");
    expect(MODAL_SHELL).toContain("app.removeAttribute('aria-hidden')");
  });
});

describe('тело окна не раскладывается в две колонки по умолчанию', () => {
  const MAIN = readFileSync(resolve(process.cwd(), 'src/renderer/styles/main.css'), 'utf8');

  it('общий `.modal-body` — столбец', () => {
    const rule = MAIN.match(/\n\.modal-body \{([^}]*)\}/)?.[1] ?? '';
    expect(rule).not.toBe('');
    expect(rule).toContain('display: flex');
    expect(rule).toContain('flex-direction: column');
    // Сетка из двух колонок была тут и раскладывала в первую (190 px) всё, что окна
    // кладут в тело — текст переносился по узкой полосе.
    expect(rule).not.toContain('grid-template-columns');
  });

  it('две колонки оставлены только окну настроек', () => {
    expect(MAIN).toMatch(/\.settings-modal \.modal-body \{[\s\S]*?grid-template-columns:\s*190px/);
  });
});

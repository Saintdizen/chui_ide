import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Части таблицы стилей интерфейса: `main.css` — это сборка из них через `@import`,
 * и порядок частей здесь ТОТ ЖЕ, что в каскаде (позднее правило перекрывает раннее).
 *
 * Сторожам нужен именно этот список: они читают правила по тексту, а правило из
 * `git.css` для них — то же самое, что и из прежнего одного `main.css`. Читать один
 * `main.css` больше нельзя: там остались только строки `@import`.
 */
export const MAIN_PARTS = ['chrome.css', 'chat.css', 'shell.css', 'git.css', 'views.css'];

/** Части плюс изолированные таблицы редактора и терминала (свои префиксы классов). */
export const COMPONENT_PARTS = [...MAIN_PARTS, 'editor.css', 'terminal.css'];

/** Абсолютный путь к файлу стилей. */
export function stylePath(name: string): string {
  return resolve(process.cwd(), 'src/renderer/styles', name);
}

/** Содержимое части. */
export function readStyle(name: string): string {
  return readFileSync(stylePath(name), 'utf8');
}

/** Все части, склеенные в порядке каскада. */
export function readMainCss(): string {
  return MAIN_PARTS.map(readStyle).join('\n');
}

/** Части вместе с таблицами редактора и терминала. */
export function readComponentCss(): string {
  return COMPONENT_PARTS.map(readStyle).join('\n');
}

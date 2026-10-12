/**
 * Комментарий строки для каждого языка (то, что ставит `Ctrl+/`).
 *
 * Знание это про язык, а не про редактор, и раньше жило вместе с чужим движком
 * (`language-modes.ts`). При снятии движка таблица потерялась вместе с ним, а
 * `Ctrl+/` — одна из тех клавиш, которых в редакторе ждут по умолчанию. Держим
 * таблицу здесь: ключи — те же идентификаторы, что в реестре языков
 * (`shared/languages.ts`); язык без записи — значит «строчного комментария у него
 * нет», и клавиша не делает ничего (лучше так, чем поставить `//` в markdown).
 */

import type { TextChange } from '../core/history';
import type { TextBuffer } from '../core/text-buffer';
import { selectionEnd, selectionStart, type Selection } from '../view/selection';

const LINE_COMMENT: Readonly<Record<string, string>> = {
  typescript: '//',
  javascript: '//',
  json: '//',
  java: '//',
  kotlin: '//',
  swift: '//',
  c: '//',
  cpp: '//',
  csharp: '//',
  go: '//',
  rust: '//',
  dart: '//',
  scala: '//',
  groovy: '//',
  php: '//',
  css: '//',
  scss: '//',
  less: '//',
  python: '#',
  shell: '#',
  yaml: '#',
  ruby: '#',
  perl: '#',
  r: '#',
  makefile: '#',
  dockerfile: '#',
  toml: '#',
  ini: ';',
  sql: '--',
  lua: '--',
  // Markdown, HTML и XML комментируются только блоком — построчного знака у них нет.
};

/** Знак строчного комментария для языка (`null` — у языка его нет). */
export function lineCommentFor(languageId: string | null | undefined): string | null {
  return languageId ? (LINE_COMMENT[languageId] ?? null) : null;
}

/** Что даёт переключение: правки (в порядке применения) и новое выделение. */
export interface CommentToggle {
  changes: TextChange[];
  selection: Selection;
}

/** Ведущие пробелы и табы строки — комментарий ставится ПОСЛЕ них. */
function indentOf(text: string): string {
  return /^[\t ]*/.exec(text)?.[0] ?? '';
}

/**
 * Переключить строчный комментарий у строк выделения (или у строки с курсором).
 *
 * Правило то же, что в привычных редакторах: если помечены ВСЕ непустые строки
 * диапазона — снимаем знак, иначе ставим. Пустые строки на решение не влияют и сами
 * не комментируются: `//` в пустой строке — мусор, а не «закомментированная пустота».
 * Правки отдаём в порядке применения (с конца документа к началу), чтобы смещения
 * друг друга не сдвигали.
 */
export function toggleLineComment(buffer: TextBuffer, selection: Selection, token: string): CommentToggle | null {
  const first = buffer.lineAt(selectionStart(selection));
  const last = buffer.lineAt(selectionEnd(selection));

  const lines: Array<{ line: number; text: string; indent: string; empty: boolean }> = [];
  for (let line = first; line <= last; line += 1) {
    const text = buffer.lineText(line);
    const indent = indentOf(text);
    lines.push({ line, text, indent, empty: indent.length === text.length });
  }

  const content = lines.filter((item) => !item.empty);
  if (content.length === 0) return null;
  const allCommented = content.every((item) => item.text.startsWith(token, item.indent.length));

  const changes: TextChange[] = [];
  for (const item of lines) {
    if (item.empty) continue;
    const at = buffer.lineStart(item.line) + item.indent.length;
    if (allCommented) {
      // Снимаем знак вместе с одним пробелом после него, если он там есть: так
      // возврат к прежнему тексту выходит посимвольным.
      const rest = item.text.slice(item.indent.length + token.length);
      const drop = rest.startsWith(' ') ? token.length + 1 : token.length;
      const removed = item.text.slice(item.indent.length, item.indent.length + drop);
      changes.push({ start: at, removed, inserted: '' });
    } else {
      changes.push({ start: at, removed: '', inserted: `${token} ` });
    }
  }

  changes.sort((a, b) => b.start - a.start);
  return { changes, selection };
}

// Пакет грузится динамически: `cspell-lib` — чистый ESM (`"type": "module"` и один
// `import` в `exports`), а main собирается в CommonJS под electron. Статический импорт
// tsc отверг бы на разрешении модулей; `await import()` им же переписывается в
// нативный ESM-загрузчик и работает в CJS-сборке (проверено на выходе tsc).

import type { LspDiagnostic } from '../../shared/api/lsp';
import type { SpellIssueLike as SpellIssue } from 'cspell-lib';

/** Что нам нужно от настроек cSpell: свои слова сверху словарей пакета. */
type CSpellUserSettings = Record<string, unknown> & { words?: string[] };

async function loadCspell(): Promise<typeof import('cspell-lib')> {
  return import('cspell-lib');
}

/** Настройки cSpell по умолчанию (словари из `@cspell/cspell-bundled-dicts`). Один раз. */
let settingsOnce: Promise<CSpellUserSettings> | null = null;

async function baseSettings(cspell: typeof import('cspell-lib')): Promise<CSpellUserSettings> {
  settingsOnce ??= cspell.getDefaultBundledSettingsAsync() as Promise<CSpellUserSettings>;
  return settingsOnce;
}

/**
 * Орфография через cSpell — теми же словарями, что у проекта в CI.
 *
 * Зачем свой движок поверх встроенного (`shared/spellcheck.ts`): встроенный знает
 * русский и английский из одного файла, а у проекта словарный запас другой — имена
 * библиотек, термины, ­русские слова в английских текстах. У cSpell есть файл
 * `cspell.json` и словари из `@cspell/cspell-bundled-dicts`, и если команда их уже
 * настроила, спорить с ней нечем: подчёркивания должны совпадать с её прогоном.
 *
 * Модуль отдельный от `dictionary.ts`: там словари для быстрой проверки в окне,
 * здесь — точный разбор одного файла по запросу.
 */

/**
 * Проверить текст файла и вернуть пометки в виде диагностик — чтобы они легли
 * на те же полосы, что ошибки от языкового сервера, и человек не учил два вида.
 *
 * Слова проекта (`words`) идут сверху глобальных: то, что человек внёс в этом
 * проекте, важнее того, что лежит в его домашней папке.
 */
export async function spellServerDiagnostics(
  path: string,
  text: string,
  words: readonly string[] = [],
): Promise<LspDiagnostic[]> {
  const cspell = await loadCspell();
  const base = await baseSettings(cspell);
  const settings: CSpellUserSettings = {
    ...base,
    // Свои слова проекта — первыми: они про этот код, а не про мир вообще.
    words: [...words, ...(base.words ?? [])],
  };
  const document = cspell.createTextDocument({ uri: `file://${path}`, content: text });
  const result = await cspell.spellCheckDocument(document, {}, settings);
  return (result.issues ?? []).map((issue) => toDiagnostic(issue, text));
}

/** Одна находка cSpell в диагностику: строка и колонка — из смещения в тексте. */
function toDiagnostic(issue: SpellIssue, text: string): LspDiagnostic {
  const start = offsetToPosition(text, issue.offset);
  const length = issue.length ?? issue.text.length;
  const end = offsetToPosition(text, issue.offset + length);
  return {
    severity: 'warning',
    line: start.line,
    column: start.column,
    endLine: end.line,
    endColumn: end.column,
    // `message` у cSpell пуст: он оставляет его рендерить тому, кто показывает.
    // Собираем сами — иначе человек видит полоску без слов.
    message: issue.message || `Неизвестное слово: «${issue.text}»`,
    source: 'cspell',
    // Подсказки замен — в саму пометку: быстрое исправление покажет их списком.
    ...(issue.suggestions && issue.suggestions.length > 0
      ? { code: issue.suggestions.slice(0, 5).join(' ') }
      : {}),
  };
}

/** Одна находка cSpell — тип берём из объявления модуля (`cspell-lib.d.ts`). */

/**
 * Смещение в тексте → строка и колонка (обе с нуля, как у LSP).
 * Считаем шагом, а не `split('\n')`: на большом файле массив строк дороже одного прохода.
 */
export function offsetToPosition(
  text: string,
  offset: number,
): { line: number; column: number } {
  const clamped = Math.max(0, Math.min(offset, text.length));
  let line = 0;
  let lastBreak = -1;
  for (let index = 0; index < clamped; index += 1) {
    if (text.charCodeAt(index) === 10) {
      line += 1;
      lastBreak = index;
    }
  }
  return { line, column: clamped - lastBreak - 1 };
}

import type { TextEdit } from './edits';

/**
 * Концы строк в файле: `\r\n` (Windows) или `\n` (всё остальное).
 *
 * Модель документа у нас одна — `\n` (см. `workspace.readFile`): иначе позиции правок
 * и разборы LSP расходятся. Но записывать файл обратно надо тем же концом, каким он
 * пришёл с диска, иначе сохранение в проекте с `core.autocrlf=false` без единой правки
 * переписывает все строки файла и делает `git diff` нечитаемым.
 */
export type LineEnding = '\n' | '\r\n';

/** Подпись для статусбара: `LF` / `CRLF`. */
export function lineEndingLabel(eol: LineEnding): string {
  return eol === '\r\n' ? 'CRLF' : 'LF';
}

/**
 * Какой конец строк в тексте файла. Считаем вхождения: побеждает тот, которого больше
 * (`\r\n` проверяем первым и вычитаем, иначе он был бы посчитан дважды — и как `\r`,
 * и как `\n`). Файл из одной строки без переводов — платформенный вариант.
 */
export function detectLineEnding(text: string, fallback: LineEnding = '\n'): LineEnding {
  let crlf = 0;
  let lf = 0;
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    if (index > 0 && text.charAt(index - 1) === '\r') crlf += 1;
    else lf += 1;
  }
  if (crlf === 0 && lf === 0) return fallback;
  return crlf > lf ? '\r\n' : '\n';
}

/**
 * Текст для записи на диск: переводы строк приведены к `eol`.
 *
 * Замена слепая, `\n` → `\r\n`, поэтому в тексте не должно оставаться одиночных `\r`
 * (модель документа их не держит) и голых `\n` внутри строковых литералов — второе
 * отдельный вопрос формата файла, а не концов строк: наш текстовый редактор меняет
 * концы строк во всём файле так же, как остальные.
 */
export function withLineEndings(text: string, eol: LineEnding): string {
  if (eol === '\n') return text;
  return text.replace(/\r\n|\n/g, '\r\n');
}

/**
 * Правки, которыми концы строк открытого документа переводятся на другой вариант.
 * Именно правки, а не замена текста: они идут в общий undo и пересчёт позиций
 * (`applyTextEdits`), как любое действие пользователя.
 *
 * Модель документа всегда в `\n`, поэтому:
 *  - в `\r\n` — вставка `\r` перед каждым переводом строки;
 *  - в `\n` — снятие уже стоящего `\r` перед переводом (документ мог прийти из другого
 *    источника с CRLF: вставка из буфера и правки с диска его не нормализуют).
 */
export function lineEndingEdits(text: string, to: LineEnding): TextEdit[] {
  const edits: TextEdit[] = [];
  let line = 1;
  let lineStart = 0;
  // Один проход по тексту от начала: иначе на каждый конец строки новый проход от
  // нуля, и выбор формата на большом файле стал бы квадратичным.
  for (let index = text.indexOf('\n'); index !== -1; index = text.indexOf('\n', index + 1)) {
    const hasCarriage = index > 0 && text.charAt(index - 1) === '\r';
    if (to === '\r\n' && !hasCarriage) {
      edits.push({
        startLine: line,
        startColumn: index - lineStart + 1,
        endLine: line,
        endColumn: index - lineStart + 1,
        newText: '\r',
      });
    } else if (to === '\n' && hasCarriage) {
      edits.push({
        startLine: line,
        startColumn: index - lineStart,
        endLine: line,
        endColumn: index - lineStart + 1,
        newText: '',
        // Сверка перед применением: колонки считаются с единицы, поэтому `\r` — это
        // `index - lineStart` (символ перед переводом), а не та же колонка, что у `\n`.
        // Если позиция посчитана не туда — правка не пройдёт молча (`TextEdit.oldText`).
        oldText: '\r',
      });
    }
    line += 1;
    lineStart = index + 1;
  }
  return edits;
}

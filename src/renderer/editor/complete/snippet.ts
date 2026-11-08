/**
 * Раскрытие сниппета: тело с местами подстановки → текст и места для курсора.
 *
 * Сниппеты в проекте записаны привычной разметкой (`${1:имя}`, `$0`) — их заводит
 * человек в настройках, и менять этот формат нельзя: он привычен и уже описан
 * (`shared/snippets.ts`). Но раскрывает разметку САМ редактор, а чужого движка здесь
 * больше нет — поэтому разбор свой. Как и принято, `${1:имя}` становится местом с
 * подстановкой, а `$0` — точкой, где встанет курсор после подстановок.
 *
 * Модуль чистый: на вход строка, на выход текст и места. Ни буфера, ни DOM — поэтому
 * разбор проверяется тестами без окна, а редактор только применяет результат.
 */

/** Место подстановки в раскрытом тексте: границы и номер. */
export interface SnippetTabstop {
  /** Номер места: 1, 2, 3… Порядок номеров — порядок обхода. */
  readonly index: number;
  /** Начало и конец текста места (замена подстановки), смещения UTF-16. */
  readonly start: number;
  readonly end: number;
}

export interface ExpandedSnippet {
  /** Тело без разметки: подстановки заменены их текстом. */
  readonly text: string;
  /** Места по порядку номеров (без `$0` — это конечная точка, а не текст). */
  readonly tabstops: readonly SnippetTabstop[];
  /** Куда встать курсором: начало первого места или конец текста. */
  readonly caret: number;
  /** Конец выделения при постановке курсора: обычно совпадает с концом места. */
  readonly selectionEnd: number;
  /**
   * Места с выбором (`${1|да,нет|}`): номер, где оно в тексте и варианты.
   * Первый вариант уже вставлен; листание — отдельный жест, потому что Tab
   * занят переходом к следующему месту.
   */
  readonly choices: readonly SnippetChoice[];
}

/** Место с выбором: что можно поставить вместо вставленного значения. */
export interface SnippetChoice {
  readonly index: number;
  readonly start: number;
  readonly end: number;
  readonly options: readonly string[];
}

/** Значения переменных сниппета (`TM_FILENAME`, `CLIPBOARD`, …). */
export type SnippetVariables = Readonly<Record<string, string>>;

/**
 * Разложить тело сниппета. Понимает `${N}`, `${N:текст}` и `$N`; экранированный `\$`
 * остаётся обычным долларом. Вложенных подстановок не разбираем: в наборе проекта их
 * нет, а поддерживать то, что не встречается, — держать непроверенный код.
 */
export function expandSnippet(
  body: string,
  variables: SnippetVariables = {},
): ExpandedSnippet {
  let text = '';
  const tabstops: SnippetTabstop[] = [];
  const choices: SnippetChoice[] = [];
  let caretAtEnd: number | null = null;

  let i = 0;
  while (i < body.length) {
    const char = body[i]!;
    if (char === '\\' && body[i + 1] === '$') {
      // Экранированный доллар — просто знак, а не начало разметки.
      text += '$';
      i += 2;
      continue;
    }
    if (char !== '$') {
      text += char;
      i += 1;
      continue;
    }

    if (body[i + 1] === '{') {
      const close = findClose(body, i + 2);
      // Незакрытая подстановка — знак как есть: тело пришло из настроек, и молча
      // съесть кусок хуже, чем показать его буквально.
      if (close < 0) {
        text += char;
        i += 1;
        continue;
      }
      const inner = body.slice(i + 2, close);
      // `${1|a,b|}` — место с выбором. Разбираем ДО двоеточия: в варианте может
      // встретиться `:` (`${1|http://,file:|}`), и резать по нему — обрубок.
      const pipe = /^(\d+)\|([\s\S]*)\|$/.exec(inner);
      if (pipe) {
        const index = Number.parseInt(pipe[1] ?? '', 10);
        const options = (pipe[2] ?? '')
          .split(',')
          .map((option) => option.replace(/\\,/g, ',').trim());
        appendChoice(index, options);
        i = close + 1;
        continue;
      }
      const colon = inner.indexOf(':');
      const rawIndex = colon < 0 ? inner : inner.slice(0, colon);
      const placeholder = colon < 0 ? '' : inner.slice(colon + 1);
      if (/^[A-Za-z_]/.test(rawIndex)) {
        // `${TM_FILENAME}` — переменная, а не место: место — это число.
        text += variables[rawIndex] ?? '';
        i = close + 1;
        continue;
      }
      appendTabstop(rawIndex, placeholder);
      i = close + 1;
      continue;
    }

    // `$TM_FILENAME` без скобок: у переменной имя, а не число.
    if (/[A-Za-z_]/.test(body[i + 1] ?? '')) {
      let name = '';
      let k = i + 1;
      while (k < body.length && /[A-Za-z0-9_]/.test(body[k]!)) {
        name += body[k];
        k += 1;
      }
      text += variables[name] ?? `$${name}`;
      i = k;
      continue;
    }

    // `$1` без скобок: короткая форма места без текста.
    let digits = '';
    let j = i + 1;
    while (j < body.length && body[j]! >= '0' && body[j]! <= '9') {
      digits += body[j];
      j += 1;
    }
    if (digits.length > 0) {
      appendTabstop(digits, '');
      i = j;
      continue;
    }

    text += char;
    i += 1;
  }

  function appendTabstop(rawIndex: string, placeholder: string): void {
    const start = text.length;
    text += placeholder;
    const index = Number.parseInt(rawIndex, 10);
    if (!Number.isFinite(index)) return;
    if (index === 0) {
      // `$0` — место, где встанет курсор ПОСЛЕ всех подстановок; текста не несёт.
      caretAtEnd = caretAtEnd ?? start;
      return;
    }
    tabstops.push({ index, start, end: start + placeholder.length });
  }

  function appendChoice(index: number, options: readonly string[]): void {
    const value = options[0] ?? '';
    const start = text.length;
    text += value;
    if (!Number.isFinite(index) || index === 0) {
      caretAtEnd = caretAtEnd ?? start;
      return;
    }
    tabstops.push({ index, start, end: start + value.length });
    choices.push({ index, start, end: start + value.length, options });
  }

  tabstops.sort((a, b) => a.index - b.index);
  const first = tabstops[0];
  if (first) return { text, tabstops, choices, caret: first.start, selectionEnd: first.end };
  const final = caretAtEnd ?? text.length;
  return { text, tabstops, choices, caret: final, selectionEnd: final };
}

/** Найти закрывающую `}` подстановки, считая вложенные фигурные скобки. */
function findClose(body: string, from: number): number {
  let depth = 1;
  for (let i = from; i < body.length; i += 1) {
    const char = body[i];
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

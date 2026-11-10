/**
 * Что этой функции нужно от ячейки экрана терминала. Полный `Line` живёт в
 * renderer, а shared на renderer смотреть не вправе — поэтому тип структурный:
 * подходит и настоящая строка экрана, и подделка из тестов.
 */
export interface SnapshotCell {
  readonly chars: string;
  readonly width: number;
}

/** Строка экрана в том виде, в каком её видит выгрузка (см. `SnapshotCell`). */
export interface SnapshotLine {
  readonly cells: readonly SnapshotCell[];
}

/**
 * Текст терминала для модели.
 *
 * Модели нужен вывод, а не экран: пробелы до правого края, пустые строки
 * подвала и хвост истории — шум, который занимает токены и сбивает чтение.
 * Поэтому берём последние непустые строки и не тащим пустоту в конце.
 */
export interface TerminalSnapshot {
  /** Готовый текст: последние `limit` строк, без пустых на конце. */
  readonly text: string;
  /** Сколько строк реально попало — для подписи «последние N строк». */
  readonly lines: number;
}

/** Строка экрана в текст: без хвостовых пробелов, перенос склеивается. */
export function lineText(line: SnapshotLine): string {
  let text = '';
  for (const cell of line.cells) {
    // Пустая ячейка ширины 0 — продолжение широкого знака, а не пробел.
    if (cell.width === 0) continue;
    text += cell.chars;
  }
  return text.replace(/\s+$/, '');
}

/**
 * Последние содержательные строки вывода.
 *
 * `limit` — предел строк: больше модели всё равно не нужно, а платить за
 * прокрутку истории она не станет. Пустые строки в конце отбрасываются —
 * так экран выглядит после команды, а в контексте они бессмысленны.
 */
export function terminalSnapshot(lines: readonly SnapshotLine[], limit = 80): TerminalSnapshot {
  const texts = lines.map(lineText);
  // Обрезаем хвост из пустых строк: курсор обычно стоит на них.
  let end = texts.length;
  while (end > 0 && texts[end - 1] === '') end -= 1;
  if (end === 0) return { text: '', lines: 0 };

  const start = Math.max(0, end - limit);
  const picked = texts.slice(start, end);
  return { text: picked.join('\n'), lines: picked.length };
}

/**
 * Какие строки файла отличаются от сохранённой версии — для тепловой карты на
 * мини-карте.
 *
 * Зачем: прокрутив большой файл, не видно, где именно несохранённое. Прокрутка
 * вниз и обратно глазами не отвечает; карта отвечает одним взглядом.
 *
 * Это НЕ точный diff: он нужен экрану сравнения, где важна каждая пара строк.
 * Здесь нужна метка «здесь есть правка», и быстрый способ важнее аккуратного —
 * считается на каждое изменение текста, в том числе на каждый набор символа.
 */

/**
 * Строки (с 1), которые есть в `current` и которых не было в `saved` — по
 * номерам в `current`.
 *
 * Без общих префикса и суффикса: вставка посреди файла сдвигает всё после неё,
 * и без среза на каждый символ помечались бы тысячи строк. Что правка сдвинула
 * остальное — правда, но карта от этого становится сплошной и бесполезной.
 */
export function changedLines(saved: string, current: string): number[] {
  if (saved === current) return [];
  const before = saved.split('\n');
  const after = current.split('\n');

  // Общий префикс: от начала до первой разной строки — это не правка.
  let start = 0;
  while (start < before.length && start < after.length && before[start] === after[start]) start += 1;
  // Общий суффикс: симметрично с конца, но не заходя в уже срезанный префикс.
  let tail = 0;
  while (
    tail < before.length - start &&
    tail < after.length - start &&
    before[before.length - 1 - tail] === after[after.length - 1 - tail]
  ) {
    tail += 1;
  }

  const lines: number[] = [];
  for (let index = start; index < after.length - tail; index += 1) lines.push(index + 1);
  return lines;
}

/**
 * Слить соседние строки в полосы: `[1,2,3,7]` → `[{from:1,to:3},{from:7,to:7}]`.
 *
 * Мини-карта рисует пятно на строку, но проверять «изменена ли строка» для
 * тысяч строк на каждую перерисовку дороже, чем пройти полосы.
 */
export function changeRuns(lines: readonly number[]): Array<{ from: number; to: number }> {
  const runs: Array<{ from: number; to: number }> = [];
  for (const line of lines) {
    const last = runs[runs.length - 1];
    if (last && line === last.to + 1) last.to = line;
    else runs.push({ from: line, to: line });
  }
  return runs;
}

/**
 * Кэш списка правок на документ: сравнение стоит прохода по строкам, а
 * перерисовок у редактора много (каждое движение каретки).
 *
 * Ключ — версия документа: пока она та же, и список тот же. Сохранение меняет
 * версию сохранения, и запись обновляется сама.
 */
export interface ChangedLinesCache {
  lines(text: string, savedText: string, version: number): number[];
}

export function createChangedLinesCache(limit = 32): ChangedLinesCache {
  const entries = new Map<string, { version: number; lines: number[] }>();
  return {
    lines(text, savedText, version) {
      const found = entries.get(savedText.slice(0, 64));
      // Ключ — начало сохранённого текста: у разных файлов он почти всегда
      // различается уже в первых строках, а возиться с хешем всего файла на
      // каждое движение каретки дороже, чем сравнить две короткие строки.
      if (found && found.version === version) return found.lines;
      const lines = changedLines(savedText, text);
      if (entries.size >= limit) entries.delete(entries.keys().next().value as string);
      entries.set(savedText.slice(0, 64), { version, lines });
      return lines;
    },
  };
}

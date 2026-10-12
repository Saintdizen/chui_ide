/**
 * Таблица визуальных рядов: сколько рядов занимает каждая строка и где они лежат.
 *
 * Когда у строки бывает больше одного ряда (перенос длинных строк), «номер строки» и
 * «ряд экрана» расходятся: строка 10 может занимать ряды 14, 15 и 16. Всё, что считает
 * «строка → y» или «y → строка» (прокрутка, каретка, клик), должно уметь переводить
 * туда и обратно. Перевод собирается тут: массив «сколько рядов у строки» плюс его
 * префиксные суммы — по ним ряд строки берётся за O(1), а строка по ряду — двоичным
 * поиском за O(log n).
 *
 * Строки нумеруются с единицы (как для человека), ряды — с нуля (как на экране): так
 * же, как в представлении. Строка со счётчиком 0 (скрытая свёрткой) рядов не занимает
 * и в переводе просто пропускается.
 *
 * Модуль чистый: только арифметика над числами, ни DOM, ни буфера.
 */

/** Где стоит ряд: какая это строка и какой по счёту её ряд. */
export interface RowLine {
  /** Номер строки (с единицы). */
  readonly line: number;
  /** Какой по счёту ряд этой строки (с нуля). */
  readonly segment: number;
}

export class RowMap {
  /** Сколько рядов у каждой строки (индекс — строка минус один). */
  private counts: number[] = [];
  /** Префиксные суммы: `prefix[k]` — сколько рядов занимают строки 1…k. */
  private prefix: number[] = [0];

  /** Сколько рядов занимает весь документ. */
  get rowTotal(): number {
    return this.prefix[this.prefix.length - 1] ?? 0;
  }

  /** Сколько строк в таблице. */
  get lineCount(): number {
    return this.counts.length;
  }

  /** Пересобрать таблицу по новым счётчикам. */
  rebuild(counts: readonly number[]): void {
    const built = new Array<number>(counts.length);
    const prefix = new Array<number>(counts.length + 1);
    prefix[0] = 0;
    for (let index = 0; index < counts.length; index += 1) {
      const count = Math.max(0, counts[index]!);
      built[index] = count;
      prefix[index + 1] = prefix[index]! + count;
    }
    this.counts = built;
    this.prefix = prefix;
  }

  /** Ряд, с которого начинается строка (с нуля). */
  rowOf(line: number): number {
    const index = Math.max(0, Math.min(line - 1, this.counts.length));
    return this.prefix[index] ?? 0;
  }

  /** Сколько рядов у строки (0 — скрыта). */
  countOf(line: number): number {
    return this.counts[line - 1] ?? 0;
  }

  /** Строка и её ряд по номеру ряда (с нуля). За пределами — ближайший край. */
  lineAtRow(row: number): RowLine {
    const total = this.rowTotal;
    if (this.counts.length === 0 || total <= 0) return { line: 1, segment: 0 };
    const target = Math.max(0, Math.min(row, total - 1));
    // Наибольшая строка, чей первый ряд не позже искомого. Строки со счётчиком 0
    // пропускаются сами собой: у них первый ряд совпадает со следующим.
    let low = 1;
    let high = this.counts.length;
    let line = 1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if ((this.prefix[middle - 1] ?? 0) <= target) {
        line = middle;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return { line, segment: target - (this.prefix[line - 1] ?? 0) };
  }
}

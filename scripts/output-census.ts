/**
 * Перепись вывода инструментов: сколько токенов каждый инструмент вкладывает в
 * контекст. Дополняет `call-census.ts`: тот считает, ЧТО зовут, этот — СКОЛЬКО
 * это стоит модели.
 *
 * Текст результата становится входом следующих запросов. Его реальная цена
 * зависит от провайдера и кеша: ниже оценка объёма, не счёт за API.
 *
 * Что считаем:
 *  - токены вывода по инструментам (средние, максимум);
 *  - виды чтений: первое, точный повтор, перекрытие запросов, продолжение файла и
 *    перечитывание после правки (нужны). Грубый счёт «повторов» валит в одну кучу
 *    и дочитывание следующего диапазона — без него кода просто не увидеть;
 *  - длина целых чтений в строках — цена `WHOLE_FILE_MAX_LINES`;
 *  - `search`: сколько совпадений приходит — цена `DEFAULT_SEARCH_HITS`.
 *
 * Запуск: npx tsx scripts/output-census.ts [каталог-бесед]
 */
import { argumentsOf, censusHeader, isFailure, loadCensus, readRangeOf, searchHitCount, textOf } from './census-data';
import { estimateTextTokens } from '../src/shared/context-fit';

const sample = loadCensus();
console.log(censusHeader(sample));

const stats = new Map<string, { calls: number; tokens: number; max: number }>();
/** Виды чтений: что стоит модели денег, а что — необходимость. */
const kinds = new Map<string, { calls: number; tokens: number }>();
/** Длина целых чтений в строках: сколько текста отдают без номеров. */
const wholeLines: number[] = [];
/** Сколько совпадений вернул `search`. */
const searchHits: number[] = [];
let truncatedSearches = 0;
let failedSearches = 0;

function add(target: Map<string, { calls: number; tokens: number }>, key: string, tokens: number): void {
  const row = target.get(key) ?? { calls: 0, tokens: 0 };
  row.calls += 1;
  row.tokens += tokens;
  target.set(key, row);
}

for (const messages of sample.messages) {
  const names = new Map<string, string>();
  const args = new Map<string, string>();
  for (const message of messages) {
    for (const call of message.toolCalls ?? []) {
      if (!call.id || !call.name) continue;
      names.set(call.id, call.name);
      args.set(call.id, call.arguments ?? '');
    }
  }
  // Что уже отдано по каждому файлу и менялся ли он с тех пор: без «менялся»
  // перечитывание после правки не отличить от повторного мусора.
  const covered = new Map<string, { from: number; to: number; whole: boolean }[]>();
  const edited = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'tool' || !message.toolCallId) continue;
    const name = names.get(message.toolCallId) ?? 'unknown';
    const text = textOf(message.content);
    const tokens = estimateTextTokens(text);
    const row = stats.get(name) ?? { calls: 0, tokens: 0, max: 0 };
    row.calls += 1;
    row.tokens += tokens;
    row.max = Math.max(row.max, tokens);
    stats.set(name, row);
    const raw = args.get(message.toolCallId) ?? '';
    const target = argumentsOf(raw).path;
    const path = typeof target === 'string' ? target : undefined;
    if (path && (name === 'edit' || name === 'file') && !isFailure(message)) edited.add(path);
    // `search`: пустая строка в ответе — прямой сигнал, что выдача обрезана и
    // модель может попросить больше; считаем, сколько раз такое было.
    if (name === 'search') {
      const parsed = argumentsOf(raw);
      if (isFailure(message)) failedSearches += 1;
      else if (!parsed.filesOnly && (!parsed.action || parsed.action === 'text')) {
        searchHits.push(searchHitCount(text));
        if (/список неполный|список обрезан|ещ[её]\s+\d+/.test(text)) truncatedSearches += 1;
      }
    }
    if (!path || name !== 'read' || isFailure(message)) continue;
    const range = readRangeOf(raw);
    const seen = covered.get(path) ?? [];
    if (range.whole) wholeLines.push(text.split('\n').length);
    if (seen.length === 0) {
      add(kinds, 'первое чтение файла', tokens);
    } else if (edited.has(path)) {
      add(kinds, 'перечитывание после правки', tokens);
      edited.delete(path);
    } else if (seen.some((item) => item.from === range.from && item.to === range.to && item.whole === range.whole)) {
      add(kinds, 'точный повтор', tokens);
    } else if (seen.some((item) => item.whole || range.whole || (item.from <= range.to && range.from <= item.to))) {
      add(kinds, 'перекрытие запросов', tokens);
    } else {
      add(kinds, 'продолжение файла', tokens);
    }
    seen.push(range);
    covered.set(path, seen);
  }
}

console.log(`Всего вывода: ${[...stats.values()].reduce((sum, row) => sum + row.tokens, 0)} ток.\n`);
for (const [name, row] of [...stats].sort((a, b) => b[1].tokens - a[1].tokens)) {
  console.log(
    `${String(name).padEnd(12)} ${String(row.calls).padStart(4)} выз. ${String(row.tokens).padStart(8)} ток. ` +
      `сред ${Math.round(row.tokens / Math.max(1, row.calls))}, макс ${row.max}`,
  );
}

const readTotal = [...kinds.values()].reduce((sum, row) => sum + row.tokens, 0);
console.log(`\nЧтения: ${readTotal} ток.`);
for (const [kind, row] of [...kinds].sort((a, b) => b[1].tokens - a[1].tokens)) {
  const share = Math.round((100 * row.tokens) / Math.max(1, readTotal));
  console.log(
    `${String(kind).padEnd(26)} ${String(row.calls).padStart(4)} выз. ${String(row.tokens).padStart(8)} ток. ${String(share).padStart(3)}%`,
  );
}

const hitCounts = searchHits.filter((n) => n >= 0);
if (hitCounts.length > 0) {
  const sorted = [...hitCounts].sort((a, b) => a - b);
  const truncated = truncatedSearches;
  console.log(
    `\nsearch: ${sorted.length} выз., совпадений: медиана ${sorted[Math.floor(sorted.length / 2)]}, ` +
      `макс ${sorted[sorted.length - 1]}; обрезано: ${truncated}; отказов (не пустых результатов): ${failedSearches}`,
  );
  for (const limit of [10, 25, 50]) {
    console.log(
      `  не больше ${limit}: ${Math.round((100 * sorted.filter((n) => n <= limit).length) / sorted.length)}%`,
    );
  }
}

if (wholeLines.length > 0) {
  const sorted = [...wholeLines].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  console.log(
    `\nЦелые чтения: ${sorted.length}, строк: медиана ${at(0.5)}, 90% ${at(0.9)}, макс ${sorted[sorted.length - 1]}`,
  );
  for (const limit of [50, 100, 150, 250]) {
    console.log(
      `  короче ${limit} строк: ${Math.round((100 * sorted.filter((n) => n <= limit).length) / sorted.length)}%`,
    );
  }
}

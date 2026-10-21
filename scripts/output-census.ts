/**
 * Перепись вывода инструментов: сколько токенов каждый инструмент вкладывает в
 * контекст. Дополняет `call-census.ts`: тот считает, ЧТО зовут, этот — СКОЛЬКО
 * это стоит модели.
 *
 * Зачем: постоянная часть шага (схемы + промпт + ростер) при попадании в кеш
 * префикса стоит ~4% своего размера, а вывод инструмента — полную цену сразу и
 * ещё ~10% на каждом следующем шаге. Значит цена работы — это объём вывода.
 *
 * Что считаем:
 *  - токены вывода по инструментам (средние, максимум);
 *  - виды чтений: первое, точный повтор, перекрытие (мусор), продолжение файла и
 *    перечитывание после правки (нужны). Грубый счёт «повторов» валит в одну кучу
 *    и дочитывание следующего диапазона — без него кода просто не увидеть;
 *  - длина целых чтений в строках — цена `WHOLE_FILE_MAX_LINES`;
 *  - `search`: сколько совпадений приходит — цена `DEFAULT_SEARCH_HITS`.
 *
 * Запуск: npx tsx scripts/output-census.ts [каталог-бесед]
 */
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { estimateTextTokens } from '../src/shared/context-fit';
import { canonicalCall } from '../src/shared/tool-aliases';

interface Message {
  role?: string;
  content?: unknown;
  toolCallId?: string;
  toolCalls?: { id?: string; name?: string; arguments?: string }[];
}
interface ChatFile {
  conversations?: { uid?: string; messages?: Message[] }[];
}

const dir = process.argv[2] ?? join(homedir(), '.config/chui-ide/chats');

const stats = new Map<string, { calls: number; tokens: number; max: number }>();
/** Виды чтений: что стоит модели денег, а что — необходимость. */
const kinds = new Map<string, { calls: number; tokens: number }>();
/** Длина целых чтений в строках: сколько текста отдают без номеров. */
const wholeLines: number[] = [];
/** Сколько совпадений вернул `search`. */
const searchHits: number[] = [];

function add(target: Map<string, { calls: number; tokens: number }>, key: string, tokens: number): void {
  const row = target.get(key) ?? { calls: 0, tokens: 0 };
  row.calls += 1;
  row.tokens += tokens;
  target.set(key, row);
}

function rangeOf(raw: string): { from: number; to: number; whole: boolean } {
  const from = Number(/"startLine"\s*:\s*(\d+)/.exec(raw)?.[1] ?? 1);
  const to = Number(/"endLine"\s*:\s*(\d+)/.exec(raw)?.[1] ?? 0);
  return { from: Math.max(1, from), to, whole: to === 0 };
}

for (const file of readdirSync(dir).filter((name) => name.endsWith('.json'))) {
  const chat: ChatFile = JSON.parse(readFileSync(join(dir, file), 'utf8'));
  for (const conversation of chat.conversations ?? []) {
    const messages = conversation.messages ?? [];
    const names = new Map<string, string>();
    const args = new Map<string, string>();
    for (const message of messages) {
      for (const call of message.toolCalls ?? []) {
        if (!call.id || !call.name) continue;
        names.set(call.id, canonicalCall(call.name, call.arguments ?? '').name);
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
      const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
      const tokens = estimateTextTokens(text);
      const row = stats.get(name) ?? { calls: 0, tokens: 0, max: 0 };
      row.calls += 1;
      row.tokens += tokens;
      row.max = Math.max(row.max, tokens);
      stats.set(name, row);
      const raw = args.get(message.toolCallId) ?? '';
      const path = /"path"\s*:\s*"([^"]+)"/.exec(raw)?.[1];
      if (path && (name === 'edit' || name === 'file')) edited.add(path);
      // `search`: пустая строка в ответе — прямой сигнал, что выдача обрезана и
      // модель может попросить больше; считаем, сколько раз такое было.
      if (name === 'search') {
        const hits = text.match(/:\d+:/g)?.length ?? 0;
        searchHits.push(hits);
        if (/ещ[её]\s+\d+/.test(text)) searchHits.push(-hits);
      }
      if (!path || (name !== 'read' && name !== 'read_file')) continue;
      const range = rangeOf(raw);
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
        add(kinds, 'перекрытие (мусор)', tokens);
      } else {
        add(kinds, 'продолжение файла', tokens);
      }
      seen.push(range);
      covered.set(path, seen);
    }
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
  const truncated = searchHits.filter((n) => n < 0).length;
  console.log(
    `\nsearch: ${sorted.length} выз., совпадений: медиана ${sorted[Math.floor(sorted.length / 2)]}, ` +
      `макс ${sorted[sorted.length - 1]}; обрезано «ещё N»: ${truncated}`,
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

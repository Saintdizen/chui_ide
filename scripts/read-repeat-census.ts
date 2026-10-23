/**
 * Перепись повторов чтения: сколько вывода уходит на текст, который модель уже
 * видела. Дополняет `output-census.ts` (тот считает цену по инструментам) — этот
 * отвечает на вопрос «почему повторов столько»: память чтений чистят правки и
 * `terminal`, а шелл-читалки (`cat`, `grep`) идут мимо покрытия вообще.
 *
 * Что считаем:
 *  - виды чтений (первое, продолжение, точный повтор, перекрытие, перечитывание);
 *  - сколько токенов повтора пришло сразу после `terminal` — цена того, что
 *    непрозрачный вызов помечал покрытие сомнительным (или стирал целиком);
 *  - шелл-чтения внутри `terminal`, сколько из них начинается с `cd <abs> &&` и
 *    сколько — не чтение, а запись (`cat > x <<EOF`, `sed -i`);
 *  - цену номеров строк `N | ` в выводе `read`.
 *
 * Запуск: npx tsx scripts/read-repeat-census.ts [каталог-бесед]
 */
import { argumentsOf, censusHeader, isFailure, loadCensus, readRangeOf, textOf } from './census-data';
import { estimateTextTokens } from '../src/shared/context-fit';

const sample = loadCensus();
console.log(censusHeader(sample));

/** Команды, которыми читают файлы в обход `read`: их вывод покрытие не видит. */
const SHELL_READ = /^(cat|head|tail|sed|grep|rg|awk|less|more|git\s+(?:diff|show))\b/;
/**
 * Та же команда, но с записью в файл: `cat > x <<EOF`, `sed -i`, `tee`. Вывод
 * такой команды пуст или это её же эхо, и покрытие она не портит — отделяем,
 * иначе они попадают в «шелл-чтения» и завышают цену выхода из `read`.
 * Редирект ищем вне кавычек: `grep -n '<<EOF' a.ts` — чтение, а `cat > x <<EOF`
 * — запись, и одной регуляркой этого не различить.
 */
function shellWrites(command: string): boolean {
  if (/\bsed\s+-i|\btee\b/.test(command)) return true;
  let quoted: string | null = null;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quoted) {
      if (char === quoted) quoted = null;
      continue;
    }
    if (char === "'" || char === '"') {
      quoted = char;
      continue;
    }
    if (char === '>') return true;
    if (char === '<' && command[i + 1] === '<') return true;
  }
  return false;
}

const kinds = new Map<string, { calls: number; tokens: number }>();
/** Повторы, пришедшие следом за `terminal`/правкой: их и должны снимать штампы. */
const afterDirty = {
  calls: 0,
  tokens: 0,
  /** Из них — запросы «весь файл»: только их теперь срезает подавление повторов. */
  wholeCalls: 0,
  wholeTokens: 0,
};
/** Пометки `N | ` в выводе `read`: строка-номер в каждой строке текста. */
const numbering = { chars: 0 };
const shell = { calls: 0, tokens: 0, cd: 0, cdTokens: 0, writes: 0 };

function add(key: string, tokens: number): void {
  const row = kinds.get(key) ?? { calls: 0, tokens: 0 };
  row.calls += 1;
  row.tokens += tokens;
  kinds.set(key, row);
}

/** Команда вызова `terminal`: JSON-разбор, а не регулярка по сырым аргументам. */
function commandOf(raw: string): string {
  try {
    const parsed: unknown = JSON.parse(raw);
    const command = (parsed as { command?: unknown } | null)?.command;
    return typeof command === 'string' ? command : '';
  } catch {
    return '';
  }
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
  const seen = new Map<string, { from: number; to: number; whole: boolean }[]>();
  const edited = new Set<string>();
  // Мог ли файл измениться после последнего чтения. `terminal` и правки без
  // названного файла — единственный источник сомнения, который нам виден.
  let dirty = false;

  for (const message of messages) {
    if (message.role !== 'tool' || !message.toolCallId) continue;
    const name = names.get(message.toolCallId) ?? 'unknown';
    const text = textOf(message.content);
    const tokens = estimateTextTokens(text);
    const raw = args.get(message.toolCallId) ?? '';

    if (name === 'terminal') {
      dirty = true;
      // Разбираем аргументы как JSON, а не ищем `"command"` регуляркой по сырому
      // тексту: иначе heredoc внутри скрипта (`python3 - <<'PY' … cd … &&`) даёт
      // ложные шелл-чтения — в замере таких оказалось 12 из 51.
      const command = commandOf(raw);
      const real = command.replace(/^cd\s+\S+\s*&&\s*/, '');
      const body = real.trim();
      if (SHELL_READ.test(body)) {
        if (shellWrites(body)) {
          // Читалка есть, но результат уходит в файл (`cat > x <<EOF`): чтения нет.
          shell.writes += 1;
        } else {
          shell.calls += 1;
          shell.tokens += tokens;
          if (real !== command) {
            shell.cd += 1;
            shell.cdTokens += tokens;
          }
        }
      }
      continue;
    }

    const target = argumentsOf(raw).path;
    const path = typeof target === 'string' ? target : undefined;
    if (path && (name === 'edit' || name === 'file') && !isFailure(message)) {
      edited.add(path);
      dirty = true;
    }
    if (!path || name !== 'read' || isFailure(message)) continue;

    numbering.chars += (text.match(/^\s*\d+ \| /gm) ?? []).join('').length;

    const range = readRangeOf(raw);
    const was = seen.get(path) ?? [];
    let kind: string;
    if (was.length === 0) kind = 'первое чтение файла';
    else if (edited.has(path)) {
      kind = 'перечитывание после правки';
      edited.delete(path);
    } else if (was.some((item) => item.from === range.from && item.to === range.to && item.whole === range.whole))
      kind = 'точный повтор';
    else if (was.some((item) => item.whole || range.whole || (item.from <= range.to && range.from <= item.to)))
      kind = 'перекрытие запросов';
    else kind = 'продолжение файла';

    add(kind, tokens);
    if (dirty && kind !== 'первое чтение файла') {
      afterDirty.calls += 1;
      afterDirty.tokens += tokens;
      // Не всё здесь срезаемо: readFile теперь подавляет только запрос «весь файл»
      // (нет startLine, endLine), который уже есть выше и не менялся. Куски и первые
      // чтения после правки оплачиваются честно — показываем их отдельно, чтобы
      // строка не читалась как «выйгрыш целиком».
      if (kind !== 'продолжение файла' && range.whole) {
        afterDirty.wholeCalls += 1;
        afterDirty.wholeTokens += tokens;
      }
    }
    dirty = false;
    was.push(range);
    seen.set(path, was);
  }
}

const readTotal = [...kinds.values()].reduce((sum, row) => sum + row.tokens, 0);
console.log(`Чтения: ${readTotal} ток.\n`);
for (const [kind, row] of [...kinds].sort((a, b) => b[1].tokens - a[1].tokens)) {
  const share = Math.round((100 * row.tokens) / Math.max(1, readTotal));
  console.log(
    `${kind.padEnd(26)} ${String(row.calls).padStart(4)} выз. ${String(row.tokens).padStart(8)} ток. ${String(share).padStart(3)}%`,
  );
}
console.log(
  `\nПовтор сразу после terminal/правки: ${afterDirty.tokens} ток. (${afterDirty.calls} выз.) — ` +
    'эвристика по запросам: фактическое изменение файла здесь неизвестно',
);
console.log(
  `  из них подавляемо (запрос «весь файл», уже есть выше): ${afterDirty.wholeTokens} ток. ` +
    `(${afterDirty.wholeCalls} выз.), остальное — куски и первые чтения, они платятся честно`,
);
console.log(
  `\nШелл-чтения в terminal: ${shell.calls} выз. ${shell.tokens} ток., из них с ведущим ` +
    `\`cd … &&\`: ${shell.cd} (${shell.cdTokens} ток.); ещё отвергнуто как запись, ` +
    `а не чтение (\`cat > x <<EOF\`, \`sed -i\`): ${shell.writes} выз. (в счёт выше не входят)`,
);
const numberTokens = estimateTextTokens('x'.repeat(numbering.chars));
console.log(
  `Номера строк в выводе read: ${numbering.chars} симв. ≈ ${numberTokens} ток. = ` +
    `${Math.round((100 * numberTokens) / Math.max(1, readTotal))}% чтений`,
);

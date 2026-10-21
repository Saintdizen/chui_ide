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
const afterDirty = { calls: 0, tokens: 0 };
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
    const seen = new Map<string, { from: number; to: number; whole: boolean }[]>();
    const edited = new Set<string>();
    // Мог ли файл измениться после последнего чтения. `terminal` и правки без
    // названного файла — единственный источник сомнения, который нам виден.
    let dirty = false;

    for (const message of messages) {
      if (message.role !== 'tool' || !message.toolCallId) continue;
      const name = names.get(message.toolCallId) ?? 'unknown';
      const text = typeof message.content === 'string' ? message.content : JSON.stringify(message.content ?? '');
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

      const path = /"path"\s*:\s*"([^"]+)"/.exec(raw)?.[1];
      if (path && (name === 'edit' || name === 'file')) {
        edited.add(path);
        dirty = true;
      }
      if (!path || name !== 'read') continue;

      numbering.chars += (text.match(/^\s*\d+ \| /gm) ?? []).join('').length;

      const range = rangeOf(raw);
      const was = seen.get(path) ?? [];
      let kind: string;
      if (was.length === 0) kind = 'первое чтение файла';
      else if (edited.has(path)) {
        kind = 'перечитывание после правки';
        edited.delete(path);
      } else if (was.some((item) => item.from === range.from && item.to === range.to && item.whole === range.whole))
        kind = 'точный повтор';
      else if (was.some((item) => item.whole || range.whole || (item.from <= range.to && range.from <= item.to)))
        kind = 'перекрытие (мусор)';
      else kind = 'продолжение файла';

      add(kind, tokens);
      if (dirty && kind !== 'первое чтение файла') {
        afterDirty.calls += 1;
        afterDirty.tokens += tokens;
      }
      dirty = false;
      was.push(range);
      seen.set(path, was);
    }
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
    'это и снимают штампы версий',
);
console.log(
  `\nШелл-чтения в terminal: ${shell.calls} выз. ${shell.tokens} ток., из них с ведущим ` +
    `\`cd … &&\`: ${shell.cd} (${shell.cdTokens} ток.); из них отсеяно как запись, ` +
    `а не чтение (\`cat > x <<EOF\`, \`sed -i\`): ${shell.writes}`,
);
const numberTokens = Math.round(numbering.chars / 4);
console.log(
  `Номера строк в выводе read: ${numbering.chars} симв. ≈ ${numberTokens} ток. = ` +
    `${Math.round((100 * numberTokens) / Math.max(1, readTotal))}% чтений`,
);

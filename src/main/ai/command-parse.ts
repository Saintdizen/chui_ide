/**
 * Разбор командной строки на то, что шелл запустит на самом деле.
 *
 * Регэкспы по тексту обходились на раз: `rm` прятали в `sh -c '…'`, `$(…)`,
 * `eval`, в хвост `xargs`. Поэтому вопрос «что здесь выполнится» задаём разбору:
 *
 *   1. строковые литералы (`sh -c '…'`, `eval "…"`) разворачиваются обратно в
 *      текст и разбираются так же — их выполнит тот же шелл;
 *   2. подстановки (`$(…)`, `` `…` ``) помечаются: что в них, неизвестно,
 *      значит неизвестно и всё;
 *   3. циклы и условия (`while …; do`, `if …; then`) переписываются в обычный
 *      список команд — глаголы внутри видны теми же словами.
 *
 * Это НЕ безопасность исполнения: разбор нужен только чтобы не пропустить
 * вопрос человеку. Цена промаха — молча снесённые файлы, поэтому всё, что
 * разбор не понял, идёт флагом `unknown` — и `needsConfirmation` спросит.
 */

/** Один запуск: имя программы и аргументы до разделителя команд. */
export interface CommandCall {
  /** Программа без каталога и ведущего `\` — `rm`, `git`, `sudo`. */
  name: string;
  /** Аргументы; кавычки сняты. */
  args: string[];
  /** Имя пришло из переменной или подстановки — программу не знаем. */
  indirect?: boolean;
}

/** Разобранная строка. `unknown` — чего-то не поняли или поняли не полностью. */
export interface ParsedCommand {
  calls: CommandCall[];
  unknown: boolean;
}

/** Предел вложенности разбора: `sh -c "sh -c \"…\""` сам не кончается. */
const MAX_DEPTH = 6;

/** Разделители команд, которые знает шелл. */
const isSeparator = (char: string): boolean => '\n;&|()'.includes(char);

/** Из них те, что внутри двойных кавычек литеральны (`"a; b"` — одно слово). */
const isQuoteSeparator = (char: string): boolean => '\n;&|'.includes(char);

interface Segment {
  /** Текст с кавычками — из него потом достаются слова с их границами. */
  raw: string;
  /** Содержимое сегмента без наружных кавычек — готовые слова вызова. */
  text: string;
  /** В сегменте есть подстановка — то есть чужой запуск, которого мы не видим. */
  foreign: boolean;
}

/** Режем строку на вызовы, снимая кавычки; учитываем побеги и переносы. */
function splitSegments(text: string): Segment[] {
  const segments: Segment[] = [];
  let current = '';
  let raw = '';
  let foreign = false;
  let quote: '"' | "'" | null = null;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]!;
    raw += char;
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    if (char === '\\') {
      const next = text[i + 1];
      // Внутри двойных кавычек слэш экранирует только `$`, `` ` ``, `"` и `\`:
      // `"C:\x"` — буквальный слэш, а не побег.
      if (quote === '"' && next !== undefined && !'$`"\\'.includes(next)) {
        current += char;
        continue;
      }
      if (next === '\n') {
        // Экранированный перевод строки — не разделитель: команда тянется дальше.
        i += 1;
        continue;
      }
      if (next !== undefined) {
        current += next;
        i += 1;
      }
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else {
        if (isQuoteSeparator(char) || char === '`') foreign = true;
        if (char === '$' && text[i + 1] === '(') foreign = true;
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === '`') {
      foreign = true;
      current += char;
      continue;
    }
    if (char === '$' && (text[i + 1] === '(' || text[i + 1] === '{')) foreign = true;
    if (isSeparator(char)) {
      // Разделитель в сырой текст не идёт: он режет вызовы, а не слова.
      segments.push({ raw: raw.slice(0, -1), text: current, foreign });
      current = '';
      raw = '';
      foreign = false;
      continue;
    }
    current += char;
  }
  segments.push({ raw, text: current, foreign });
  return segments;
}

/** Слова одного вызова: как `commandWords`, но с признаком «из переменной». */
function wordsOf(segment: string): { words: string[]; indirect: boolean } {
  const words: string[] = [];
  let current = '';
  let opened = false;
  let indirect = false;
  let quote: '"' | "'" | null = null;

  const take = (): void => {
    if (current || opened) words.push(current);
    current = '';
    opened = false;
  };

  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i]!;
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
      continue;
    }
    if (char === '\\') {
      const next = segment[i + 1];
      if (next !== undefined) {
        current += next;
        opened = true;
        i += 1;
      }
      continue;
    }
    if (quote === '"') {
      if (char === '"') quote = null;
      else {
        if (char === '$' || char === '`') indirect = true;
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      opened = true;
      continue;
    }
    if (/\s/.test(char)) {
      take();
      continue;
    }
    if (char === '$' || char === '`') indirect = true;
    current += char;
    opened = true;
  }
  take();
  return { words, indirect };
}

/** Имя программы без каталога, обёрток и ведущего `\`; `$VAR` — пусто. */
export function programName(word: string): string {
  if (/^\$\{?\w*\}?$/.test(word)) return '';
  const slashed = word.replace(/\\/g, '/');
  const bare = slashed.slice(slashed.lastIndexOf('/') + 1);
  return bare.replace(/^[\\!]+/, '');
}

/** Обёртки: глагол стоит у них в аргументах, а не первым словом. */
const WRAPPERS = new Set([
  'sudo',
  'doas',
  'env',
  'nice',
  'ionice',
  'time',
  'exec',
  'command',
  'xargs',
  'nohup',
  'timeout',
  'stdbuf',
  'watch',
]);

/** Загрузчик: вся остальная строка — его аргументы. */
const LOADERS = new Set(['eval']);

/** Шелл: строка после `-c` — такая же команда. */
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'fish']);

/** Предел разворачивания обёрток: `sudo nice env xargs timeout 5 rm` тоже бывает. */
const MAX_UNWRAP = 8;

/**
 * Интерпретаторы (`python3 -c`, `node -e`) — тоже код: флаг сам по себе не
 * говорит, код это или файл, поэтому у них проверяем одинаково.
 */
const CODE_FLAG = /^-[a-zA-Z]*[ceCE][a-zA-Z]*$/;

/**
 * Переписать логику видимых целиком конструкций в простой список команд.
 * `while read l; do rm "$l"; done` иначе остался бы вызовами без глагола:
 * `while` первым словом, а `rm` — третьим.
 */
export function unwrapShellLogic(text: string): string {
  const logic = /\b(for|select|case|while|until|if)\b[\s\S]*?\b(do|then|in|esac)\b/;
  if (!logic.test(text)) return text;
  let out = text;
  for (let guard = 0; guard < 4; guard += 1) {
    const before = out;
    out = out
      .replace(/\b(for|select|case)\b[^\n]*?\b(in|do|esac)\b/g, ' ')
      .replace(/\b(do|then|else|elif|fi|done|esac|in)\b/g, ' ; ')
      .replace(/\b(while|until|if)\s+/g, ' ; ');
    if (out === before) break;
  }
  return out;
}

/**
 * Текст, который шелл выполнит отдельной командой.
 *
 * `sh -c '…'` и `eval '…'` — буквально та же строка, её и разбираем. Но
 * `cp /etc/passwd /tmp/x` — обычная команда, и её аргумент никто не исполняет:
 * разворачиваем аргументы только там, где это правда код.
 *
 * Берём СЫРЫЕ слова (`rawWords`), а не разобранные: в `sh -c 'rm -rf x'` кавычки
 * уже сняты, и без них внутренняя строка стала бы тремя словами — шелл внутри
 * получил бы другой argv.
 */
function nestedTexts(name: string, raw: string[], codeFlag: boolean): string[] {
  // `eval` — загрузчик целиком: его слова и есть код. Но разбирать его
  // собственное имя бессмысленно: `eval "…"` → `eval …` → снова,
  // каждый раз та же строка и новое поколение вызовов.
  if (LOADERS.has(name)) return raw;
  const at = raw.findIndex((arg) => CODE_FLAG.test(arg));
  // У обёртки глагол — в её аргументах: `xargs -I{} sh -c '…'`.
  const from = at >= 0 ? raw.slice(at + 1) : [];
  if (SHELLS.has(name) || codeFlag) return from;
  // `bash script.sh` — это запуск файла, разбирать нечего; но `bash <(…)`
  // уже подстановка, и она отмечена сегментом.
  return [];
}

/**
 * Слова как есть, с кавычками: из них берётся текст для вложенного разбора.
 * Кавычки нужны на месте: `sh -c 'rm -rf x'` без них становится четырьмя
 * словами, и вложенный разбор получает уже разрезанную строку.
 */
function rawWords(segment: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i]!;
    if (quote !== null) {
      current += char;
      if (char === quote) quote = null;
      continue;
    }
    if (char === '\\') {
      current += char;
      if (segment[i + 1] !== undefined) current += segment[++i]!;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) words.push(current);
      current = '';
      continue;
    }
    current += char;
  }
  if (current) words.push(current);
  return words;
}

/** Снять обёртки: вернуть программу, которая в итоге запустится. */
function unwrap(words: string[]): { name: string; args: string[]; indirect: boolean; rest: number } {
  let args = words;
  let indirect = false;
  for (let round = 0; round < MAX_UNWRAP && args.length > 0; round += 1) {
    const first = args[0]!;
    // `FOO=bar rm -rf x`: присваивание — не программа.
    if (/^[A-Za-z_]\w*=/.test(first)) {
      args = args.slice(1);
      continue;
    }
    const name = programName(first);
    if (!name) {
      indirect = true;
      break;
    }
    // `rest` — сколько слов ушло в обёртки и флаги: столько же берём из сырых.
    if (!WRAPPERS.has(name)) return { name, args: args.slice(1), indirect, rest: words.length - args.length + 1 };
    // Обёртка ест и свои флаги: `sudo -u root rm`, `nice -n 5 rm`.
    let at = 1;
    while (at < args.length && args[at]!.startsWith('-')) {
      // У короткого флага может быть значение (`-u root`, `-n 5`): без него
      // глагол достанется нам как программа.
      at += /^-[a-zA-Z]$/.test(args[at]!) ? 2 : 1;
    }
    args = args.slice(at);
    if (args.length === 0) return { name, args: [], indirect, rest: 0 };
  }
  return { name: '', args: [], indirect: true, rest: words.length };
}

/**
 * Полный разбор: что запустится. Не понятое — `unknown: true`.
 *
 * `depth` — для текстов внутри текстов: `sh -c 'sh -c "…"'`.
 */
export function parseCommand(command: string, depth = 0): ParsedCommand {
  const calls: CommandCall[] = [];
  let unknown = false;

  for (const segment of splitSegments(unwrapShellLogic(command))) {
    const { words, indirect } = wordsOf(segment.text);
    if (words.length === 0) continue;

    const { name, args, indirect: bare, rest } = unwrap(words);
    if (!name) {
      unknown = true;
      continue;
    }
    calls.push({ name, args, ...(bare ? { indirect: true } : {}) });
    if (bare || indirect || segment.foreign) unknown = true;

    /*
     * Текст кода берём из СЫРОГО сегмента, а не из слов: `sh -c 'rm -rf x'`
     * без кавычек становится тремя словами `rm -rf x`, и шелл внутри получил
     * бы их уже разделёнными — границы аргументов теряются.
     */
    const raw = rawWords(segment.raw);
    // Снять обёртки с сырых слов нужно и здесь: `bash -c '…'` — это `bash` плюс
    // флаг, а перед ними в сыром тексте стоит сам `bash`. Без сдвига на `rest`
    // поиск флага начинает с имени обёртки — и вложенный текст теряется.
    const codeFlag = CODE_FLAG.test(raw[rest] ?? '');
    // Обёртки сняты, флаг найден по сырым словам — остаток и есть код.
    const nested = nestedTexts(name, raw.slice(rest), codeFlag);
    for (const text of nested) {
      if (!text.trim()) continue;
      if (depth >= MAX_DEPTH) {
        unknown = true;
        continue;
      }
      // Вложенный текст мог прийти из кавычек с подстановкой — там неизвестно.
      const inner = parseCommand(text, depth + 1);
      calls.push(...inner.calls);
      if (inner.unknown) unknown = true;
    }
  }
  return { calls, unknown };
}

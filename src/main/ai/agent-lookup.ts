import path from 'node:path';

/**
 * Что считать «чтением»: разбор команды в понятие инструмента.
 *
 * `asLookupCall` отвечает на вопрос «это `cat`/`rg`/`ls`, которые наш инструмент
 * сделает дешевле и точнее?» — до запуска чего-либо в терминале. Типы `LookupCall`
 * и `BrokenCommand` — его словарь; понимают их и терминал (`agent-terminal.ts`),
 * и `lookupOutcome` в `tool-command.ts`.
 *
 * Вынесено из `agent-tools.ts` целиком: разбор живёт на регулярках и позициях
 * кавычек, и правка в нём — это правка одного места, а не поиск по 5 000 строк.
 */
/**
 * Кто читает — один файл или пачку. Разбор формы аргументов, без самих чтений.
 *
 * Вызывающий берёт этот ответ и зовёт `readFile` / `readFiles` / отказывает:
 * так `read` с `glob` и `read` с `path` делят схему (234 токена на каждом шаге),
 * а сам бюджет вывода и оглавление LSP остаются в `agent-tools.ts`.
 */
export function readDispatch(args: Record<string, unknown>): 'files' | 'one' | 'none' {
  if (Array.isArray(args.paths)) return 'files';
  return isAbsent(args.path) ? 'none' : 'one';
}

/** `path` нет или он пуст: читать нечего, и это отказ, а не чтение пустоты. */
function isAbsent(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

/**
 * Команда, которая только читает: `cat`, `head -n N`, `sed -n 'A,Bp'`, `grep`.
 *
 * В переписи (TASKS.md, п.43) 43% вызовов `terminal` — именно чтение через шелл.
 * Такой вызов дороже структурного со всех сторон: нет номеров строк, нет потолка
 * вывода, перед каждой второй командой стоит `cd <папка> &&`, и перед запуском
 * нужно подтверждение. Разбор нарочно узкий — одна простая команда без труб,
 * перенаправлений, глобов и подстановок; всё остальное идёт в шелл как раньше.
 */
export type LookupCall = {
  tool: 'read' | 'search' | 'list';
  args: Record<string, unknown>;
  label: string;
  /**
   * `grep -c`: вместо совпадений нужен только их счёт — его и печатаем.
   * Разбор при этом остаётся одним и тем же `search`.
   */
  countOnly?: boolean;
};

/**
 * Команда, которую разбор узнал — и не смог разобрать.
 *
 * Это НЕ то же, что «не читалка» (`null`). Сломанную команду нельзя отдавать
 * шеллу: шелл на `grep -n "row3 file` отработает с кодом 0 и пустым выводом, и
 * агент прочтёт «(пустой вывод)» как «такого файла нет» или «файл пуст». Отказ —
 * короткий и с подсказкой, что именно чинить.
 */
export type BrokenCommand = { broken: string };

/**
 * Довесок к разобранной команде: `| head -N` задаёт предел совпадений.
 * `head`/`cat` хвостом не отсекаются — они уже читают диапазоном.
 */
export function finishLookup(call: LookupCall | null, limit: number | null): LookupCall | null {
  if (!call || limit === null) return call;
  if (call.tool !== 'search') return null;
  return { ...call, args: { ...call.args, limit }, label: `${call.label} | head -${limit}` };
}

/**
 * Где труба снаружи кавычек: `'none'` — её нет, `'many'` — больше одной
 * (`a | b | c` уже скрипт), число — позиция единственной.
 *
 * Считает именно позицию, а не режет: по ней `splitPipe` делает две команды,
 * по ней же `shellPipeline` видит, что дело не в цитате. Без этого деления
 * `shellPipeline` заново склеивал позиции и не отличал `a | b` от `a\|b`.
 */
export function pipePosition(command: string): number | 'none' | 'many' {
  let quote: string | null = null;
  let cut = -1;
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (quote) {
      if (char === '\\') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char !== '|') continue;
    else if (cut >= 0) return 'many';
    else cut = index;
  }
  return cut < 0 ? 'none' : cut;
}

/**
 * `левая | правая` — ровно одна труба снаружи кавычек.
 *
 * `'script'` — это НЕ то же, что `null`: `null` значит «трубы снаружи нет, читай
 * одну команду», а скрипт выше разбором не является и в шелл идти не должен.
 * Два разных ответа на один `null` дорого стоили: `grep -nE "a\|b" file` считался
 * скриптом — то есть понятой командой, — и уходил в шелл мимо `search`, у которого
 * экранирование понимается правильно. Ответ на такой вызов приходил пустым.
 */
export function splitPipe(command: string): { left: string; right: string } | null | 'script' {
  const cut = pipePosition(command);
  if (cut === 'none') return null;
  if (cut === 'many') return 'script';
  if (cut <= 0) return null;
  const left = command.slice(0, cut).trim();
  const right = command.slice(cut + 1).trim();
  return left && right ? { left, right } : null;
}

/**
 * `grep` по тексту из трубы — это поиск по файлам, только запрос берётся из
 * самого `grep`, а область — из левой части. Годится только источник-обход:
 * `list <папка>` или `search` по папке. По одиночному файлу (`grep x f | grep y`,
 * `cat f | grep x`) не разбираем: буквальный аналог — поиск по всему проекту, а
 * это уже другой ответ, чем дал бы шелл.
 */
export function mergePipedSearch(source: LookupCall, filter: LookupCall): LookupCall | null {
  // Свой `path` у фильтра главнее непонятно чего: не угадываем.
  if (filter.args.path !== undefined) return null;
  if (source.tool !== 'list' && source.tool !== 'search') return null;
  const folder = typeof source.args.path === 'string' ? source.args.path : null;
  const glob = source.args.glob ?? filter.args.glob;
  return {
    ...filter,
    args: {
      ...filter.args,
      ...(folder ? { path: folder } : {}),
      ...(glob !== undefined ? { glob } : {}),
    },
    label: `${source.label} | ${filter.label}`,
  };
}

/**
 * `команда | head [-n] N` — хвост, который просит урезать вывод. Сюда же не
 * попадает `grep … | grep …`: эту трубу разбирает `splitPipe` (тот же `search`).
 */
export function takeHeadTail(command: string): { command: string; limit: number | null } {
  // Труба ищется тем же счётом с кавычками, что у `splitPipe`: regex здесь ловил
  // трубу и ВНУТРИ образца (`grep "row3\|row4" f`) и обрезал команду по ней.
  const cut = pipePosition(command);
  if (cut === 'none' || cut === 'many') return { command, limit: null };
  const head = /^head(?:\s+-n\s+|\s+-)(\d+)\s*$/.exec(command.slice(cut + 1).trim());
  if (!head) return { command, limit: null };
  const limit = Number(head[1]);
  if (!Number.isFinite(limit) || limit < 1) return { command, limit: null };
  return { command: command.slice(0, cut).trim(), limit };
}

export function asPlainLookupCall(command: string, cwdDir: string): LookupCall | null {
  const words = commandWords(command);
  if (!words || words.length < 1) return null;
  const [program, ...rest] = words as [string, ...string[]];
  // Абсолютным: рабочая папка инструментов не обязана совпадать с текущей
  // папкой процесса, а относительный путь `safePath` разворачивает именно от неё.
  const scope = (value: string): string => (path.isAbsolute(value) ? value : path.resolve(cwdDir, value));

  if (program === 'cat') {
    // `-n` разрешён и не нужен: номера строк `read` ставит сам.
    const files = rest.filter((word) => word !== '-n');
    if (files.length === 0) return null;
    if (files.some((file) => file.startsWith('-')) || files.length > MAX_READ_FILES) return null;
    return files.length === 1
      ? { tool: 'read', args: { path: scope(files[0]!) }, label: 'cat' }
      : { tool: 'read', args: { paths: files.map(scope) }, label: 'cat' };
  }

  if (program === 'head') {
    let count = 10;
    const files: string[] = [];
    for (let index = 0; index < rest.length; index += 1) {
      const word = rest[index]!;
      if (word === '-n') {
        const value = rest[index + 1];
        if (!value || !/^\d+$/.test(value)) return null;
        count = Number(value);
        index += 1;
        continue;
      }
      if (/^-\d+$/.test(word)) {
        count = Number(word.slice(1));
        continue;
      }
      if (word.startsWith('-')) return null;
      files.push(word);
    }
    // Один файл: `head` от двух — это склейка, а `read` вернул бы два разных отчёта.
    if (files.length !== 1 || count < 1) return null;
    return {
      tool: 'read',
      args: { path: scope(files[0]!), endLine: count },
      label: `head -n ${count}`,
    };
  }

  if (program === 'sed') {
    const flags = rest.filter((word) => word.startsWith('-'));
    const plain = rest.filter((word) => !word.startsWith('-'));
    // Только `-n`: с `-e`, `-i` и выражениями подстановки `sed` делает больше, чем читает.
    if (flags.length !== 1 || flags[0] !== '-n' || plain.length !== 2) return null;
    const [script, file] = plain as [string, string];
    const range = /^(\d+)(?:,(\d+))?p$/.exec(script);
    if (!range) return null;
    const startLine = Number(range[1]);
    const endLine = range[2] ? Number(range[2]) : startLine;
    if (startLine < 1 || endLine < startLine) return null;
    return {
      tool: 'read',
      args: { path: scope(file), startLine, endLine },
      label: `sed -n '${script}'`,
    };
  }

  if (program === 'grep' || program === 'rg') {
    const flags = new Set<string>();
    const plain: string[] = [];
    let glob: string | null = null;
    for (const word of rest) {
      if (word === '--') continue;
      // `--include=*.ts` — единственный длинный флаг, у которого есть точное
      // соответствие: у `search` это `glob`. Остальные (`--exclude`, `-P`) меняют
      // смысл поиска, и такой вызов идёт в шелл.
      if (word.startsWith('--include=')) {
        if (glob !== null) return null;
        glob = word.slice('--include='.length);
        if (!glob) return null;
        continue;
      }
      if (word.startsWith('--')) return null;
      if (word.startsWith('-') && word.length > 1) {
        for (const flag of word.slice(1)) {
          // `-o`, `-v` и прочие меняют смысл поиска, а не только его вид.
          // `-c` — исключение: это тот же поиск, но модели нужен счёт, а не строки.
          if (!'niIrRFElc'.includes(flag)) return null;
          flags.add(flag);
        }
        continue;
      }
      plain.push(word);
    }
    // Слово-образец и не более одной папки: `grep foo a.ts b.ts` — это две области.
    if (plain.length === 0 || plain.length > 2) return null;
    const [query, only] = plain as [string, string | undefined];
    // Признаки regex в самом образце: имя вроде `A|B` — это тоже regex.
    const looksRegex = /[\\^$.*+?()[\]{}|]/.test(query);
    const isRegex = !flags.has('F') && (program === 'rg' || flags.has('E') || looksRegex);
    return {
      tool: 'search',
      args: {
        query: isRegex && !flags.has('E') && !flags.has('F') && program !== 'rg' ? ungrepPattern(query) : query,
        isRegex,
        caseSensitive: !flags.has('i'),
        filesOnly: flags.has('l'),
        ...(only ? { path: scope(only) } : {}),
        ...(glob ? { glob } : {}),
      },
      label: program,
      ...(flags.has('c') ? { countOnly: true } : {}),
    };
  }

  if (program === 'awk' || program === 'gawk') {
    // Только выборка строк по номеру: `awk 'NR>=10 && NR<=20' f`. Печать полей,
    // суммы и `$1` — не наше: такого ответа у `read` нет, пусть шелл.
    const flags = rest.filter((word) => word.startsWith('-'));
    const plain = rest.filter((word) => !word.startsWith('-'));
    if (flags.length > 0 || plain.length !== 2) return null;
    const [script, file] = plain as [string, string];
    const range = /^NR(?:>=(\d+)&&NR<=(\d+)|<=(\d+)|==(\d+)|>=(\d+))$/.exec(script.replace(/\s+/g, ''));
    if (!range) return null;
    // Четыре формы, и у каждой свой смысл: диапазон, «с начала до B», «только N»,
    // «от A до конца файла».
    const from = range[1] ?? (range[3] ? '1' : (range[4] ?? range[5]));
    const to = range[2] ?? range[3] ?? range[4];
    if (from === undefined || Number(from) < 1) return null;
    if (to !== undefined && Number(to) < Number(from)) return null;
    return {
      tool: 'read',
      args: {
        path: scope(file),
        startLine: Number(from),
        ...(to === undefined ? {} : { endLine: Number(to) }),
      },
      label: `awk '${script.trim()}'`,
    };
  }

  if (program === 'nl') {
    // `nl` — тот же `cat`, только с номерами строк, а их `read` ставит сам.
    const flags = rest.filter((word) => word.startsWith('-'));
    const plain = rest.filter((word) => !word.startsWith('-'));
    if (flags.some((flag) => !/^-b[atn]$/.test(flag)) || plain.length !== 1) return null;
    return { tool: 'read', args: { path: scope(plain[0]!) }, label: 'nl' };
  }

  if (program === 'ls') {
    const plain: string[] = [];
    for (const word of rest) {
      if (word.startsWith('--')) return null;
      if (word.startsWith('-') && word.length > 1) {
        // `-R` — обход вглубь, а `list` показывает один уровень.
        if ([...word.slice(1)].some((flag) => !'alh1AF'.includes(flag))) return null;
        continue;
      }
      plain.push(word);
    }
    if (plain.length > 1) return null;
    const target = plain[0];
    return {
      tool: 'list',
      args: target ? { path: scope(target) } : {},
      label: 'ls',
    };
  }

  return null;
}

/**
 * Труба, перенаправление, подстановка: это не одна команда, а скрипт. Тоже вне
 * кавычек — иначе `grep 'a|b'` попал бы сюда.
 */
export function shellPipeline(command: string): boolean {
  let quote: string | null = null;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if ('|&;<>`$\n'.includes(char)) return true;
  }
  return false;
}

/**
 * Незакрытая кавычка: `grep -n "row3 src/app.ts`.
 *
 * Отдельно от `shellSyntax`, потому что ответ у них разный. `shellSyntax` — «это
 * скрипт, иди в шелл»: там `true` значит «наша читалка тут не при делах». А
 * незакрытая кавычка — это сломанная команда: шелл её тоже не поймёт и вернёт
 * пустой вывод с кодом 0, а агент прочтёт `(пустой вывод)` как «файл пустой».
 * Поэтому такую команду надо назвать ошибкой, а не отдать шеллу.
 */
export function unclosedQuote(command: string): boolean {
  let quote: string | null = null;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
  }
  return quote !== null;
}

/**
 * Скриптовая скобка вне кавычек. Разбираем посимвольно, а не одной регуляркой по
 * всей строке: `grep -n 'interface ChatConversation' -A 25 src/api.ts` — это
 * `search`, хотя в кавычках лежит `)`, а `grep 'a\|b'` — тоже `search`, хотя в
 * образце `|` и `\`. Содержимое кавычек шеллу не передаётся, так что читалка
 * остаётся читалкой.
 */
export function shellSyntax(command: string): boolean {
  let quote: string | null = null;
  for (const [position, char] of [...command].entries()) {
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    // Глоб `--include=*.ts` шелл не раскрывает: до `=` стоит имя флага, а не
    // файл. Это маска фильтра, её и несёт `glob`.
    if ('*?[]'.includes(char) && inFlagValue(command, position)) continue;
    if ('()*?[]{}\\'.includes(char)) return true;
  }
  // Незакрытая кавычка здесь больше не проверяется: это не «скрипт», а сломанная
  // команда. Своя проверка — `unclosedQuote`, чтобы ответ был ошибкой, а не шеллом.
  return false;
}

/** Слова команды с учётом кавычек; null — незакрытая кавычка. */
export function commandWords(command: string): string[] | null {
  const words: string[] = [];
  let current = '';
  let quote: string | null = null;
  let opened = false;
  for (const char of command) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      opened = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (current || opened) words.push(current);
      current = '';
      opened = false;
      continue;
    }
    current += char;
  }
  if (quote) return null;
  if (current || opened) words.push(current);
  return words;
}

/**
 * Ведущий `cd <папка> &&` (или `;`) — смена области, а не чтение.
 *
 * Замер: `cd` — второй по частоте повод уйти в шелл после `cat`. Сам по себе он
 * ничего не печатает: интересно то, что за ним. Снимаем префикс и отдаём остаток
 * разбору с новой папкой. Всё, что не похоже на папку (`cd -`, `cd $DIR`, `cd ~/x`),
 * возвращает `null`: подстановку должен сделать шелл, а не мы.
 */
export function takeCdPrefix(command: string, cwdDir: string): { command: string; cwd: string } | null {
  let rest = command.trim();
  let cwd = cwdDir;
  let moved = false;
  for (;;) {
    const head = /^cd[ \t]+(?:"([^"]*)"|'([^']*)'|([^\s;&|]+))[ \t]*(?:&&|;)[ \t]*(\S[\s\S]*)$/.exec(rest);
    if (!head) break;
    const target = head[1] ?? head[2] ?? head[3] ?? '';
    if (!target || target.startsWith('-') || /[$`~]/.test(target)) return null;
    cwd = path.isAbsolute(target) ? target : path.resolve(cwd, target);
    rest = head[4]!.trim();
    moved = true;
  }
  return moved ? { command: rest, cwd } : null;
}

/** `cat f | head -20` — это `read` с потолком, а не шелл: потолок есть у `read`. */
function headOfRead(call: LookupCall | BrokenCommand | null, limit: number | null): LookupCall | BrokenCommand | null {
  if (!call || limit === null || 'broken' in call || call.tool !== 'read') return call;
  const args = call.args as { path?: unknown; endLine?: unknown };
  if (typeof args.path !== 'string' || args.endLine !== undefined) return call;
  return { ...call, args: { ...args, endLine: limit }, label: `${call.label} | head -${limit}` };
}

export function asLookupCall(command: string, cwdDir: string): LookupCall | BrokenCommand | null {
  // Сломанная команда — это ответ, а не повод уйти в шелл: шелл на ней
  // отработает с кодом 0 и пустым выводом, и агент прочтёт «(пустой вывод)»
  // как «файла нет» или «пустой файл». Проверяем ДО разбора: образец в кавычках
  // — норма, а вот кавычка без пары — ошибка, где бы она ни стояла.
  if (unclosedQuote(command)) return { broken: `кавычка без пары: ${JSON.stringify(command)}` };
  // `cd папка && чтение` — самый частый повод уйти в шелл (655 вызовов `cd` в
  // замере). Область меняется, а чтение остаётся чтением: снимаем префикс и
  // разбираем остаток уже с новой папкой. Остаток не читалка — ответ `null`, и
  // в шелл уйдёт ИСХОДНАЯ команда целиком: поведение не меняется ни на бит.
  const moved = takeCdPrefix(command, cwdDir);
  if (moved) return asLookupCall(moved.command, moved.cwd);
  const tail = takeHeadTail(command);
  if (tail.command !== command) {
    const call = asPlainLookupCall(tail.command, cwdDir);
    // `head` хвостом — не всегда отсечка поиска: `cat f | head -20` — тот же
    // `read`, только с концом диапазона. Тогда потолок уходит в аргументы, а не
    // в `limit` (его понимает только `search`) — и вызов остаётся читалкой.
    const cut = headOfRead(call, tail.limit);
    return cut !== call ? cut : finishLookup(call, tail.limit);
  }
  // `команда | grep …`: читалка, чей вывод отфильтрован одной строкой. Это не
  // скрипт, а тот же `search`, только запрос — из самого `grep`, а папка — из
  // читалки. Остальные трубы (`| wc -l`, `| sort`) по-прежнему идут в шелл:
  // счёт и сортировка — работа шелла, у нас для них нет ответа.
  const piped = splitPipe(command);
  if (piped === 'script') return null;
  if (!piped) {
    if (shellPipeline(command) || shellSyntax(command)) return null;
    return asPlainLookupCall(command, cwdDir);
  }
  if (shellSyntax(piped.left) || shellSyntax(piped.right)) return null;
  const left = asPlainLookupCall(piped.left, cwdDir);
  const filter = asPlainLookupCall(piped.right, cwdDir);
  if (!left || !filter || filter.tool !== 'search') return null;
  const merged = mergePipedSearch(left, filter);
  return merged ? finishLookup(merged, null) : null;
}

export const MAX_READ_FILES = 10;

/**
 * Образец grep → образец `search`: BRE/ERE считают `\|` «или», а JS в regex `\|` —
 * буквальная труба. Без этой развёртки `grep -nE "a\|b" f` уходил в `search`
 * как ?a\|b? и давал «Совпадений нет» — ложное «ничего нет» там, где есть.
 *
 * Порядок важен: `\|` разворачивается ПЕРВЫМ и только он. Общий проход штампов
 * развернул бы и `\\|` — экранированную трубу в BRE, то есть «буквальную трубу»
 * у grep, — превратив её в «или». Остальные знаки (`[`, `]`, `{`, `}`, `.`, `\\`)
 * в обоих языках значит одно и то же, и трогать его нельзя.
 */
export function ungrepPattern(pattern: string): string {
  return pattern.replace(/\\\|/g, '|').replace(/\\([\\^$.*+?()[\]{}/])/g, '$1');
}

/**
 * Стоит ли символ в значении флага вида `--include=*.ts`: тогда его глоб —
 * маска, а не файл, и шелл по ней ничего не раскрывает.
 */
export function inFlagValue(command: string, position: number): boolean {
  const start = command.lastIndexOf(' ', position);
  const word = command.slice(start + 1, position);
  return word.startsWith('--') && word.includes('=');
}

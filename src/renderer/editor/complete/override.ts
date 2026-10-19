/**
 * Переопределение метода предка: заготовка вместо ручного набора.
 *
 * Наследование — это про то, что уже написано у родителя. Человек, переопределяя
 * метод, чаще всего хочет не «написать всё с нуля», а взять сигнатуру предка и
 * дописать своё тело; руками это значит сходить в файл родителя, найти метод и
 * скопировать строку. Имена и места предков знает карта символов — значит заготовку
 * можно собрать по ней, не открывая чужой файл.
 *
 * Здесь только правила: какой класс вокруг курсора, какие параметры у предка и как
 * выглядит заглушка на языке. Ни диска, ни окна — поэтому проверяется тестами.
 */

/** Где стоит курсор: класс, его отступ и последняя строка тела. */
export interface EnclosingClass {
  name: string;
  /** Отступ строки с `class`, в знаках. */
  indent: number;
  /** Последняя строка тела класса (1-based; строка заголовка, если тело пустое). */
  endLine: number;
  /** Язык, чьё правило разбора применилось: `python` или `javascript`. */
  language: 'python' | 'javascript';
}

/** Строка заголовка класса: Python `class X(Base):`, TS/JS `class X extends Y {`. */
const CLASS_HEADER = /^(\s*)(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([\p{L}\p{Nl}\p{Nd}\p{Pc}_$][\w$]*)/u;

/** Строка объявления метода: Python `def f(`, TS/JS `f(`, `async f(`, `get f(`. */
const METHOD_HEADER =
  /^(\s*)(?:async\s+)?(?:static\s+|get\s+|set\s+)*(?:def\s+)?([\p{L}\p{Nl}\p{Nd}\p{Pc}_$][\w$]*)\s*\(/u;

/** Отступ строки в знаках (таб — два, как в остальном разборе по отступу). */
function indentOf(line: string): number {
  let count = 0;
  for (const char of line) {
    if (char === ' ') count += 1;
    else if (char === '\t') count += 2;
    else break;
  }
  return count;
}

/**
 * Класс, внутри которого стоит курсор.
 *
 * Ищем ближайший заголовок класса выше, у которого тело ещё не кончилось: тело
 * кончается там, где отступ вернулся к уровню заголовка (или выше) на непустой
 * строке, — так же, как это устроено в Python и в TS.
 *
 * `null` — курсор не в классе (верхний уровень файла, чужой класс не наш).
 */
export function enclosingClassAt(text: string, offset: number): EnclosingClass | null {
  const lines = text.split('\n');
  // Строка курсора: считаем переводы строк до смещения.
  let line = 0;
  let remaining = Math.min(Math.max(offset, 0), text.length);
  while (line < lines.length && remaining > (lines[line]?.length ?? 0)) {
    remaining -= (lines[line]?.length ?? 0) + 1;
    line += 1;
  }

  for (let at = Math.min(line, lines.length - 1); at >= 0; at -= 1) {
    const header = CLASS_HEADER.exec(lines[at] ?? '');
    if (!header) continue;
    const base = indentOf(lines[at] ?? '');
    // Заголовок класса глубже строки курсора — это класс, объявленный ниже.
    if (base > indentOf(lines[line] ?? '')) continue;

    let end = at;
    for (let inner = at + 1; inner < lines.length; inner += 1) {
      const current = lines[inner] ?? '';
      if (!current.trim()) continue;
      if (indentOf(current) <= base) break;
      end = inner;
    }
    // Курсор ниже последней строки тела — значит это уже не этот класс.
    if (line > end + 1) continue;

    return {
      name: header[2] ?? '',
      indent: base,
      endLine: end + 1,
      language: /:\s*(?:#.*)?$/.test((lines[at] ?? '').trimEnd()) ? 'python' : 'javascript',
    };
  }

  return null;
}

/**
 * Параметры метода из строки его объявления.
 *
 * Возвращает список через запятую ровно как в предке: `self, value` у Python,
 * `value: string` у TypeScript. Пусто — параметров нет (или строка не разобралась):
 * тогда заготовка будет без них, и это честнее выдуманного `*args`.
 */
export function paramsOf(declaration: string): string {
  const header = METHOD_HEADER.exec(declaration);
  if (!header) return '';
  const open = declaration.indexOf('(', header.index + (header[0]?.length ?? 0) - 1);
  if (open < 0) return '';

  // Ищем закрывающую скобку с учётом вложенности: `f(a: dict[str, int])`.
  let depth = 0;
  for (let at = open; at < declaration.length; at += 1) {
    const char = declaration[at];
    if (char === '(') depth += 1;
    else if (char === ')') {
      depth -= 1;
      if (depth === 0) {
        const inner = declaration.slice(open + 1, at).trim();
        if (!inner) return '';
        // Python: `self` в заглушке нужен — без него метод не метод.
        return inner.replace(/\s+/g, ' ');
      }
    }
  }
  return '';
}

/**
 * Текст заготовки переопределённого метода.
 *
 * Вид зависит от языка и от того, знаем ли параметры:
 *   • Python: `def name(self, value):` и `super().name(value)` в теле;
 *   • TypeScript/JavaScript: `name(value) {` и `super.name(value);`.
 *
 * Тело — вызов предка, а не пустота: это самое частое, что пишут при переопределении,
 * и забыть его значит получить метод, который молча ничего не делает. `# TODO` в
 * заглушке нет: человек и так знает, что она пустая, а мусор в коде остаётся.
 */
export function overrideSnippet(input: {
  language: 'python' | 'javascript';
  /** Имя метода. */
  name: string;
  /** Параметры как у предка (`self, value`); пусто — без параметров. */
  params: string;
  /** Отступ члена класса, в знаках. */
  indent: number;
}): string {
  const pad = ' '.repeat(input.indent);
  const inner = `${pad}    `;
  const params = input.params.trim();

  if (input.language === 'python') {
    // У Python первым параметром идёт `self` (или `cls`): без него метод не привязан.
    const hasSelf = /^(self|cls)\b/.test(params);
    const signature = params ? (hasSelf ? params : `self, ${params}`) : 'self';
    const call = argumentNames(params, 'python');
    return `\n\n${pad}def ${input.name}(${signature}):\n${inner}super().${input.name}(${call})\n`;
  }

  const call = argumentNames(params, 'javascript');
  return `\n\n${pad}${input.name}(${params}) {\n${inner}super.${input.name}(${call});\n${pad}}\n`;
}

/**
 * Имена аргументов для вызова предка — из его же параметров.
 *
 * Нужны имена, а не объявления: `super().run(value)` вместо `super().run(value: string)`.
 * Значения по умолчанию отбрасываем (они уже не про вызов), а `self`/`this` — тоже:
 * их подставляет сам язык.
 *
 * Две тонкости, без которых вызов падает уже в работе:
 *   • `*` в параметрах делает всё, что после него, ИМЕНОВАННЫМ (`def run(self, *, strict=False)`),
 *     и передать такое позиционно нельзя — TypeError. Такие аргументы идут как `strict=strict`;
 *   • `*args`/`**kwargs` передаются как есть, со звёздочками: иначе список развернётся
 *     в один аргумент.
 */
export function argumentNames(params: string, language: 'python' | 'javascript'): string {
  if (!params.trim()) return '';
  const names: string[] = [];
  /** Встретили одиночную `*` — дальше параметры только именованные (Python). */
  let keywordOnly = false;

  for (const part of params.split(',')) {
    const raw = part.trim();
    if (!raw) continue;
    // Одиночная звёздочка: разделитель, а не параметр.
    if (raw === '*') {
      keywordOnly = true;
      continue;
    }
    // `*args` и `**kwargs` в вызове остаются со звёздочками.
    if (raw.startsWith('*')) {
      const rest = raw.replace(/^\*+/, '');
      const name = /^([\p{L}\p{Nl}\p{Nd}\p{Pc}_$][\w$]*)/u.exec(rest)?.[1];
      if (name) names.push(`${raw.startsWith('**') ? '**' : '*'}${name}`);
      continue;
    }
    // `self` у Python и `this` у TS в вызов не попадают — их язык подставляет сам.
    if (language === 'python' && /^(self|cls)\b/.test(raw)) continue;
    // Имя — всё до двоеточия (TS) и знака равенства (значение по умолчанию).
    const name = /^([\p{L}\p{Nl}\p{Nd}\p{Pc}_$][\w$]*)/u.exec(raw)?.[1];
    if (!name) continue;
    names.push(keywordOnly ? `${name}=${name}` : name);
  }
  return names.join(', ');
}

/** Строка объявления метода по имени — из текста файла предка. */
export function declarationOf(text: string, method: string): string | null {
  const wanted = new RegExp(
    String.raw`^\s*(?:async\s+)?(?:static\s+|get\s+|set\s+)*(?:def\s+)?${method.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\s*\(`,
    'u',
  );
  for (const line of text.split('\n')) if (wanted.test(line)) return line;
  return null;
}

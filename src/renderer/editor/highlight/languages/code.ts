/**
 * C-подобные языки: одна грамматика, разные словари.
 *
 * JS, Java, C, Go и Rust разбираются одинаково: имя, число, строка, комментарий до
 * конца строки и блочный комментарий. Различаются они словами — тем, что считать
 * ключевым, типом и управляющей конструкцией. Поэтому здесь один разборщик и таблицы
 * слов на язык; добавляя язык, дописываем таблицу, а не второй разборщик.
 *
 * Слова для каждого языка — минимальный осмысленный набор, а не полный список
 * стандарта: в подсветке важен вид текста, а редкое слово без цвета портит его меньше,
 * чем неверно окрашенное. Полные списки всё равно пришлось бы держать синхронными с
 * версиями языков.
 *
 * Что красится как что (по принятому в палитре приложения):
 *   • управляющие конструкции (`if`, `for`, `return`) — своим цветом, отличным от
 *     остальных ключевых слов;
 *   • `true`, `false`, `null`, `None` — цветом ключевого слова;
 *   • встроенные типы (`int`, `String`, `i32`) — цветом типа у языков, где они не
 *     ключевые слова (Go, Rust, TypeScript), и цветом ключевого слова там, где
 *     объявлены как ключевые (Java, C#);
 *   • имя со скобкой сразу после (`foo(`) — цветом функции: так вызовы читаются
 *     заметно лучше, и они тоже выделяются цветом.
 */

import {
  ST_BLOCK_COMMENT,
  ST_NORMAL,
  ST_TEMPLATE,
  ST_TRIPLE_DOUBLE,
  ST_TRIPLE_SINGLE,
  type Grammar,
  type LineResult,
} from '../grammar';
import { isDigit, isIdentStart, push, scanIdentifier, scanNumber, scanQuoted, wordSet } from '../scanner';
import { COMMENT, CONSTANT, CONTROL, FUNCTION, IDENTIFIER, KEYWORD, NUMBER, STRING, TYPE, type Token } from '../tokens';

/** Всё, чем один C-подобный язык отличается от другого. */
export interface CodeConfig {
  /** Начало комментария до конца строки: `//`, `#`, `--`. */
  lineComment: string;
  /** Пара блочного комментария: `/*` и `*​/`. */
  blockComment?: readonly [string, string];
  /** Обратные кавычки — многострочные (шаблонные строки JS). */
  template?: boolean;
  /** Тройные кавычки — многострочные (Kotlin, Scala). */
  triple?: boolean;
  /** `@Имя` — аннотация (Java, C#, Python есть отдельно). */
  annotations?: boolean;
  /** Управляющие конструкции — своим цветом. */
  controls: readonly string[];
  /** Ключевые слова: `class`, `const`, `fn` и прочие объявления. */
  keywords: readonly string[];
  /** Встроенные типы — цветом типа. */
  types?: readonly string[];
  /** Именованные константы, кроме `true`/`false` (например, `NaN`). */
  constants?: readonly string[];
}

/**
 * Собрать грамматику C-подобного языка по словарю. Множества строим один раз здесь,
 * а не на каждой строке: строк на экране десятки, и превращение массивов в `Set` на
 * каждую — заметная работа на пустом месте.
 */
export function makeCodeGrammar(id: string, config: CodeConfig): Grammar {
  const controls = wordSet(config.controls);
  const keywords = wordSet(config.keywords);
  const types = wordSet(config.types);
  const constants = wordSet(config.constants);
  const lineComment = config.lineComment;
  const blockOpen = config.blockComment?.[0] ?? '';
  const blockClose = config.blockComment?.[1] ?? '';

  /** Роль слова. Скобка сразу после имени делает его функцией. */
  const classify = (word: string, next: string): string => {
    if (controls.has(word)) return CONTROL;
    if (keywords.has(word)) return KEYWORD;
    if (types.has(word)) return TYPE;
    if (constants.has(word)) return CONSTANT;
    if (next === '(') return FUNCTION;
    return IDENTIFIER;
  };

  /** Продолжение многострочной конструкции, начатой на прошлой строке. */
  const continueBlock = (text: string, state: number, tokens: Token[]): LineResult | null => {
    if (state === ST_BLOCK_COMMENT && blockClose) {
      const close = text.indexOf(blockClose);
      if (close < 0) {
        push(tokens, 0, text.length, COMMENT);
        return { tokens, state };
      }
      push(tokens, 0, close + blockClose.length, COMMENT);
      return null;
    }
    if (state === ST_TEMPLATE) {
      // Мы УЖЕ внутри шаблона, поэтому закрывающая кавычка ищется с нулевой позиции:
      // `scanQuoted` пропускает первый знак как открывающий, и строка, которая
      // начинается самой кавычкой (`\`;`), закрытой бы не считалась — шаблон
      // тянулся бы дальше, съедая весь следующий код.
      let index = 0;
      let closed = false;
      while (index < text.length) {
        const char = text[index];
        if (char === '\\') {
          index += 2;
          continue;
        }
        if (char === '`') {
          closed = true;
          index += 1;
          break;
        }
        index += 1;
      }
      push(tokens, 0, closed ? index : text.length, STRING);
      return closed ? null : { tokens, state: ST_TEMPLATE };
    }
    if (state === ST_TRIPLE_DOUBLE || state === ST_TRIPLE_SINGLE) {
      const quote = state === ST_TRIPLE_DOUBLE ? '"""' : "'''";
      const close = text.indexOf(quote);
      if (close < 0) {
        push(tokens, 0, text.length, STRING);
        return { tokens, state };
      }
      push(tokens, 0, close + 3, STRING);
      return null;
    }
    return null;
  };

  return {
    id,
    line(text: string, state: number): LineResult {
      const tokens: Token[] = [];
      // Вышли из многострочной конструкции — дальше разбираем строку как обычно.
      const open = continueBlock(text, state, tokens);
      if (open) return open;
      // Если многострочная конструкция закрылась на этой строке, разбор продолжается
      // с её конца (и уже в обычном режиме). Иначе начинаем с начала строки.
      let index = 0;
      if (tokens.length > 0) {
        index = tokens[tokens.length - 1]!.end;
        state = ST_NORMAL;
      }

      while (index < text.length) {
        const ch = text[index]!;
        if (ch === ' ' || ch === '\t') {
          index += 1;
          continue;
        }
        if (text.startsWith(lineComment, index)) {
          push(tokens, index, text.length, COMMENT);
          break;
        }
        if (blockClose && text.startsWith(blockOpen, index)) {
          const close = text.indexOf(blockClose, index + blockOpen.length);
          if (close < 0) {
            push(tokens, index, text.length, COMMENT);
            return { tokens, state: ST_BLOCK_COMMENT };
          }
          push(tokens, index, close + blockClose.length, COMMENT);
          index = close + blockClose.length;
          continue;
        }
        if (config.triple && (text.startsWith('"""', index) || text.startsWith("'''", index))) {
          const quote = text.startsWith('"""', index) ? '"""' : "'''";
          const close = text.indexOf(quote, index + 3);
          if (close < 0) {
            push(tokens, index, text.length, STRING);
            return { tokens, state: quote === '"""' ? ST_TRIPLE_DOUBLE : ST_TRIPLE_SINGLE };
          }
          push(tokens, index, close + 3, STRING);
          index = close + 3;
          continue;
        }
        if (ch === '"' || ch === "'" || (config.template && ch === '`')) {
          const { end, closed } = scanQuoted(text, index, ch);
          push(tokens, index, end, STRING);
          if (!closed && config.template && ch === '`') return { tokens, state: ST_TEMPLATE };
          index = end;
          continue;
        }
        if (isDigit(ch) || (ch === '.' && isDigit(text[index + 1]))) {
          const end = scanNumber(text, index);
          push(tokens, index, end, NUMBER);
          index = end;
          continue;
        }
        if (config.annotations && ch === '@' && isIdentStart(text[index + 1])) {
          const end = scanIdentifier(text, index + 1);
          push(tokens, index, end, IDENTIFIER);
          index = end;
          continue;
        }
        if (isIdentStart(ch)) {
          const end = scanIdentifier(text, index);
          push(tokens, index, end, classify(text.slice(index, end), text[end] ?? ''));
          index = end;
          continue;
        }
        // Знаки препинания и операторы — бесцветные: отдельного токена не заводим.
        index += 1;
      }

      return { tokens, state };
    },
  };
}

/* ── Словари ────────────────────────────────────────────────────────────── */

/** Управляющие конструкции, общие почти всем C-подобным языкам. */
const FLOW = [
  'if',
  'else',
  'for',
  'while',
  'do',
  'switch',
  'case',
  'default',
  'break',
  'continue',
  'return',
  'throw',
  'try',
  'catch',
  'finally',
  'yield',
];

const JAVASCRIPT: CodeConfig = {
  lineComment: '//',
  blockComment: ['/*', '*/'],
  template: true,
  controls: [...FLOW, 'await', 'in', 'of'],
  keywords: [
    'abstract',
    'as',
    'async',
    'class',
    'const',
    'constructor',
    'debugger',
    'declare',
    'delete',
    'enum',
    'export',
    'extends',
    'false',
    'from',
    'function',
    'get',
    'implements',
    'import',
    'instanceof',
    'interface',
    'let',
    'module',
    'namespace',
    'new',
    'null',
    'package',
    'private',
    'protected',
    'public',
    'readonly',
    'require',
    'set',
    'static',
    'super',
    'this',
    'true',
    'typeof',
    'undefined',
    'var',
    'void',
    'with',
  ],
  constants: ['NaN', 'Infinity'],
};

const TYPESCRIPT: CodeConfig = {
  ...JAVASCRIPT,
  keywords: [
    ...JAVASCRIPT.keywords,
    'any',
    'asserts',
    'assert',
    'infer',
    'is',
    'keyof',
    'never',
    'object',
    'out',
    'override',
    'satisfies',
    'symbol',
    'type',
    'unique',
    'unknown',
    'using',
  ],
  // Примитивы в TS — типы, а не ключевые слова: так их и красим.
  types: ['bigint', 'boolean', 'number', 'string'],
};

/** Слова, которые есть почти в каждом C-подобном языке: объявления и модификаторы. */
const C_LIKE_COMMON = [
  'abstract',
  'class',
  'const',
  'enum',
  'extends',
  'false',
  'final',
  'implements',
  'import',
  'interface',
  'native',
  'new',
  'null',
  'package',
  'private',
  'protected',
  'public',
  'static',
  'super',
  'this',
  'true',
  'void',
];

const JAVA: CodeConfig = {
  lineComment: '//',
  blockComment: ['/*', '*/'],
  annotations: true,
  controls: [...FLOW, 'instanceof', 'assert', 'synchronized'],
  keywords: [
    ...C_LIKE_COMMON,
    'boolean',
    'byte',
    'char',
    'double',
    'float',
    'goto',
    'int',
    'long',
    'record',
    'sealed',
    'permits',
    'short',
    'strictfp',
    'throws',
    'transient',
    'var',
    'volatile',
  ],
};

const C: CodeConfig = {
  lineComment: '//',
  blockComment: ['/*', '*/'],
  controls: [...FLOW, 'goto', 'sizeof'],
  keywords: [
    'auto',
    'char',
    'const',
    'double',
    'enum',
    'extern',
    'float',
    'inline',
    'int',
    'long',
    'register',
    'restrict',
    'short',
    'signed',
    'static',
    'struct',
    'typedef',
    'union',
    'unsigned',
    'void',
    'volatile',
    'false',
    'true',
    'nullptr',
  ],
  types: ['size_t', 'ssize_t', 'bool', 'FILE'],
};

const CPP: CodeConfig = {
  ...C,
  controls: [...C.controls, 'throw', 'catch', 'try', 'new', 'delete'],
  keywords: [
    ...C.keywords,
    'alignas',
    'alignof',
    'and',
    'asm',
    'bitand',
    'bitor',
    'class',
    'compl',
    'concept',
    'constexpr',
    'consteval',
    'constinit',
    'const_cast',
    'decltype',
    'dynamic_cast',
    'explicit',
    'export',
    'friend',
    'mutable',
    'namespace',
    'noexcept',
    'not',
    'operator',
    'or',
    'override',
    'private',
    'protected',
    'public',
    'reinterpret_cast',
    'requires',
    'static_cast',
    'template',
    'this',
    'thread_local',
    'typename',
    'using',
    'virtual',
    'xor',
  ],
  types: [...(C.types ?? []), 'string', 'vector', 'map', 'unordered_map', 'set', 'pair', 'shared_ptr', 'unique_ptr'],
};

const CSHARP: CodeConfig = {
  lineComment: '//',
  blockComment: ['/*', '*/'],
  controls: [...FLOW, 'foreach', 'goto', 'lock', 'checked', 'unchecked', 'when', 'as', 'is', 'typeof', 'sizeof'],
  keywords: [
    ...C_LIKE_COMMON,
    'async',
    'await',
    'base',
    'bool',
    'byte',
    'char',
    'decimal',
    'delegate',
    'double',
    'event',
    'explicit',
    'extern',
    'fixed',
    'float',
    'implicit',
    'in',
    'int',
    'internal',
    'lock',
    'long',
    'namespace',
    'object',
    'operator',
    'out',
    'override',
    'params',
    'readonly',
    'ref',
    'sbyte',
    'sealed',
    'short',
    'string',
    'struct',
    'switch',
    'throw',
    'try',
    'typeof',
    'uint',
    'ulong',
    'unchecked',
    'unsafe',
    'ushort',
    'using',
    'var',
    'virtual',
    'volatile',
    'when',
    'where',
    'yield',
  ],
};

const GO: CodeConfig = {
  lineComment: '//',
  blockComment: ['/*', '*/'],
  controls: [...FLOW, 'defer', 'go', 'select', 'range', 'goto', 'fallthrough'],
  keywords: [
    'chan',
    'const',
    'func',
    'import',
    'interface',
    'map',
    'package',
    'struct',
    'type',
    'var',
    'false',
    'true',
    'nil',
    'iota',
  ],
  // В Go встроенные типы — отдельные имена, и красим их как типы.
  types: [
    'any',
    'bool',
    'byte',
    'complex64',
    'complex128',
    'error',
    'float32',
    'float64',
    'int',
    'int8',
    'int16',
    'int32',
    'int64',
    'rune',
    'string',
    'uint',
    'uint8',
    'uint16',
    'uint32',
    'uint64',
    'uintptr',
  ],
};

const RUST: CodeConfig = {
  lineComment: '//',
  blockComment: ['/*', '*/'],
  controls: [...FLOW, 'match', 'loop', 'await', 'in', 'move'],
  keywords: [
    'as',
    'async',
    'const',
    'crate',
    'dyn',
    'enum',
    'extern',
    'fn',
    'for',
    'impl',
    'let',
    'mod',
    'mut',
    'pub',
    'ref',
    'self',
    'Self',
    'static',
    'struct',
    'super',
    'trait',
    'type',
    'union',
    'unsafe',
    'use',
    'where',
    'false',
    'true',
    'macro_rules',
  ],
  types: [
    'bool',
    'char',
    'str',
    'i8',
    'i16',
    'i32',
    'i64',
    'i128',
    'isize',
    'u8',
    'u16',
    'u32',
    'u64',
    'u128',
    'usize',
    'f32',
    'f64',
    'String',
    'Vec',
    'Option',
    'Some',
    'None',
    'Result',
    'Ok',
    'Err',
    'Box',
  ],
};

const KOTLIN: CodeConfig = {
  lineComment: '//',
  blockComment: ['/*', '*/'],
  triple: true,
  annotations: true,
  controls: [...FLOW, 'when', 'as', 'is', 'in', 'by'],
  keywords: [
    'abstract',
    'actual',
    'companion',
    'const',
    'constructor',
    'data',
    'enum',
    'expect',
    'external',
    'final',
    'fun',
    'import',
    'init',
    'internal',
    'lateinit',
    'object',
    'open',
    'operator',
    'out',
    'override',
    'package',
    'private',
    'protected',
    'public',
    'reified',
    'sealed',
    'suspend',
    'tailrec',
    'this',
    'typealias',
    'val',
    'var',
    'vararg',
    'where',
    'false',
    'true',
    'null',
  ],
  types: ['Any', 'Boolean', 'Byte', 'Char', 'Double', 'Float', 'Int', 'Long', 'Nothing', 'Short', 'String', 'Unit'],
};

const SWIFT: CodeConfig = {
  lineComment: '//',
  blockComment: ['/*', '*/'],
  controls: [...FLOW, 'guard', 'repeat', 'where', 'in', 'as', 'is', 'defer'],
  keywords: [
    'associatedtype',
    'actor',
    'any',
    'class',
    'deinit',
    'enum',
    'extension',
    'fileprivate',
    'func',
    'import',
    'init',
    'inout',
    'internal',
    'let',
    'open',
    'operator',
    'private',
    'protocol',
    'public',
    'rethrows',
    'some',
    'static',
    'struct',
    'subscript',
    'typealias',
    'var',
    'false',
    'true',
    'nil',
    'self',
    'Self',
    'super',
    'throws',
    'try',
    'async',
    'await',
  ],
  types: [
    'Bool',
    'Character',
    'Double',
    'Float',
    'Int',
    'String',
    'UInt',
    'Array',
    'Dictionary',
    'Set',
    'Optional',
    'Void',
  ],
};

const PHP: CodeConfig = {
  lineComment: '//',
  blockComment: ['/*', '*/'],
  controls: [
    ...FLOW,
    'foreach',
    'endif',
    'endwhile',
    'endfor',
    'endforeach',
    'elseif',
    'include',
    'include_once',
    'require',
    'require_once',
    'goto',
  ],
  keywords: [
    'abstract',
    'and',
    'array',
    'as',
    'callable',
    'class',
    'clone',
    'const',
    'declare',
    'echo',
    'enum',
    'extends',
    'final',
    'fn',
    'function',
    'global',
    'implements',
    'instanceof',
    'insteadof',
    'interface',
    'match',
    'namespace',
    'new',
    'or',
    'print',
    'private',
    'protected',
    'public',
    'readonly',
    'static',
    'trait',
    'unset',
    'use',
    'var',
    'xor',
    'false',
    'true',
    'null',
    'self',
    'parent',
  ],
  types: ['bool', 'float', 'int', 'iterable', 'mixed', 'never', 'object', 'string', 'void'],
};

const DART: CodeConfig = {
  lineComment: '//',
  blockComment: ['/*', '*/'],
  controls: [...FLOW, 'in', 'is', 'as', 'async', 'await', 'yield', 'when'],
  keywords: [
    'abstract',
    'class',
    'const',
    'covariant',
    'deferred',
    'dynamic',
    'enum',
    'export',
    'extends',
    'extension',
    'external',
    'factory',
    'final',
    'get',
    'hide',
    'implements',
    'import',
    'interface',
    'late',
    'library',
    'mixin',
    'new',
    'on',
    'operator',
    'part',
    'required',
    'rethrow',
    'sealed',
    'set',
    'show',
    'static',
    'super',
    'this',
    'typedef',
    'var',
    'with',
    'false',
    'true',
    'null',
  ],
  types: [
    'bool',
    'double',
    'Function',
    'Future',
    'int',
    'Iterable',
    'List',
    'Map',
    'num',
    'Object',
    'Set',
    'Stream',
    'String',
    'void',
  ],
};

const SCALA: CodeConfig = {
  lineComment: '//',
  blockComment: ['/*', '*/'],
  triple: true,
  annotations: true,
  controls: [...FLOW, 'match', 'yield'],
  keywords: [
    'abstract',
    'case',
    'class',
    'def',
    'derives',
    'end',
    'enum',
    'export',
    'extends',
    'final',
    'given',
    'implicit',
    'import',
    'inline',
    'lazy',
    'opaque',
    'open',
    'override',
    'package',
    'private',
    'protected',
    'sealed',
    'super',
    'this',
    'trait',
    'transparent',
    'type',
    'using',
    'val',
    'var',
    'with',
    'false',
    'true',
    'null',
  ],
  types: [
    'Any',
    'AnyRef',
    'Boolean',
    'Byte',
    'Char',
    'Double',
    'Float',
    'Int',
    'Long',
    'Map',
    'None',
    'Nothing',
    'Option',
    'Seq',
    'Set',
    'Short',
    'Some',
    'String',
    'Unit',
  ],
};

const GROOVY: CodeConfig = {
  lineComment: '//',
  blockComment: ['/*', '*/'],
  triple: true,
  controls: [...FLOW, 'in', 'instanceof'],
  keywords: [
    'abstract',
    'as',
    'assert',
    'class',
    'def',
    'enum',
    'extends',
    'final',
    'implements',
    'import',
    'interface',
    'native',
    'new',
    'package',
    'private',
    'protected',
    'public',
    'record',
    'sealed',
    'static',
    'super',
    'this',
    'trait',
    'var',
    'false',
    'true',
    'null',
  ],
  types: [
    'BigDecimal',
    'Boolean',
    'Byte',
    'Char',
    'Double',
    'Float',
    'Integer',
    'List',
    'Long',
    'Map',
    'Object',
    'Set',
    'Short',
    'String',
  ],
};

const LUA: CodeConfig = {
  lineComment: '--',
  controls: [...FLOW, 'then', 'end', 'repeat', 'until', 'in', 'goto', 'elseif'],
  keywords: ['and', 'function', 'local', 'nil', 'not', 'or', 'false', 'true', 'self'],
};

/** Язык с комментарием решёткой и без блочного — Ruby, Perl, R и им подобные. */
const HASH_COMMENT: CodeConfig = {
  lineComment: '#',
  controls: [
    ...FLOW,
    'unless',
    'until',
    'elsif',
    'then',
    'do',
    'next',
    'redo',
    'retry',
    'raise',
    'rescue',
    'ensure',
    'begin',
    'end',
    'not',
    'and',
    'or',
    'in',
  ],
  keywords: [
    'alias',
    'and',
    'begin',
    'break',
    'class',
    'def',
    'defined?',
    'do',
    'else',
    'elsif',
    'end',
    'ensure',
    'false',
    'for',
    'if',
    'in',
    'module',
    'next',
    'nil',
    'not',
    'or',
    'redo',
    'rescue',
    'retry',
    'return',
    'self',
    'super',
    'then',
    'true',
    'undef',
    'unless',
    'until',
    'when',
    'while',
    'yield',
    'lambda',
    'proc',
    'require',
    'require_relative',
    'attr_accessor',
    'attr_reader',
    'attr_writer',
    'new',
  ],
};

/**
 * Словари по идентификаторам языков приложения (`shared/languages.ts`). Языка здесь нет —
 * значит подсветки для него пока нет, и текст показывается как простой.
 */
export const CODE_GRAMMARS: Record<string, CodeConfig> = {
  javascript: JAVASCRIPT,
  typescript: TYPESCRIPT,
  java: JAVA,
  c: C,
  cpp: CPP,
  csharp: CSHARP,
  go: GO,
  rust: RUST,
  kotlin: KOTLIN,
  swift: SWIFT,
  php: PHP,
  dart: DART,
  scala: SCALA,
  groovy: GROOVY,
  lua: LUA,
  ruby: HASH_COMMENT,
  perl: HASH_COMMENT,
  r: HASH_COMMENT,
};

/** Готовые грамматики по идентификатору языка — собираются один раз при загрузке модуля. */
export const codeGrammars: Record<string, Grammar> = Object.fromEntries(
  Object.entries(CODE_GRAMMARS).map(([id, config]) => [id, makeCodeGrammar(id, config)]),
);

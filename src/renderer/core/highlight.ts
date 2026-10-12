import { LineHighlighter } from '../editor/highlight/highlighter';
import { grammarFor } from '../editor/highlight/registry';
import { tokenStyle, type Scheme } from './theme';

/**
 * Подсветка кода вне редактора — для блоков кода в чате.
 *
 * Грамматики и токенизатор — свои, те же, что в своём редакторе
 * (`editor/highlight/`): один разбор на всё приложение, а не вторая правда о языке.
 * Цвета берутся из общей палитры `theme.ts` — по роли токена, тем же `tokenStyle`,
 * что и в редакторе. Поэтому чат и редактор выглядят одинаково.
 *
 * Почему разметка строками, а цвета — inline (в атрибуте `style`), а не классами:
 * блок кода живёт в чате, вне редактора, и не должен зависеть от того, какие
 * таблицы стилей успели примениться.
 */

/** Модель пишет метку вольно: «js», «bash», «py». Приводим к идентификаторам языков. */
const LANGUAGE_ALIASES: Record<string, string> = {
  js: 'javascript',
  jsx: 'javascript',
  node: 'javascript',
  mjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  sh: 'shell',
  bash: 'shell',
  zsh: 'shell',
  console: 'shell',
  py: 'python',
  python3: 'python',
  yml: 'yaml',
  rb: 'ruby',
  cs: 'csharp',
  golang: 'go',
  'c++': 'cpp',
  docker: 'dockerfile',
  dockerfile: 'dockerfile',
  md: 'markdown',
  text: 'plaintext',
  txt: 'plaintext',
  '': 'plaintext',
};

/** Готовый HTML: подсветка зависит от схемы, поэтому и ключ кеша её учитывает. */
const cache = new Map<string, string>();
const MAX_CACHE = 300;

interface Target {
  node: HTMLElement;
  code: string;
  label: string;
}

/** Что уже подсвечено: при смене схемы цвета надо пересчитать. */
const live = new Set<Target>();
/** Реестр растёт во время стрима (лента пересобирает блоки на каждом кадре). */
const PRUNE_AT = 64;
let scheme: Scheme = 'dark';

/** Убираем узлы, которых уже нет в документе: держать их незачем. */
function prune(): void {
  for (const target of live) {
    if (!target.node.isConnected) live.delete(target);
  }
}

function languageId(label: string): string {
  const key = label.trim().toLowerCase();
  return LANGUAGE_ALIASES[key] ?? key;
}

/** Экранирование текста: разметку собираем строкой, значит тексту нужны сущности. */
function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Разметка по токенам: свои грамматики дают участки строки с ролью, мы превращаем
 * их в спаны с цветами палитры. Токены без роли остаются обычным текстом, а текст
 * между токенами (скобки, пробелы) добавляем как есть — так в разметке нет дыр.
 *
 * Границы токенов и тексты экранируем: разметку собираем строкой, значит тексту
 * нужны HTML-сущности.
 */
function buildHtml(code: string, language: string, current: Scheme): string {
  const source = code.split('\n');
  const grammar = grammarFor(language);
  // Языка без грамматики показываем как простой текст — это честнее, чем красить
  // наугад чужой грамматикой (та же логика, что в своём редакторе).
  if (!grammar) return source.map(escapeHtml).join('\n');

  const highlighter = new LineHighlighter(grammar, (line) => source[line] ?? '');
  const out: string[] = [];

  for (let index = 0; index < source.length; index += 1) {
    const line = source[index] ?? '';
    const tokens = highlighter.tokensFor(index);

    if (tokens.length === 0) {
      out.push(escapeHtml(line));
      continue;
    }

    let rendered = '';
    let cursor = 0;
    for (const token of tokens) {
      if (token.start > cursor) rendered += escapeHtml(line.slice(cursor, token.start));
      const text = escapeHtml(line.slice(token.start, token.end));
      const style = tokenStyle(current, token.type);
      // Начертание идёт вместе с цветом: в редакторе комментарий курсивный, а
      // ключевое слово полужирное — чат рисует тот же код и не должен отличаться.
      const css = [
        style.color ? `color:${style.color}` : '',
        style.italic ? 'font-style:italic' : '',
        style.bold ? 'font-weight:bold' : '',
      ]
        .filter(Boolean)
        .join(';');
      rendered += css ? `<span style="${css}">${text}</span>` : text;
      cursor = token.end;
    }
    if (cursor < line.length) rendered += escapeHtml(line.slice(cursor));
    out.push(rendered);
  }

  return out.join('\n');
}

/**
 * Готовая разметка блока. `null` — для языка нет грамматики: блок останется текстом.
 * Разбор синхронный: свои грамматики уже загружены, ждать нечего.
 */
function build(code: string, language: string): string | null {
  if (!grammarFor(language)) return null;
  return buildHtml(code, language, scheme);
}

/**
 * Готовая разметка доводится до узла. Из кеша — сразу, без ожиданий:
 * к моменту записи узел уже собран, но может быть ещё вне документа.
 */
function render(target: Target): void {
  const id = languageId(target.label);
  const key = `${scheme}|${id}|${target.code}`;
  const cached = cache.get(key);

  if (cached !== undefined) {
    target.node.innerHTML = cached;
    return;
  }

  paint(target, key, id);
}

/**
 * Посчитать и запомнить разметку. Разбор синхронный, поэтому кладём сразу: блок
 * кода может быть ещё не в документе — это не мешает — а `innerHTML` работает и
 * вне дерева.
 */
function paint(target: Target, key: string, id: string): void {
  const built = build(target.code, id);
  if (built === null) return;

  if (cache.size >= MAX_CACHE) cache.clear();
  cache.set(key, built);
  // Цвета ставим в сам узел, а не в «живой» на данный момент: если лента
  // успела перерисоваться, узел уже выброшен и его никто не увидит.
  target.node.innerHTML = built;
}

/**
 * Подсветить фрагмент. Подсветка ставится сразу (разбор синхронный), а текст
 * кладём первым — чтобы даже для языка без грамматики блок был виден.
 */
export function highlightInto(node: HTMLElement, code: string, label: string): void {
  if (live.size >= PRUNE_AT) prune();
  const target: Target = { node, code, label };
  live.add(target);
  node.textContent = code;
  render(target);
}

/** Смена схемы: цвета в кеше посчитаны по старой палитре. */
export function setHighlightScheme(next: Scheme): void {
  // Не выходим, если схема та же: вместе с ней могла смениться тема из файла,
  // и цвета в кеше посчитаны по старой палитре.
  scheme = next;
  cache.clear();
  prune();

  for (const target of [...live]) {
    if (target.node.isConnected) render(target);
  }
}

/**
 * Самопроверка: сколько токенов и цветов даёт подсветка по языкам. Нужна, когда
 * приходит «в чате не подсвечивается» — отчёт показывает, где обрыв: нет грамматики
 * для языка, токены без цвета или всё в порядке.
 */
export function diagnoseHighlighting(): string {
  const samples: Array<[string, string]> = [
    ['js', 'const answer = 42; // проверка'],
    ['python', 'def greet(name: str) -> str:\n    return f"привет, {name}"'],
    ['bash', 'npm run smoke:agent'],
    ['typescript', 'interface Row { id: number }'],
    ['json', '{ "name": "chui" }'],
  ];

  const report: string[] = [`схема: ${scheme}`];
  for (const [label, sample] of samples) {
    const id = languageId(label);
    const grammar = grammarFor(id);
    if (!grammar) {
      report.push(`${label} → ${id}: грамматики нет`);
      continue;
    }
    const lines = sample.split('\n');
    const highlighter = new LineHighlighter(grammar, (line) => lines[line] ?? '');
    let total = 0;
    let colored = 0;
    for (let index = 0; index < lines.length; index += 1) {
      for (const token of highlighter.tokensFor(index)) {
        total += 1;
        if (tokenStyle(scheme, token.type).color !== null) colored += 1;
      }
    }
    report.push(`${label} → ${id}: токенов ${total}, с цветом ${colored}`);
  }
  return report.join('\n');
}

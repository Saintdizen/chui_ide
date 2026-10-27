import { LineHighlighter } from '../editor/highlight/highlighter';
import type { Grammar } from '../editor/highlight/grammar';
import { sharedTokens } from '../editor/highlight/token-cache';
import { tokenStyle } from './theme';

/**
 * Подсветка кода вне редактора — для блоков кода в чате.
 *
 * Грамматики и токенизатор — свои, те же, что в своём редакторе
 * (`editor/highlight/`): один разбор на всё приложение, а не вторая правда о языке.
 * Цвета берутся из общей палитры `theme.ts` — по роли токена, тем же `tokenStyle`,
 * что и в редакторе. Поэтому чат и редактор выглядят одинаково.
 *
 * Грамматики грузятся по требованию (`grammarLoader`), а не тянутся статическим
 * импортом: их 34 на десятки КБ, а чат без блоков кода — самый частый случай.
 * Пока модуль не приехал, блок остаётся простым текстом; по приезде `paint`
 * раскрашивает всё, что просило.
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

/**
 * Грамматику берём по требованию. Граф статических импортов ведёт от чата к реестру,
 * и расколоть этот граф без `import()` было нельзя: реестр тянул за собой все языки в
 * первый же чанк — ради одного блока кода. Теперь `registry` (34 языка, десятки КБ)
 * для чата загружаемый: модуль приезжает своим куском по первому нужному языку.
 * Остальные потребители редактора остаются статическими — их язык известен сразу.
 */
let registry: typeof import('../editor/highlight/registry') | null = null;
let registryLoad: Promise<typeof import('../editor/highlight/registry')> | null = null;

function registryModule(): Promise<typeof import('../editor/highlight/registry')> {
  registryLoad ??= import('../editor/highlight/registry').then((module) => {
    registry = module;
    return module;
  });
  return registryLoad;
}

/** Синхронная проверка: реестр ещё не приехал — значит грамматики пока нет. */
function knownGrammar(id: string): Grammar | null {
  return registry ? registry.grammarFor(id) : null;
}

/**
 * Грамматика языка — по требованию. Реестр (34 набора) тянется `import()`: в чате
 * блок кода — не главное, и везти все языки в первом чанке незачем.
 *
 * `pending` — потому что стрим зовёт блоки каждый кадр: одно обещание на язык,
 * а не пачка одинаковых импортов на перерисовку.
 */
const pending = new Map<string, Promise<Grammar | null>>();

async function loadGrammar(id: string): Promise<Grammar | null> {
  const known = pending.get(id);
  if (known) return known;
  const loading = registryModule().then((module) => module.grammarFor(id));
  pending.set(id, loading);
  return loading;
}

/** Готовый HTML: подсветка зависит от языка, поэтому и ключ кеша его учитывает. */
const cache = new Map<string, string>();
const MAX_CACHE = 300;

interface Target {
  node: HTMLElement;
  code: string;
  label: string;
}

/** Что уже подсвечено: при смене темы цвета надо пересчитать. */
const live = new Set<Target>();
/** Реестр растёт во время стрима (лента пересобирает блоки на каждом кадре). */
const PRUNE_AT = 64;

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
function buildHtml(code: string, grammar: Grammar): string {
  const source = code.split('\n');
  const highlighter = new LineHighlighter(grammar, (line) => source[line] ?? '', sharedTokens);
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
      const style = tokenStyle(token.type);
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
 * Грамматики тянем по требованию (`loadGrammar`): без этого весь набор языков ехал
 * в первом же чанке ради одного блока кода в чате.
 */
async function build(code: string, language: string): Promise<string | null> {
  const grammar = await loadGrammar(language);
  if (!grammar) return null;
  return buildHtml(code, grammar);
}

/**
 * Готовая разметка доводится до узла. Из кеша — сразу, без ожиданий:
 * к моменту записи узел уже собран, но может быть ещё вне документа.
 */
function render(target: Target): void {
  const id = languageId(target.label);
  const key = `${id}|${target.code}`;
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
  void build(target.code, id).then((built) => {
    if (built === null) return;

    if (cache.size >= MAX_CACHE) cache.clear();
    cache.set(key, built);
    // Цвета ставим в сам узел, а не в «живой» на данный момент: если лента
    // успела перерисоваться, узел уже выброшен и его никто не увидит.
    target.node.innerHTML = built;
  });
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

/** Смена темы: цвета в кеше посчитаны по старым краскам. */
export function refreshHighlight(): void {
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

  const report: string[] = [];
  for (const [label, sample] of samples) {
    const id = languageId(label);
    const grammar = knownGrammar(id);
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
        if (tokenStyle(token.type).color !== null) colored += 1;
      }
    }
    report.push(`${label} → ${id}: токенов ${total}, с цветом ${colored}`);
  }
  return report.join('\n');
}

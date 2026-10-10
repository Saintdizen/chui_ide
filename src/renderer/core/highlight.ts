import * as monaco from 'monaco-editor';
import { tokenStyle, type Scheme } from './theme';

/**
 * Подсветка кода вне редактора — для блоков кода в чате.
 *
 * ГраМматика и токенизатор берутся у Monaco (те же, что в редакторе), а цвета
 * расставляет наш код по палитре `theme.ts`.
 *
 * Почему не `monaco.editor.colorize` целиком: он отдаёт разметку с классами
 * `mtk*`, а сами цвета лежат в отдельной таблице стилей Monaco. Если таблица
 * не применилась, весь код оставался белым, хотя токены размечены верно.
 * Своя разметка снимает эту зависимость: цвета приходят inline.
 */

/** Модель пишет метку вольно: «js», «bash», «py». Приводим к идентификаторам Monaco. */
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
 * Разметка по токенам: `tokenize` отдаёт типы токенов, мы превращаем их в спаны
 * с цветами нашей палитры. Токены без своего цвета остаются обычным текстом.
 * Строки собираются отдельно, а склейка идёт по переводу строки: если собирать
 * всё в один список, переводы строк встают между токенами и код рассыпается
 * по одному слову на строку.
 */
function buildHtml(code: string, language: string, current: Scheme): string {
  const lines = monaco.editor.tokenize(code, language);
  const source = code.split('\n');
  const out: string[] = [];

  for (let index = 0; index < source.length; index += 1) {
    const line = source[index] ?? '';
    const tokens = lines[index] ?? [];

    if (tokens.length === 0) {
      out.push(escapeHtml(line));
      continue;
    }

    let rendered = '';
    for (let token = 0; token < tokens.length; token += 1) {
      const start = tokens[token]!.offset;
      // Конец токена — начало следующего: длина берётся без обращения к грамматике.
      const end = token + 1 < tokens.length ? tokens[token + 1]!.offset : line.length;
      if (end <= start) continue;

      const text = escapeHtml(line.slice(start, end));
      const style = tokenStyle(current, tokens[token]!.type);
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
    }
    out.push(rendered);
  }

  return out.join('\n');
}

/**
 * Ждём загрузку языка (это умеет только `colorize`) и красим токены сами.
 * `null` — языка нет или он не загрузился: блок останется обычным текстом.
 */
async function build(code: string, language: string): Promise<string | null> {
  try {
    await monaco.editor.colorize(code, language, { tabSize: 2 });
  } catch (error) {
    console.warn(`[chui] язык «${language}» не загрузился, подсветка пропущена`, error);
    return null;
  }

  const lines = monaco.editor.tokenize(code, language);
  if (!lines || lines.length === 0) return null;
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

  void paint(target, key, id);
}

async function paint(target: Target, key: string, id: string): Promise<void> {
  const built = await build(target.code, id);
  if (built === null) return;

  if (cache.size >= MAX_CACHE) cache.clear();
  cache.set(key, built);
  // Цвета ставим в сам узел, а не в «живой» на данный момент: если лента
  // успела перерисоваться, узел уже выброшен и его никто не увидит.
  target.node.innerHTML = built;
}

/**
 * Очередь на отрисовку. Красить надо не в момент создания узла, а после того,
 * как дерево собрано: блок кода появляется вне документа и подключается только
 * в конце `renderInto`. Именно из-за этого «подсветка тухла, как только ответ
 * заканчивался»: готовый блок брался из кеша, но узел ещё не был в документе.
 */
const pending = new Set<Target>();
let flushing = false;

function scheduleFlush(): void {
  if (flushing) return;
  flushing = true;
  queueMicrotask(() => {
    flushing = false;
    const batch = [...pending];
    pending.clear();
    for (const target of batch) render(target);
  });
}

/**
 * Подсветить фрагмент. Текст ставится сразу, подсветка — как придёт:
 * ждать её, чтобы показать ответ, незачем.
 */
export function highlightInto(node: HTMLElement, code: string, label: string): void {
  if (live.size >= PRUNE_AT) prune();
  const target: Target = { node, code, label };
  live.add(target);
  node.textContent = code;
  pending.add(target);
  scheduleFlush();
}

/** Смена схемы: цвета в кеше посчитаны по старой палитре. */
export function setHighlightScheme(next: Scheme): void {
  if (next === scheme) return;
  scheme = next;
  cache.clear();
  prune();

  for (const target of [...live]) {
    if (target.node.isConnected) render(target);
  }
}

/**
 * Самопроверка: сколько токенов и цветов даёт подсветка по языкам. Нужна, когда
 * приходит «в чате не подсвечивается» — отчёт показывает, где обрыв: язык
 * не загрузился, токены без цвета или всё в порядке.
 */
export async function diagnoseHighlighting(): Promise<string> {
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
    try {
      await monaco.editor.colorize(sample, id, { tabSize: 2 });
      const lines = monaco.editor.tokenize(sample, id);
      const all = lines.flat();
      const colored = all.filter((token) => tokenStyle(scheme, token.type).color !== null).length;
      report.push(`${label} → ${id}: токенов ${all.length}, с цветом ${colored}`);
    } catch (error) {
      report.push(`${label} → ${id}: ошибка ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return report.join('\n');
}

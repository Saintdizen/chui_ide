/**
 * Ответы по документации проекта: нарезка документов на разделы и поиск по ним.
 *
 * Отличие от поиска по коду (`codebase_search`, `search_docs` рядом с ним): здесь
 * источник — не код, а сама документация (README, `docs/`, `*.md`, `*.rst`). Файлы
 * режутся на разделы по заголовкам, и на запрос возвращаются те разделы, что ближе
 * по словам, — вместе с путём, заголовком и строкой, чтобы раздел можно было дочитать.
 *
 * Это отбор без внешних зависимостей: ни векторной базы, ни сетевого сервиса. Слова
 * запроса и баллы считает тот же разбор, что и поиск по смыслу (`meaning-search`):
 * так «как установить» находит «Установка зависимостей», а не требует точной строки.
 *
 * Модуль чистый: текст документа приходит строкой, диск и Electron остаются снаружи.
 */

import { meaningTerms, scoreText } from './meaning-search';

/** Разделы документации крупнее этого режем по абзацам: точность поиска важнее связности. */
const MAX_CHUNK_CHARS = 1600;
/** Сколько символов раздела показывать в ответе: дальше модели важнее путь и строка. */
const MAX_SNIPPET_CHARS = 700;
/** Заголовок раздела весит больше текста: по нему раздел и узнают. */
const HEADING_WEIGHT = 3;

/** Расширения, которые считаем документацией. */
const DOC_EXTENSIONS = ['.md', '.mdx', '.markdown', '.rst', '.adoc', '.txt', '.text'];
/** Имена файлов без расширения или с любым: README, CHANGELOG, CONTRIBUTING. */
const DOC_BASENAMES = ['readme', 'changelog', 'contributing', 'install', 'usage', 'architecture', 'guide', 'notes'];

/**
 * Документация ли это. Отбираем по расширению и по имени файла: `README` без
 * расширения и `docs/` с любым текстовым расширением — документация, а `README.png`
 * и прочий двоичный хлам в индекс не попадут.
 */
export function isDocPath(relative: string): boolean {
  const lower = relative.toLowerCase().replace(/\\/g, '/');
  const base = lower.slice(lower.lastIndexOf('/') + 1);
  if (base === '') return false;
  if (DOC_EXTENSIONS.some((ext) => base.endsWith(ext))) return true;
  // Имя без расширения: README, CHANGELOG, CONTRIBUTING. С расширением код
  // (`readme.ts`) в документацию не попадает: расширение уже проверено выше.
  return !base.includes('.') && DOC_BASENAMES.includes(base);
}

/** Раздел документа: заголовок (цепочка вложенности), строка начала и текст. */
export interface DocChunk {
  /** Путь в том виде, в каком его передали (в main — абсолютный). */
  path: string;
  /** Заголовок раздела: `Установка > Зависимости`; пустой — текст без заголовков. */
  heading: string;
  /** Строка начала раздела (1-based) — чтобы «дочитать» его через read_file. */
  line: number;
  /** Тело раздела: заголовок (если был) и текст до следующего заголовка. */
  text: string;
}

/** Найти раздел: путь, заголовок, строка и выдержка текста. */
export interface DocHit {
  path: string;
  heading: string;
  line: number;
  snippet: string;
  /** Больше — ближе к запросу. */
  score: number;
}

export interface DocsQuery {
  query: string;
  /** Сколько разделов вернуть (по умолчанию — 6). */
  limit?: number;
}

export interface DocsResult {
  query: string;
  hits: DocHit[];
  /** Сколько файлов документации просмотрено. */
  files: number;
  /** Сколько разделов из них нарезано. */
  chunks: number;
}

/** Нарезать документ на разделы по языку разметки (по расширению пути). */
export function splitDocChunks(path: string, text: string): DocChunk[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const lower = path.toLowerCase();
  if (lower.endsWith('.rst')) return splitRst(path, lines);
  if (lower.endsWith('.md') || lower.endsWith('.mdx') || lower.endsWith('.markdown')) {
    return splitMarkdown(path, lines);
  }
  return splitPlain(path, lines);
}

/** Markdown (и mdx): разделы — по строкам `# …`, вложенность — цепочкой заголовков. */
function splitMarkdown(path: string, lines: readonly string[]): DocChunk[] {
  const chunks: DocChunk[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  let current: { heading: string; line: number; body: string[] } | null = null;

  const flush = (): void => {
    if (!current) return;
    pushSection(chunks, path, current.heading, current.line, current.body);
    current = null;
  };

  lines.forEach((line, index) => {
    // Закрывающие решётки (`# Заголовок ##`) не часть названия: убираем.
    const match = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (match) {
      flush();
      const level = match[1]!.length;
      const title = match[2]!.trim();
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, title });
      current = { heading: stack.map((item) => item.title).join(' > '), line: index + 1, body: [line] };
      return;
    }
    if (!current) current = { heading: '', line: index + 1, body: [] };
    current.body.push(line);
  });
  flush();

  return chunks;
}

/** reStructuredText: заголовок — строка, подчёркнутая строкой из одного символа. */
function splitRst(path: string, lines: readonly string[]): DocChunk[] {
  const chunks: DocChunk[] = [];
  const stack: Array<{ level: number; title: string }> = [];
  const levels: string[] = [];
  let current: { heading: string; line: number; body: string[] } | null = null;

  const flush = (): void => {
    if (!current) return;
    pushSection(chunks, path, current.heading, current.line, current.body);
    current = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const underline = lines[index + 1];
    if (
      line.trim() !== '' &&
      underline !== undefined &&
      isRstUnderline(underline) &&
      underline.trim().length >= line.trim().length
    ) {
      flush();
      const char = underline.trim()[0]!;
      let level = levels.indexOf(char);
      if (level < 0) {
        levels.push(char);
        level = levels.length - 1;
      }
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, title: line.trim() });
      current = { heading: stack.map((item) => item.title).join(' > '), line: index + 1, body: [line] };
      index += 1; // строку-подчёркивание пропускаем: она не текст раздела
      continue;
    }
    if (!current) current = { heading: '', line: index + 1, body: [] };
    current.body.push(line);
  }
  flush();

  return chunks;
}

/** Подчёркивание заголовка в rst: строка из одного и того же знака препинания. */
function isRstUnderline(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.length > 0 && /^[=\-~^"'`+#*:<>.]+$/.test(trimmed);
}

/** Текст без разметки (txt, adoc и прочее): делим на абзацы, заголовков не ищем. */
function splitPlain(path: string, lines: readonly string[]): DocChunk[] {
  const chunks: DocChunk[] = [];
  pushSection(chunks, path, '', 1, lines);
  return chunks;
}

/**
 * Разбить раздел на части, не превышающие `MAX_CHUNK_CHARS`, по пустым строкам.
 * Огромный раздел (весь README под одним заголовком) иначе был бы одним куском —
 * и на запрос о разделе в его конце нашёлся бы весь файл целиком.
 */
function pushSection(
  out: DocChunk[],
  path: string,
  heading: string,
  startLine: number,
  bodyLines: readonly string[],
): void {
  // Соседние непустые строки — один абзац: режем по пустым, не по каждой строке.
  const segments: Array<{ line: number; lines: string[] }> = [];
  let segment: string[] = [];
  let segmentLine = startLine;
  for (let index = 0; index < bodyLines.length; index += 1) {
    const line = bodyLines[index]!;
    if (line.trim() === '') {
      if (segment.length > 0) {
        segments.push({ line: segmentLine, lines: segment });
        segment = [];
      }
      continue;
    }
    if (segment.length === 0) segmentLine = startLine + index;
    segment.push(line);
  }
  if (segment.length > 0) segments.push({ line: segmentLine, lines: segment });

  let bucket: { line: number; lines: string[] } | null = null;
  let size = heading.length + 1;
  const flush = (): void => {
    if (!bucket) return;
    const text = bucket.lines.join('\n').trim();
    if (text !== '') out.push({ path, heading, line: bucket.line, text });
    bucket = null;
    size = heading.length + 1;
  };

  for (const part of segments) {
    const partSize = part.lines.reduce((sum, line) => sum + line.length + 1, 0);
    if (bucket && size + partSize > MAX_CHUNK_CHARS) flush();
    if (!bucket) bucket = { line: part.line, lines: [] };
    bucket.lines.push(...part.lines);
    size += partSize;
    if (size >= MAX_CHUNK_CHARS) flush();
  }
  flush();
}

/**
 * Отобрать и упорядочить разделы по запросу. Баллы — как у поиска по смыслу: слово
 * целиком весит больше вхождения, строка со всеми словами получает надбавку. Сверх
 * этого заголовок весит втрое: раздел «Установка» по запросу «установка» должен
 * идти впереди раздела, где это слово лишь мелькнуло в тексте.
 */
export function rankDocChunks(chunks: readonly DocChunk[], query: string, limit: number): DocHit[] {
  // Слова из одной буквы («в», «и») отбрасываем: в тексте они встречаются почти
  // всегда и только шумят — по ним раздел не опознать.
  const terms = meaningTerms(query).filter((term) => term.length > 1);
  if (terms.length === 0) return [];

  const hits: DocHit[] = [];
  const seen = new Set<string>();
  for (const chunk of chunks) {
    const score = scoreText(chunk.heading, terms) * HEADING_WEIGHT + scoreText(chunk.text, terms);
    if (score === 0) continue;
    const key = `${chunk.path}:${chunk.line}`;
    if (seen.has(key)) continue;
    seen.add(key);
    hits.push({
      path: chunk.path,
      heading: chunk.heading,
      line: chunk.line,
      snippet: snippetOf(chunk.text),
      score,
    });
  }

  hits.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path) || a.line - b.line);
  return hits.slice(0, Math.max(0, limit));
}

/** Выдержка раздела: начало текста, чтобы по ответу было видно, тот ли это раздел. */
function snippetOf(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_SNIPPET_CHARS) return trimmed;
  return `${trimmed.slice(0, MAX_SNIPPET_CHARS).trimEnd()}…`;
}

/**
 * Ответ инструмента человеческим текстом. Раздел показываем с путём, строкой и
 * заголовком, чтобы его можно было дочитать целиком (`read_file` с startLine/endLine),
 * а не только по выдержке: выдержка обрезана и как источник истины не годится.
 */
export function formatDocsAnswer(
  result: DocsResult,
  display?: (path: string) => string,
): { summary: string; detail: string } {
  const name = display ?? ((path: string) => path);

  if (result.hits.length === 0) {
    if (result.files === 0) {
      return {
        summary: `«${result.query}»: документации в проекте нет`,
        detail:
          'Файлов документации (README, docs/, *.md) в проекте не нашлось. Отвечай по коду: ' +
          'search, codebase_search, project_map.',
      };
    }
    return {
      summary: `«${result.query}»: в документации не найдено`,
      detail: `Просмотрено файлов документации: ${result.files}, разделов ${result.chunks} — подходящих не нашлось. Уточни формулировку или поищи в коде (search, codebase_search).`,
    };
  }

  const lines = [
    `Разделы документации по запросу «${result.query}» (просмотрено файлов ${result.files}, разделов ${result.chunks}):`,
  ];
  result.hits.forEach((hit, index) => {
    const where = hit.heading ? `${name(hit.path)}:${hit.line} — «${hit.heading}»` : `${name(hit.path)}:${hit.line}`;
    lines.push('', `${index + 1}. ${where}`, hit.snippet);
  });
  lines.push(
    '',
    'Это выдержки из документации проекта. Если нужен раздел целиком — прочитай его (read_file с startLine/endLine).',
  );

  return { summary: `«${result.query}»: разделов ${result.hits.length} в документации`, detail: lines.join('\n') };
}

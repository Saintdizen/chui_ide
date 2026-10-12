/**
 * Замечания к коду (code review) — модель и её проверка.
 *
 * Ревью — это не правка файла и не команда git: это отдельный слой заметок «вот тут
 * не так», которые человек оставляет, читая сравнение. Замечание привязано к месту в
 * сравнении: файл, сторона (было/стало) и номер строки на этой стороне. Замечаний к
 * одной строке бывает несколько — они складываются в ТРЕД (обсуждение): под первым
 * замечанием идут ответы. Тред можно пометить решённым, не удаляя историю.
 *
 * Место держим парой «номер + текст строки»: номер после правок файла сдвигается, а
 * текст остаётся — по нему тред можно посадить обратно на строку или честно сказать,
 * что она уехала. Здесь же только модель и её проверка; чтение и запись файла —
 * в main (`project/review-store.ts`), показ — в экране сравнения.
 *
 * Модуль чистый: ни DOM, ни файлов, поэтому его видно в тестах целиком.
 */

/** Сторона сравнения: `original` — левая (было), `modified` — правая (стало). */
export type ReviewSide = 'original' | 'modified';

/** Одно сообщение в треде. */
export interface ReviewComment {
  id: string;
  text: string;
  /** Кто написал: локальные замечания подписаны `вы`, импортированные — своим именем. */
  author: string;
  /** Время создания, миллисекунды. */
  createdAt: number;
}

/** Обсуждение у одной строки сравнения. */
export interface ReviewThread {
  id: string;
  /** Путь файла от корня проекта — как в git-статусе и в дереве. */
  path: string;
  side: ReviewSide;
  /** Номер строки НА ЭТОЙ стороне (с единицы). */
  line: number;
  /** Текст строки на момент создания: по нему тред держится за место, а не за номер. */
  anchor: string;
  /** Решён ли тред. Решённые не теряем: их можно раскрыть и снова открыть. */
  resolved: boolean;
  /** Первое сообщение — замечание, остальные — ответы в треде. */
  comments: ReviewComment[];
}

/** Подпись автора локальных замечаний. */
export const REVIEW_LOCAL_AUTHOR = 'вы';

/** Границы, за которые не пускаем ни текст, ни число тредов. */
export const REVIEW_TEXT_MAX = 4000;
export const REVIEW_ANCHOR_MAX = 200;
export const REVIEW_THREAD_MAX = 2000;
export const REVIEW_COMMENTS_MAX = 200;

/** Счётчик для идентификаторов: различает замечания, созданные в одну миллисекунду. */
let idCounter = 0;

/** Новый идентификатор замечания или треда. Формат не важен — важна уникальность. */
export function reviewId(prefix = 'r'): string {
  idCounter += 1;
  return `${prefix}${Date.now().toString(36)}${idCounter.toString(36)}`;
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\r\n?/g, '\n').trim();
  return text.length > max ? text.slice(0, max) : text;
}

function cleanLine(value: unknown): number {
  const line = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : 1;
  return line < 1 ? 1 : line;
}

/** Новое замечание: текст и автор, время — сейчас. */
export function makeComment(text: string, author: string, now = Date.now()): ReviewComment {
  return { id: reviewId('c'), text: cleanText(text, REVIEW_TEXT_MAX), author, createdAt: now };
}

/** Новый тред с первым замечанием. */
export function makeThread(
  path: string,
  side: ReviewSide,
  line: number,
  anchor: string,
  text: string,
  author = REVIEW_LOCAL_AUTHOR,
  now = Date.now(),
): ReviewThread {
  return {
    id: reviewId('t'),
    path,
    side,
    line: cleanLine(line),
    anchor: cleanText(anchor, REVIEW_ANCHOR_MAX),
    resolved: false,
    comments: [makeComment(text, author, now)],
  };
}

/**
 * Проверка того, что пришло из файла: незнакомое и битое отбрасываем, а не роняем
 * загрузку. Тред без единого сообщения смысла не имеет — его тоже отбрасываем.
 */
export function sanitizeReview(raw: unknown): ReviewThread[] {
  const source = Array.isArray(raw)
    ? raw
    : typeof raw === 'object' && raw !== null && Array.isArray((raw as { threads?: unknown }).threads)
      ? ((raw as { threads: unknown[] }).threads as unknown[])
      : [];
  const threads: ReviewThread[] = [];
  for (const item of source) {
    if (typeof item !== 'object' || item === null) continue;
    const value = item as Record<string, unknown>;
    const path = typeof value.path === 'string' ? value.path : '';
    if (path === '') continue;
    const side: ReviewSide = value.side === 'original' ? 'original' : 'modified';
    const comments: ReviewComment[] = [];
    const rawComments = Array.isArray(value.comments) ? value.comments : [];
    for (const rawComment of rawComments) {
      if (typeof rawComment !== 'object' || rawComment === null) continue;
      const comment = rawComment as Record<string, unknown>;
      const text = cleanText(comment.text, REVIEW_TEXT_MAX);
      if (text === '') continue;
      comments.push({
        id: typeof comment.id === 'string' && comment.id !== '' ? comment.id : reviewId('c'),
        text,
        author: typeof comment.author === 'string' && comment.author !== '' ? comment.author : REVIEW_LOCAL_AUTHOR,
        createdAt: typeof comment.createdAt === 'number' && Number.isFinite(comment.createdAt) ? comment.createdAt : 0,
      });
      if (comments.length >= REVIEW_COMMENTS_MAX) break;
    }
    if (comments.length === 0) continue;
    threads.push({
      id: typeof value.id === 'string' && value.id !== '' ? value.id : reviewId('t'),
      path,
      side,
      line: cleanLine(value.line),
      anchor: cleanText(value.anchor, REVIEW_ANCHOR_MAX),
      resolved: value.resolved === true,
      comments,
    });
    if (threads.length >= REVIEW_THREAD_MAX) break;
  }
  return threads;
}

/** Треды файла, в порядке строк: так их и показываем — сверху вниз по коду. */
export function threadsForFile(threads: readonly ReviewThread[], path: string): ReviewThread[] {
  return threads.filter((thread) => thread.path === path).sort(compareThreads);
}

/** Треды у конкретной строки одной стороны (их может быть несколько). */
export function threadsAt(
  threads: readonly ReviewThread[],
  path: string,
  side: ReviewSide,
  line: number,
): ReviewThread[] {
  return threads.filter((thread) => thread.path === path && thread.side === side && thread.line === line);
}

/** Порядок показа: сначала по строке, затем по времени первого сообщения. */
function compareThreads(a: ReviewThread, b: ReviewThread): number {
  if (a.line !== b.line) return a.line - b.line;
  const aTime = a.comments[0]?.createdAt ?? 0;
  const bTime = b.comments[0]?.createdAt ?? 0;
  return aTime - bTime;
}

/** Добавить тред к списку (копией — список не мутируем). */
export function addThread(threads: readonly ReviewThread[], thread: ReviewThread): ReviewThread[] {
  return [...threads, thread];
}

/** Убрать тред. */
export function removeThread(threads: readonly ReviewThread[], id: string): ReviewThread[] {
  return threads.filter((thread) => thread.id !== id);
}

/** Добавить сообщение в тред. */
export function addComment(threads: readonly ReviewThread[], id: string, comment: ReviewComment): ReviewThread[] {
  return threads.map((thread) =>
    thread.id === id ? { ...thread, comments: [...thread.comments, comment].slice(-REVIEW_COMMENTS_MAX) } : thread,
  );
}

/** Пометить тред решённым или снова открытым. */
export function setResolved(threads: readonly ReviewThread[], id: string, resolved: boolean): ReviewThread[] {
  return threads.map((thread) => (thread.id === id ? { ...thread, resolved } : thread));
}

/** Правка текста последнего сообщения треда (человек поправил опечатку). */
export function editLastComment(threads: readonly ReviewThread[], id: string, text: string): ReviewThread[] {
  const clean = cleanText(text, REVIEW_TEXT_MAX);
  if (clean === '') return [...threads];
  return threads.map((thread) => {
    if (thread.id !== id || thread.comments.length === 0) return thread;
    const comments = [...thread.comments];
    const last = comments[comments.length - 1]!;
    comments[comments.length - 1] = { ...last, text: clean };
    return { ...thread, comments };
  });
}

/** Сколько тредов открыто и сколько решено. */
export function reviewCounts(threads: readonly ReviewThread[]): { open: number; resolved: number; comments: number } {
  let open = 0;
  let resolved = 0;
  let comments = 0;
  for (const thread of threads) {
    if (thread.resolved) resolved += 1;
    else open += 1;
    comments += thread.comments.length;
  }
  return { open, resolved, comments };
}

/** Подпись для шапки: «2 замечания, 1 решено» или «замечаний нет». */
export function reviewSummary(threads: readonly ReviewThread[]): string {
  const { open, resolved } = reviewCounts(threads);
  if (open === 0 && resolved === 0) return 'замечаний нет';
  const fresh = `${open} ${plural(open, 'замечание', 'замечания', 'замечаний')}`;
  return resolved > 0 ? `${fresh}, ${resolved} решено` : fresh;
}

/** Русское склонение по числу — для подписи в интерфейсе. */
export function plural(count: number, one: string, few: string, many: string): string {
  const mod100 = count % 100;
  const mod10 = count % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

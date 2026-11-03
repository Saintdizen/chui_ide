/**
 * Куда идти, когда инструмент не умеет то, о чём его попросили.
 *
 * Правило нужно не человеку, а модели: она по описанию инструментов не всегда
 * различает «страница по ссылке» и «файл на диске», и, получив отказ, повторяет
 * тот же вызов с другим адресом. Отказ поэтому должен говорить не «нельзя», а
 * какой инструмент тут работает и почему.
 */

/** Инструмент, к которому отправляем. */
export type RedirectTool = 'read' | 'write' | 'bash';

export interface Redirect {
  readonly tool: RedirectTool;
  /** Почему этот, а не запрошенный. Одной фразой, как объясняют человеку. */
  readonly why: string;
}

/**
 * Что лежит по адресу, если это не страница.
 *
 * `web_fetch` берёт только текст: PDF, архивы, картинки и бинарники он пропускает
 * не из осторожности, а потому что разбор в текст для них не определён. Ссылка на
 * файл из GitHub (`/raw/`) — это именно такой случай, и он на практике частый.
 */
const FILE_EXTENSIONS = new Set([
  'pdf',
  'zip',
  'gz',
  'tgz',
  'tar',
  'bz2',
  'xz',
  '7z',
  'rar',
  'png',
  'jpg',
  'jpeg',
  'gif',
  'svg',
  'webp',
  'ico',
  'bmp',
  'avif',
  'mp3',
  'mp4',
  'mov',
  'avi',
  'wav',
  'ogg',
  'webm',
  'exe',
  'msi',
  'dmg',
  'deb',
  'rpm',
  'wasm',
  'bin',
  'so',
  'dll',
  'woff',
  'woff2',
  'ttf',
  'otf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'odt',
]);

/** Хвост адреса без кавычек и якоря: `a.pdf?raw=1#page=2` → `pdf`. */
function extensionOf(address: string): string | null {
  let path = address.trim();
  try {
    path = new URL(path).pathname;
  } catch {
    // Не URL — разбираем как есть: так приходит ответ инструмента.
  }
  const name = path.split('/').pop() ?? '';
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || dot === name.length - 1) return null;
  return name.slice(dot + 1).toLowerCase();
}

/**
 * Чем заменить `web_fetch` для этого адреса, или `null` — замена не нужна.
 *
 * `file:` — не «запрещённый», а просто другой инструмент: локальный файл читают
 * `read`, а не загрузчик страниц. Формулировать это как отказ бессмысленно: модель
 * пришла по адресу, значит файл у неё уже есть.
 */
export function redirectForUrl(address: string): Redirect | null {
  const trimmed = address.trim();
  if (/^file:\/\//i.test(trimmed)) {
    return {
      tool: 'read',
      why: 'это локальный файл: путь читает read, а загрузчик берёт только http и https',
    };
  }
  const extension = extensionOf(trimmed);
  if (extension && FILE_EXTENSIONS.has(extension)) {
    return {
      tool: 'bash',
      why: `по ссылке лежит ${extension}, а не страница: скачать файл можно через bash (curl), разбирать его — дальше`,
    };
  }
  return null;
}

/**
 * Адрес файловой системы: локальная папка или удалённая (SSH, WSL, контейнер).
 *
 * До этого «файловая система» в IDE была одна — та, где запущен main. Но работа
 * часто живёт не там: сервер по SSH, дистрибутив WSL, контейнер devcontainer.
 * Держать для них отдельные окна и копии проекта — не выход, а тащить в IDE
 * полноценный клиент каждой из систем — отдельная жизнь; поэтому здесь только
 * АДРЕС: разбор строки вида `ssh://user@host:22/srv/app` в понятные части, чтобы
 * дальше каждый слой мог сходить по нему своими средствами (см.
 * `main/workspace/remote-fs.ts` — команды, которыми это делается).
 *
 * Почему схема в пути, а не отдельная сущность: путь остаётся строкой, а значит
 * настройки, сессии и списки продолжают работать как раньше. Обычная локальная
 * папка адреса не имеет — она и есть путь, и это важно: `/home/me/proj` не должен
 * внезапно оказаться «адресом с пустой схемой».
 *
 * Модуль чистый: ни ФС, ни процессов. Разбор и подписи проверяются тестами.
 */

/** Вид удалённой системы. `local` — обычный путь, у него нет адреса. */
export type FsScheme = 'ssh' | 'wsl' | 'container';

/** Разобранный адрес: схема, «владение» (хост, дистрибутив, контейнер) и путь внутри. */
export interface FsAddress {
  scheme: FsScheme;
  /** Что именно адресуем: `user@host:порт` для SSH, имя дистрибутива для WSL, имя контейнера. */
  authority: string;
  /** Путь внутри системы. Всегда начинается с разделителя (после нормализации). */
  path: string;
}

/** Как схемы называются в интерфейсе. */
export const FS_SCHEME_LABELS: Record<FsScheme, string> = {
  ssh: 'SSH',
  wsl: 'WSL',
  container: 'Контейнер',
};

const SCHEMES: readonly FsScheme[] = ['ssh', 'wsl', 'container'];

/** Похоже ли на адрес: есть схема из известных и `://`. */
export function isFsAddress(value: string): boolean {
  const match = /^([a-z][a-z0-9+.-]*):\/\//i.exec(value.trim());
  return match !== null && SCHEMES.includes(match[1]!.toLowerCase() as FsScheme);
}

/**
 * Разобрать адрес. `null` — это не адрес или он неполный: вызывающий решает, что
 * сказать человеку (см. `addressProblem`).
 *
 * Владелец (хост, дистрибутив) обязателен: `ssh:///srv` — это «куда-то», и молча
 * подставить `localhost` было бы хуже ошибки.
 */
export function parseFsAddress(value: string): FsAddress | null {
  const text = value.trim();
  const match = /^([a-z][a-z0-9+.-]*):\/\/([^/]*)(\/.*)?$/i.exec(text);
  if (!match) return null;
  const scheme = match[1]!.toLowerCase() as FsScheme;
  if (!SCHEMES.includes(scheme)) return null;
  const authority = (match[2] ?? '').trim();
  if (!authority) return null;
  const path = match[3] && match[3].length > 0 ? match[3] : '/';
  return { scheme, authority, path: normalizeRemotePath(path) };
}

/** Путь внутри удалённой системы: приводим разделители и убираем хвост. */
export function normalizeRemotePath(path: string): string {
  // Windows-путь в WSL (`/mnt/c/...`) — обычный posix-путь, а вот одинокие
  // обратные слэши приходят от привычки набирать `C:\...` — их заменяем.
  const flat = path.replace(/\\/g, '/');
  const withRoot = flat.startsWith('/') ? flat : `/${flat}`;
  const trimmed = withRoot.length > 1 ? withRoot.replace(/\/+$/, '') : withRoot;
  return trimmed === '' ? '/' : trimmed;
}

/**
 * Собрать адрес обратно строкой: она идёт в настройки, сессии и подсказки.
 *
 * Путь корня показываем без слэша (`ssh://host`): так адрес читается как «папка на
 * хосте», а не как «папка в корне», и «подняться наверх» из односегментного пути
 * даёт тот же вид, что и разбор `ssh://host` — строка не гуляет между видами.
 */
export function formatFsAddress(address: FsAddress): string {
  const path = normalizeRemotePath(address.path);
  const base = `${address.scheme}://${address.authority}`;
  return path === '/' ? base : `${base}${path}`;
}

/** Спуститься в подкаталог адреса (или подняться, если сегментов пути не осталось). */
export function joinAddress(address: FsAddress, segment: string): string {
  const base = address.path === '/' ? '' : address.path;
  return formatFsAddress({ ...address, path: `${base}/${segment}` });
}

/** Имя верхнего сегмента пути — так адрес показывается в дереве и заголовках. */
export function addressName(address: FsAddress): string {
  const parts = address.path.split('/').filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? address.authority;
}

/** Путь родителя внутри адреса: `null` — уже корень, подниматься некуда. */
export function addressParent(address: FsAddress): string | null {
  if (address.path === '/') return null;
  const parts = address.path.split('/').filter((part) => part.length > 0);
  parts.pop();
  return formatFsAddress({ ...address, path: parts.length > 0 ? `/${parts.join('/')}` : '/' });
}

/**
 * Подпись адреса человеческим языком: по ней видно, чем он открывается.
 * Владелец показывается целиком — именно его надо править, если ошиблись.
 */
export function fsAddressLabel(address: FsAddress): string {
  return `${FS_SCHEME_LABELS[address.scheme]}: ${address.authority}${address.path}`;
}

/**
 * Что не так с введённой строкой. Пустая строка — всё в порядке. Текста намеренно
 * два вида: «это вообще не адрес» и «адрес, но неполный» — по ним разные правки.
 */
export function addressProblem(value: string): string | null {
  const text = value.trim();
  if (text === '') return 'Пустой адрес';
  if (parseFsAddress(text)) return null;
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(text)?.[1]?.toLowerCase();
  if (!scheme) {
    return 'Нужен адрес со схемой: ssh://, wsl:// или container:// — например, ssh://build@ci-server/srv/app';
  }
  if (!SCHEMES.includes(scheme as FsScheme)) {
    return `Схема «${scheme}» не поддерживается: известны ssh, wsl и container`;
  }
  return 'В адресе не хватает владельца: после «://» нужен хост, дистрибутив или имя контейнера';
}

/**
 * Схема адреса в имени пути: файлы внутри удалённой системы main адресует тем же
 * адресом плюс путь, поэтому «чем открывать» видно прямо по строке.
 */
export function addressSchemeOf(value: string): FsScheme | null {
  return parseFsAddress(value)?.scheme ?? null;
}

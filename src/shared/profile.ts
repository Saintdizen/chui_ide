/**
 * Профиль рабочего окружения — один файл, чтобы перенести настройки на другую машину
 * или вернуть прежние.
 *
 * В профиль идёт только то, что принадлежит человеку, а не машине:
 * тема, шрифты, поведение редактора, ассистент, раскладка панелей. Не идёт:
 * недавние проекты, список корней, история и всё, что знает о путях на диске
 * (у другой машины они другие), а также ключи API — они живут в отдельном
 * хранилище и в файл настроек не попадают вовсе.
 */

/** Расширение файла профиля: его подставляет сервис, если человек не вписал своё. */
export const PROFILE_EXTENSION = '.chui-profile.json';

export const PROFILE_KIND = 'chui-ide-profile';

/** Версия формата. Читаем только свою: чужой файл — ошибка, а не половина настроек. */
export const PROFILE_VERSION = 1;

export interface ProfileFile {
  kind: typeof PROFILE_KIND;
  version: number;
  /** Когда снят профиль (ISO), для человека. */
  exportedAt: string;
  settings: Record<string, unknown>;
}

/** Группы настроек, которые принадлежат человеку. Корень = ключ в `Settings`. */
const PROFILE_SECTIONS = [
  'editor',
  'appearance',
  'layout',
  'ai',
  'terminal',
  'explorer',
  'search',
  'format',
  'python',
  'lsp',
  'keybindings',
] as const;

/** Ключи `Settings`, которые точно не про человека, а про эту машину. */
const MACHINE_KEYS = new Set(['recent', 'roots', 'remoteRoots', 'activeRoot', 'workspace', 'update']);

/**
 * Снимок профиля из полных настроек.
 *
 * Неизвестные ключи не копируются: профиль с чужой машины не должен
 * приносить с собой то, чего эта версия приложения не знает.
 */
export function buildProfile(settings: Record<string, unknown>, now = new Date()): ProfileFile {
  const out: Record<string, unknown> = {};
  for (const section of PROFILE_SECTIONS) {
    const value = settings[section];
    if (value !== undefined) out[section] = value;
  }
  return {
    kind: PROFILE_KIND,
    version: PROFILE_VERSION,
    exportedAt: now.toISOString(),
    settings: out,
  };
}

/** Итог импорта: либо что именно применили, либо почему файл не подошёл. */
export interface ProfileImport {
  ok: boolean;
  patch?: Record<string, unknown>;
  applied?: readonly string[];
  error?: string;
}

/**
 * Разбор файла профиля и подготовка правки — одним вызовом.
 *
 * Отдельно от записи, чтобы вызывающий мог спросить человека прежде, чем менять:
 * сам разбор ничего не пишет и ничего не меняет.
 */
export function parseProfile(raw: unknown): ProfileImport {
  const value = typeof raw === 'string' ? parseJson(raw) : raw;
  if (typeof value !== 'object' || value === null) {
    return { ok: false, error: 'Это не файл профиля' };
  }
  const fields = value as Record<string, unknown>;
  if (fields.kind !== PROFILE_KIND) return { ok: false, error: 'Это не файл профиля' };
  if (typeof fields.version !== 'number' || fields.version > PROFILE_VERSION) {
    return { ok: false, error: 'Профиль из более новой версии — обновите приложение' };
  }
  const settings = fields.settings;
  if (typeof settings !== 'object' || settings === null) {
    return { ok: false, error: 'В профиле нет настроек' };
  }
  const profile: ProfileFile = {
    kind: PROFILE_KIND,
    version: fields.version,
    exportedAt: typeof fields.exportedAt === 'string' ? fields.exportedAt : '',
    settings: settings as Record<string, unknown>,
  };
  const patch = profilePatch(profile);
  return { ok: true, patch, applied: Object.keys(patch) };
}

/** JSON с диска приходит строкой; битый файл — та же ошибка, что и чужой. */
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

/**
 * Что из профиля применяем. Машинные ключи отбрасываются даже если они есть
 * в файле: профиль, приехавший с другой машины, не должен переписывать
 * список проектов и адреса корней.
 */
export function profilePatch(profile: ProfileFile): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(profile.settings)) {
    if (key === 'workspace' || MACHINE_KEYS.has(key)) continue;
    if (!(PROFILE_SECTIONS as readonly string[]).includes(key)) continue;
    out[key] = value;
  }
  return out;
}

/**
 * Проверка новой версии на GitHub: какая выпущена последней и есть ли файл под
 * нашу платформу.
 *
 * Сеть может отсутствовать, репозиторий может быть недоступен — это не ошибка
 * приложения, а его обычное состояние без интернета. Поэтому любая неудача
 * сводится к `null`: экран просто ничего не покажет.
 */
import { netFetch } from '../net/proxy';
import type { ReleaseAsset } from '../../shared/update';

export interface LatestRelease {
  /** Версия без ведущей `v`: её сравнивает `compareVersions`. */
  version: string;
  /** Страница релиза — куда вести человека, если под его платформу файла нет. */
  pageUrl: string;
  assets: ReleaseAsset[];
}

const RELEASE_REPO = 'Saintdizen/chui_ide_site';

/**
 * Расширения по платформам в том порядке, в каком их стоит предпочитать.
 *
 * На Windows установщик один, а на macOS сборка может быть и `zip`, и `dmg`:
 * первый удобнее человеку (распаковал — запустил), второй привычнее системе.
 * На Linux `AppImage` не требует прав root, а `deb` требует — поэтому выше.
 */
const EXTENSIONS: Record<string, string[]> = {
  win32: ['exe'],
  darwin: ['dmg', 'zip'],
  linux: ['AppImage', 'deb', 'tar.gz'],
};

/** Раз в сутки: релизы не выходят каждый час, а запрос на каждом старте — лишний. */
const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * Пора ли снова сходить на GitHub.
 *
 * Отсев живёт здесь, а не в IPC-методе: чистая функция без Electron — её можно
 * протестировать и её нельзя забыть при следующем рефакторинге обработчика.
 * Битая или небывалая отметка считается «пора»: застрять на сутки после
 * сбоя хуже, чем лишний запрос.
 */
export function isCheckDue(lastIso: string | undefined, now: number, intervalMs = UPDATE_CHECK_INTERVAL_MS): boolean {
  if (!lastIso) return true;
  const last = Date.parse(lastIso);
  if (!Number.isFinite(last)) return true;
  const elapsed = now - last;
  // Часы могли перевести назад — отрицательный срок тоже «пора».
  return elapsed >= intervalMs || elapsed < 0;
}

/**
 * Как архитектура называется в имени файла. `process.arch` даёт `x64`, а
 * electron-builder на Linux пишет `amd64`, на macOS и Windows — `arm64`/`x64`:
 * без таблицы `linux-amd64.deb` под `x64` не опознаётся, и на ровном месте
 * остаётся без установщика.
 */
const ARCH_ALIASES: Record<string, string[]> = {
  x64: ['x64', 'x86_64', 'amd64'],
  arm64: ['arm64', 'aarch64'],
  ia32: ['ia32', 'i386', 'x86'],
};

/** Архитектура ищется целым сегментом имени: `x64` не должен находиться в `x86_64` по подстроке. */
function hasArch(name: string, arch: string): boolean {
  const aliases = ARCH_ALIASES[arch] ?? [arch];
  const segments = name.split(/[-_.]/);
  return segments.some((segment) => aliases.includes(segment));
}

/** Любая известная архитектура в имени — чтобы отличить универсальную сборку от чужой. */
const ALL_ARCH_TOKENS = Object.values(ARCH_ALIASES).flat();

function hasAnyArch(name: string): boolean {
  const segments = name.split(/[-_.]/);
  return segments.some((segment) => ALL_ARCH_TOKENS.includes(segment));
}

interface GithubAsset {
  name?: unknown;
  browser_download_url?: unknown;
  size?: unknown;
}

interface GithubRelease {
  tag_name?: unknown;
  html_url?: unknown;
  assets?: unknown;
}

function readAssets(raw: unknown): ReleaseAsset[] {
  if (!Array.isArray(raw)) return [];
  const assets: ReleaseAsset[] = [];
  for (const entry of raw as GithubAsset[]) {
    if (typeof entry?.name !== 'string' || typeof entry.browser_download_url !== 'string') continue;
    assets.push({
      name: entry.name,
      url: entry.browser_download_url,
      size: typeof entry.size === 'number' ? entry.size : 0,
    });
  }
  return assets;
}

/**
 * Файл под текущую платформу и архитектуру.
 *
 * Имена собирает `.github/workflows/release.yml` как `<name>-<version>-<arch>.<ext>`,
 * поэтому архитектура ищется куском в имени. Универсальная сборка macOS
 * (`arm64`/`x64` не указаны) подходит обеим — её тоже берём, но после точной.
 */
export function pickAsset(assets: ReleaseAsset[], platform: string, arch: string): ReleaseAsset | null {
  const extensions = EXTENSIONS[platform];
  if (!extensions) return null;

  // Проход по расширениям во внешнем цикле: приоритет расширения важнее
  // точности архитектуры — иначе `deb` для arm64 перебил бы `AppImage`.
  for (const extension of extensions) {
    const candidates = assets.filter((asset) => asset.name.endsWith(`.${extension}`));
    const exact = candidates.find((asset) => hasArch(asset.name, arch));
    if (exact) return exact;
    // Универсальная сборка — та, в имени которой нет НИ ОДНОЙ архитектуры.
    // Проверять только `arm64`/`x64` мало: `mac-amd64.dmg` прошёл бы как
    // универсальный и подсунул Intel-сборку на Apple Silicon.
    const universal = candidates.find((asset) => !hasAnyArch(asset.name));
    if (universal) return universal;
  }
  return null;
}

/**
 * Последний выпуск с GitHub. `null` — если узнать не вышло.
 *
 * Таймаут обязателен: без него запрос без ответа висел бы до закрытия окна,
 * а проверка версии — дело необязательное.
 */
export async function fetchLatestRelease(): Promise<LatestRelease | null> {
  try {
    const response = await netFetch(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'chui-ide-update-check',
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) return null;
    const release = (await response.json()) as GithubRelease;
    if (typeof release.tag_name !== 'string') return null;
    return {
      version: release.tag_name.replace(/^v/, ''),
      pageUrl: typeof release.html_url === 'string' ? release.html_url : `https://github.com/${RELEASE_REPO}/releases`,
      assets: readAssets(release.assets),
    };
  } catch {
    // Нет сети, прокси отказал, ответ не JSON — для человека всё одно: версии не знаем.
    return null;
  }
}

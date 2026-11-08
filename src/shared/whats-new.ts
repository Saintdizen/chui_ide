/**
 * Экран «что нового»: разбор CHANGELOG.md и отбор того, что человек ещё не видел.
 *
 * Зачем разбирать файл, а не держать заметки в коде: записи о выпуске пишет тот,
 * кто выпускает, и пишет их рядом с версией в `package.json`. Второй источник
 * (константа в TypeScript) разъезжается с первым, и экран начинает врать.
 *
 * Формат — заголовок `## <версия>` и список под ним; всё остальное — текст,
 * которым можно пренебречь. Разбор терпим к мусору: кривая строка не должна
 * ломать обновление, она просто не попадёт в список.
 */

export interface ReleaseNote {
  /** Версия как она написана в CHANGELOG, без нормализации. */
  version: string;
  /** Строки списка; уже без маркеров. */
  items: string[];
}

/** Заголовок выпуска: `## 0.3.68` (допускаем и `## v0.3.68`, и хвост после пробела). */
const RELEASE_HEADING = /^##\s+v?(\d+(?:\.\d+)*)\b/;
/** Строка списка: `- ...`, `* ...`, `1. ...` */
const LIST_ITEM = /^\s*[-*+]\s+(.*\S)\s*$/;

export function parseChangelog(text: string): ReleaseNote[] {
  const releases: ReleaseNote[] = [];
  let current: ReleaseNote | null = null;

  for (const raw of text.split(/\r?\n/)) {
    const heading = RELEASE_HEADING.exec(raw);
    if (heading) {
      current = { version: heading[1]!, items: [] };
      releases.push(current);
      continue;
    }
    if (raw.startsWith('## ')) {
      // Другой заголовок второго уровня — не выпуск; список после него не наш.
      current = null;
      continue;
    }
    if (!current) continue;
    const item = LIST_ITEM.exec(raw);
    if (item) current.items.push(item[1]!);
  }

  return releases.filter((release) => release.items.length > 0);
}

/**
 * Сравнение версий по числам, а не строками: «0.3.10» новее «0.3.9», хотя как
 * строка оно меньше. Хвост (суффикс предвыпуска) отбрасывается: сравниваем то,
 * что человек видит в `app.info`.
 */
export function compareVersions(a: string, b: string): number {
  const left = a.split(/[.+-]/).map((part) => Number.parseInt(part, 10));
  const right = b.split(/[.+-]/).map((part) => Number.parseInt(part, 10));
  const length = Math.max(left.length, right.length);
  for (let i = 0; i < length; i += 1) {
    const x = Number.isFinite(left[i]) ? left[i]! : 0;
    const y = Number.isFinite(right[i]) ? right[i]! : 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

/**
 * Что показать окном. Пусто — показывать нечего:
 *  • записи только о версиях новее текущей — не врём о будущем;
 *  • уже увидено (`seen` совпадает с текущей) — второй раз не мешаем;
 *  • первый запуск (`seen` пуст) — всё новое, рассказывать не о чем.
 */
export function unseenReleases(
  releases: readonly ReleaseNote[],
  current: string,
  seen: string | null | undefined,
): ReleaseNote[] {
  if (!seen) return [];
  if (compareVersions(seen, current) >= 0) return [];
  return releases
    .filter((release) => compareVersions(release.version, seen) > 0 && compareVersions(release.version, current) <= 0)
    .sort((a, b) => compareVersions(b.version, a.version));
}

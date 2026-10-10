/**
 * Карта проекта человеческим текстом: как рассказать о проекте, не читая файлов.
 *
 * На вход — сводка `ProjectScan` (что за проект, сколько файлов, где тесты), на
 * выход — две формы одного и того же: короткая строка для системного промпта и
 * подробный ответ инструмента `project_map`. Модуль чистый: ни диска, ни
 * Electron, поэтому проверяется юнит-тестами.
 *
 * Смысл — сэкономить агенту первые шаги: устройство проекта он видит сразу и не
 * тратит вызовы на обход дерева и чтение манифестов. Содержимое файлов при этом
 * не читается вообще: карта собрана по именам, и это прямо сказано в тексте,
 * чтобы модель не приняла сводку за прочитанный код.
 */

import type { ProjectScan } from './project-scan';

/** Пределы выдачи: карта — ориентир, а не перепись. Остальное — числом. */
const MAX_LANGUAGES = 6;
const MAX_DIRS = 14;
const MAX_TEST_FILES = 5;
const MAX_ENTRY_POINTS = 6;

/**
 * Как назвать проект: «Node.js (package.json)» — вид и манифест, по которому узнали.
 * Если вид уже назван по манифесту («Python (pyproject)»), файл не дописываем:
 * «Python (pyproject) (pyproject.toml)» — это уже мусор в промпте.
 */
export function projectTitle(scan: ProjectScan): string {
  const file = scan.kind.file;
  if (!file) return scan.kind.label;
  const stem = file.split('.')[0] ?? file;
  return scan.kind.label.toLowerCase().includes(stem.toLowerCase()) ? scan.kind.label : `${scan.kind.label} (${file})`;
}

/** Языки одной строкой: `TypeScript 380, JSON 12`. Хвост — числом. */
function languagesText(scan: ProjectScan): string {
  if (scan.languages.length === 0) return 'нет распознанных файлов';
  const shown = scan.languages.slice(0, MAX_LANGUAGES).map((item) => `${item.label} ${item.files}`);
  const rest = scan.languages.length - shown.length;
  return rest > 0 ? `${shown.join(', ')}, ещё ${rest}` : shown.join(', ');
}

/** Список путей строкой с пределом: `tests, src` — и сколько не влезло. */
function pathsText(paths: readonly string[], limit: number): string {
  if (paths.length === 0) return '—';
  const shown = paths.slice(0, limit);
  const rest = paths.length - shown.length;
  return rest > 0 ? `${shown.join(', ')}, ещё ${rest}` : shown.join(', ');
}

/** Согласование числа с существительным: «1 файл», «2 файла», «5 файлов». */
function files(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return `${count} файл`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${count} файла`;
  return `${count} файлов`;
}

/** «в 1 каталоге», «в 5 каталогах» — предложный падеж, он же нужен в тексте карты. */
function inDirs(count: number): string {
  return count % 10 === 1 && count % 100 !== 11 ? `в ${count} каталоге` : `в ${count} каталогах`;
}

/** Строки карты без заголовка — их и склеивают обе формы. */
function mapLines(scan: ProjectScan): string[] {
  const lines = [
    `Проект: ${projectTitle(scan)} — ${files(scan.fileCount)} ${inDirs(scan.dirCount)}`,
    `Языки: ${languagesText(scan)}`,
    `Каталоги: ${pathsText(scan.topDirs, MAX_DIRS)}`,
  ];

  lines.push(
    scan.testFiles.length === 0
      ? 'Тесты: не найдены'
      : `Тесты: ${files(scan.testFiles.length)}${scan.testDirs.length > 0 ? `, каталоги ${pathsText(scan.testDirs, MAX_DIRS)}` : ''}`,
  );

  if (scan.entryPoints.length > 0) {
    lines.push(`Точки входа: ${pathsText(scan.entryPoints, MAX_ENTRY_POINTS)}`);
  }

  return lines;
}

/**
 * Короткая карта для системного промпта: устройство проекта, которое агент видит сразу,
 * не потратив ни одного вызова. Коротко настолько, чтобы её можно было класть
 * в каждый запрос: без примеров файлов и без перечисления языков целиком.
 */
export function formatShortMap(scan: ProjectScan): string {
  return ['Карта проекта (по именам файлов, содержимое не читалось):', ...mapLines(scan)].join('\n');
}

/**
 * Ответ инструмента `project_map`: то же плюс то, что агенту важно знать перед
 * работой, — манифесты, примеры тестов и куда смотреть дальше. Примеры путей
 * нужны, чтобы модель не угадывала, где лежат тесты, а сразу шла по адресу.
 */
export function formatProjectMap(scan: ProjectScan): { summary: string; detail: string } {
  const lines = mapLines(scan);

  if (scan.markers.length > 0) {
    lines.push(`Манифесты: ${scan.markers.map((marker) => marker.file).join(', ')}`);
  }
  if (scan.testFiles.length > 0) {
    lines.push(`Тесты, примеры: ${pathsText(scan.testFiles, MAX_TEST_FILES)}`);
  }

  lines.push(
    '',
    'Дальше: find_files — какие файлы есть (по маске), list_dir — что в каталоге, ' +
      'codebase_search — где объявлено имя. Содержимое читай точечно: read_file с startLine/endLine.',
  );

  const summary =
    `${scan.kind.label} · ${files(scan.fileCount)} ${inDirs(scan.dirCount)}` +
    `${scan.testFiles.length > 0 ? `, тестов ${scan.testFiles.length}` : ''}`;

  return { summary, detail: lines.join('\n') };
}

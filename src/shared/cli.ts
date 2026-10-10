/**
 * Папка проекта из командной строки.
 *
 * Запуск `chui_iDE ~/projects/api` должен открывать проект, а не стартовое окно.
 * Разобрать это проще, чем кажется, но есть три подвоха: Electron кладёт в
 * `argv` свои переключатели (`--no-sandbox`, `--user-data-dir=…`), путь к самому
 * приложению (`electron .` в разработке) и путь к исполняемому файлу. Ничто из
 * этого папкой проекта не является.
 *
 * Поэтому разбор вынесен сюда чистым правилом: файловая система и разрешение
 * путей приходят снаружи (`isDirectory`, `resolve`), а тест обходится без диска.
 */

export interface CommandLineInput {
  /** Аргументы после имени исполняемого файла. */
  args: readonly string[];
  /** Привести к абсолютному пути: рабочий каталог процесса не всегда тот, откуда запускали. */
  resolve: (value: string) => string;
  /** Что папкой проекта не считается: путь самого приложения. */
  ignore?: readonly string[];
  /** Существует ли путь и является ли он папкой. */
  isDirectory: (candidate: string) => boolean;
  /**
   * Сравнивать пути без учёта регистра. Приходит снаружи, а не берётся из
   * `process.platform`: этот модуль попадает и в renderer, где `process` нет.
   */
  caseInsensitive?: boolean;
}

/**
 * Ключ сравнения путей: разделители к одному виду, хвостовой слэш и `.` убраны,
 * регистр — как у системы. Без этого `.` и `/cwd`, а также `/cwd/` и `/cwd`
 * считались бы разными путями, и путь приложения не попал бы в исключения.
 */
function sameKey(value: string, caseInsensitive: boolean): string {
  const slashed = value
    .replace(/\\/g, '/')
    .replace(/(^|\/)\.\/?$/, '$1')
    .replace(/\/+$/, '');
  return caseInsensitive ? slashed.toLowerCase() : slashed;
}

export interface CommandLineFolder {
  /** Первая существующая папка среди аргументов; `null` — в аргументах её нет. */
  folder: string | null;
  /**
   * Аргументы, которые похожи на путь к проекту, но папкой не оказались.
   * Их называем в консоли: иначе запуск `chui_iDE ~/prоект` (опечатка) молча
   * открывал бы стартовое окно, и человек не понял бы, почему папка не открылась.
   */
  unusable: string[];
}

/**
 * Папка проекта из аргументов командной строки.
 *
 * Путь может быть не только первым аргументом: переключатели Chromium стоят
 * перед ним (`--no-sandbox ~/proj`), поэтому перебираем все аргументы, а не
 * смотрим только в первый.
 */
export function folderFromCommandLine(input: CommandLineInput): CommandLineFolder {
  const caseInsensitive = input.caseInsensitive === true;
  const ignored = new Set((input.ignore ?? []).map((value) => sameKey(input.resolve(value), caseInsensitive)));

  let folder: string | null = null;
  const unusable: string[] = [];
  for (const raw of input.args) {
    const argument = raw.trim();
    if (argument === '' || argument.startsWith('-')) continue;

    const resolved = input.resolve(argument);
    if (ignored.has(sameKey(resolved, caseInsensitive))) continue;
    if (input.isDirectory(resolved)) {
      folder ??= resolved;
      continue;
    }
    // Не папка. Переключатели Chromium все начинаются с `-` и отсеяны выше,
    // значит, остальное человек написал как путь — и о неудаче стоит сказать.
    unusable.push(resolved);
  }
  return { folder, unusable };
}

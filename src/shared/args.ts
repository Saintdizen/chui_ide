/**
 * Разбор строки аргументов командной строки.
 *
 * Нужно там, где аргументы вводят руками: в отладчике и запуске. Правило простое
 * и знакомое по оболочке — пробел разделяет, кавычки сохраняют, экранирование
 * внутри двойных кавычек работает. Полноценный shell-разбор тут не нужен: подстановок,
 * переменных и перенаправлений мы не делаем — это была бы команда, а не аргументы.
 */

/** Разобрать строку на аргументы, как это сделала бы оболочка. */
export function parseArguments(line: string): string[] {
  const args: string[] = [];
  let current = '';
  /** Аргумент начат: пустая строка в кавычках — тоже аргумент. */
  let started = false;
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index]!;

    if (quote === "'") {
      // В одинарных кавычках экранирования нет: оболочка берёт символы как есть.
      if (char === "'") quote = null;
      else current += char;
      continue;
    }

    if (quote === '"') {
      if (char === '\\' && index + 1 < line.length) {
        const next = line[index + 1]!;
        // Экранируется только то, что и в оболочке: кавычка, слэш и пробел.
        if (next === '"' || next === '\\' || next === ' ') {
          current += next;
          index += 1;
          continue;
        }
        current += char;
        continue;
      }
      if (char === '"') quote = null;
      else current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        args.push(current);
        current = '';
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }

  // Незакрытая кавычка — не ошибка: берём то, что успели набрать.
  if (started) args.push(current);
  return args;
}

/**
 * Собрать строку аргументов обратно — чтобы показать её в диалоге в привычном
 * виде. Кавычим только то, что без кавычек разобралось бы не так (пробелы,
 * кавычки, экранирование, пустой аргумент); остальное печатаем как есть, чтобы
 * строка выглядела естественно. Обратна `parseArguments`.
 */
export function formatArguments(args: readonly string[]): string {
  return args
    .map((arg) => (arg.length === 0 || /[\s"'\\]/.test(arg) ? `"${arg.replace(/(["\\])/g, '\\$1')}"` : arg))
    .join(' ');
}

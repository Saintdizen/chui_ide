/**
 * Что запустить вместо всего набора тестов.
 *
 * Прогон всего набора — это единственное, что умел `run_tests`, и на большом
 * проекте он стоит десятки тысяч строк вывода: агент правил одну функцию, а
 * получал отчёт на четыре тысячи тестов (и платил за него токенами). При этом
 * каждый раннер уже умеет гонять часть — надо только правильно позвать.
 *
 * Модуль чистый: правило «это путь или имя теста» и аргументы раннера. Сами
 * команды собирает main (`project/tests.ts`), где есть платформа и кавычки.
 */

/** Раннер, для которого собираются аргументы. */
export type TestRunnerKind = 'pytest' | 'vitest' | 'jest' | 'node';

/** Длина цели: дальше это уже не имя теста, а абзац из беседы. */
export const MAX_TEST_TARGET_CHARS = 300;

/**
 * Что не так с целью — или `null`. Проверка до запуска: цель приходит от модели,
 * а она охотно шлёт «весь файл целиком, пожалуйста» и переводы строк.
 */
export function testTargetProblem(target: string): string | null {
  const text = target.trim();
  if (!text) return 'Пустая цель: нужен путь к файлу тестов или имя теста.';
  if (text.length > MAX_TEST_TARGET_CHARS) {
    return `Цель длиннее ${MAX_TEST_TARGET_CHARS} символов — это уже не имя теста. Укажи файл или имя.`;
  }
  // Перевод строки в аргументе команды — попытка подмешать вторую команду.
  if (/[\r\n]/.test(text)) return 'Цель не должна содержать переводов строк.';
  return null;
}

/**
 * Похожа ли цель на путь, а не на имя теста. Признаки простые и намеренно
 * широкие: разделитель каталога или расширение файла. Ошибиться в эту сторону
 * дешевле — раннер поймёт позиционный аргумент и как фильтр по имени тоже.
 */
export function looksLikePath(target: string): boolean {
  const text = target.trim();
  if (/[/\\]/.test(text)) return true;
  return /\.(?:py|ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i.test(text);
}

/**
 * Аргументы раннера для запуска части тестов. Пустая цель — пустой список:
 * вызывающий запустит всё, как раньше.
 *
 * Путь передаётся позиционно (его понимают все четыре раннера). Имя — своим
 * ключом: `-k` у pytest (подстрока в имени), `-t` у vitest и jest (шаблон по
 * названию), `--test-name-pattern` у встроенного `node --test`.
 */
export function testTargetArgs(runner: TestRunnerKind, target?: string): string[] {
  const text = target?.trim();
  if (!text) return [];
  if (looksLikePath(text)) return [text];
  switch (runner) {
    case 'pytest':
      return ['-k', text];
    case 'vitest':
    case 'jest':
      return ['-t', text];
    case 'node':
      return ['--test-name-pattern', text];
    default:
      return [];
  }
}

/** Подпись для карточки вызова: «vitest · src/app.test.ts». */
export function testTargetLabel(label: string, target?: string): string {
  const text = target?.trim();
  return text ? `${label} · ${text}` : label;
}

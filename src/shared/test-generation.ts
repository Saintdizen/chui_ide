/**
 * Генерация теста к выделенному коду (AI): «напиши тест вот на это» — модели код, обратно — тест.
 *
 * Здесь только чистая часть: сборка промпта, очистка ответа и подбор пути для файла теста.
 * Запрос к провайдеру живёт в main, кнопка — в renderer, поэтому логика проверяется
 * тестами без сети и без окна.
 *
 * Почему не через чат: это короткая разовая задача — «к этому коду — тест», — и держать
 * для неё беседу с историей, инструментами и картой проекта незачем (так же устроены
 * inline-подсказка и сообщение коммита, `shared/inline-ai.ts`, `shared/commit-message.ts`).
 * Но и молча писать в проект нельзя: файл создаётся в предложенном месте, а результат
 * человек видит и правит как обычный код.
 */

/** Потолок кода, который отдаём модели: больше — дорого, а тест пишут по сути. */
export const TEST_CODE_MAX_CHARS = 6000;
/** Потолок ответа: файл теста — не роман, но и не одна строка. */
export const TEST_MAX_TOKENS = 1200;
/** Жёсткий предел длины ответа: защита от модели, которая не послушалась `maxTokens`. */
export const TEST_MAX_CHARS = 8000;

/**
 * Правило для модели. Главное — потребовать ТОЛЬКО код теста и подходящий фреймворк:
 * лишние пояснения и ограждения в файле теста не нужны, их пришлось бы стирать руками.
 */
export const TEST_SYSTEM_PROMPT = [
  'Ты пишешь модульный тест к фрагменту кода. Верни ТОЛЬКО код теста —',
  'без пояснений, без markdown-ограждений, без повторения исходного кода.',
  'Подбери тест-фреймворк по языку и тому, что уже уместно в проекте:',
  'для Python — pytest, для JavaScript/TypeScript — vitest (describe/it/expect).',
  'Тест должен быть самостоятельным: импортируй то, что нужно, и покрой поведение',
  'по существу — обычные случаи и хотя бы один крайний. Имена функций и классов',
  'бери из кода как есть, ничего не выдумывая. Если тест невозможен — верни пустой ответ.',
].join('\n');

export interface TestPromptParts {
  language: string;
  /** Путь исходного файла относительно корня проекта: модели полезен вид и место. */
  relativePath: string;
  /** Код, к которому просят тест (уже обрезанный по `TEST_CODE_MAX_CHARS`). */
  code: string;
  /** Предлагаемый путь файла теста: подсказывает модели имена и структуру импорта. */
  testPath: string;
}

/** Обрезать код до потолка, пометив обрезку: по метке видно, что картина неполная. */
export function truncateTestCode(
  code: string,
  maxChars: number = TEST_CODE_MAX_CHARS,
): { text: string; truncated: boolean } {
  const limit = Math.max(maxChars, 1);
  if (code.length <= limit) return { text: code, truncated: false };
  const cut = code.slice(0, limit);
  const at = cut.lastIndexOf('\n');
  const text = at > 0 ? cut.slice(0, at) : cut;
  return { text: `${text}\n… (код обрезан)`, truncated: true };
}

/** Промпт с кодом и местом будущего теста. */
export function buildTestPrompt(parts: TestPromptParts): string {
  const head = [
    `Язык: ${parts.language}`,
    `Исходный файл: ${parts.relativePath}`,
    `Файл теста: ${parts.testPath}`,
  ].join('\n');
  return `${head}\n\n\`\`\`${parts.language}\n${parts.code}\n\`\`\``;
}

/**
 * Очистить ответ модели: снять markdown-ограждение (модели любят его добавлять вопреки
 * просьбе). Пустые строки в начале и в конце убираем, начало кода не трогаем.
 */
export function cleanTestCode(raw: string): string {
  let text = raw.replace(/\r\n?/g, '\n');
  const fence = /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(text);
  if (fence) text = fence[1] ?? '';
  else {
    text = text.replace(/^\s*```[^\n]*\n/, '');
    text = text.replace(/\n?```\s*$/, '');
  }
  return text
    .replace(/^\n+/, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n+$/, '');
}

/** Пусто ли вышел тест после очистки (тогда создавать файл нечего). */
export function isEmptyTest(code: string): boolean {
  return code.trim().length === 0;
}

/**
 * Путь файла теста к исходному файлу — по принятому в проекте расположению.
 *
 * ПРАВИЛА простые и предсказуемые, без обхода дерева: имя сборки сохраняем, суффикс
 * `.test`/`test_` по языку, папку `tests` в корне предпочитаем (там тесты и держат).
 * Если исходник уже лежит в тестовой папке или сам похож на тест — возвращаем `null`:
 * писать тест к тесту нечего.
 */
export function suggestTestPath(relativePath: string): string | null {
  const path = relativePath.replace(/\\/g, '/');
  const parts = path.split('/');
  const name = parts[parts.length - 1] ?? '';
  if (!name) return null;

  const lower = name.toLowerCase();
  // Тестом считаем по ИМЕНИ, а не по папке: файл в `tests/` вполне может быть
  // вспомогательным, и тест к нему бывает нужен. А вот `foo.test.ts` — уже тест.
  const isTest = lower.includes('.test.') || lower.includes('.spec.') || lower.startsWith('test_');
  if (isTest) return null;

  const dot = name.lastIndexOf('.');
  const stem = dot <= 0 ? name : name.slice(0, dot);
  const ext = dot <= 0 ? '' : name.slice(dot);

  // Python зовут по-своему: `test_<имя>.py`.
  if (ext === '.py') {
    const dir = parts.slice(0, -1).join('/');
    return dir ? `${dir}/test_${stem}.py` : `test_${stem}.py`;
  }

  // JS/TS: `<имя>.test.<расш>` — рядом с исходником или в корневой `tests/`.
  const dir = parts.slice(0, -1).join('/');
  const testDir = dir.startsWith('tests') ? dir : 'tests';
  return `${testDir}/${stem}.test${ext}`;
}

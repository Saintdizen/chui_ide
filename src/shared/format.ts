/**
 * Кто форматирует файл: питоновские инструменты окружения или node-инструменты проекта.
 *
 * Здесь только решения, о которых договариваются renderer и main: какому движку
 * отдать файл этого языка и в каком порядке пробовать инструменты. Оба ответа
 * нужны сразу на двух сторонах, а ошибиться в них легко — поэтому они лежат в
 * одном месте и под тестом, а не размазаны по вызовам.
 *
 * Запуск самих инструментов — дело main: там процессы и файловая система.
 */

/** Движок форматирования: питоновский (`ruff`, `black`) или из `node_modules` проекта. */
export type FormatEngine = 'python' | 'node';

/** Инструмент форматирования Node-проекта. */
export type NodeFormatTool = 'prettier' | 'biome';

/**
 * Языки, которые форматируют prettier и biome: JS/TS и всё, что обычно лежит
 * рядом с ними. Незнакомый инструменту язык он сам отвергнет — это не ошибка.
 */
const NODE_LANGUAGES: readonly string[] = [
  'typescript',
  'javascript',
  'json',
  'html',
  'css',
  'scss',
  'less',
  'markdown',
  'yaml',
];

/**
 * Чем форматировать файл этого языка; null — форматировать нечем.
 *
 * Python — отдельный движок: его инструменты живут в интерпретаторе проекта, а не
 * в `node_modules`, и спрашивать за них надо у main другое.
 */
export function formatEngine(languageId: string): FormatEngine | null {
  if (languageId === 'python') return 'python';
  return NODE_LANGUAGES.includes(languageId) ? 'node' : null;
}

/** Инструменты движка, как их назвать человеку: для подсказки «нечем форматировать». */
export function formatToolNames(engine: FormatEngine): readonly string[] {
  return engine === 'python' ? ['ruff', 'black'] : ['prettier', 'biome'];
}

/** Обычный порядок: prettier — самый распространённый, biome — современная замена. */
const DEFAULT_ORDER: readonly NodeFormatTool[] = ['prettier', 'biome'];

/** Пакет в `node_modules`, в котором лежит инструмент. */
export function nodeFormatPackage(tool: NodeFormatTool): string {
  return tool === 'prettier' ? 'prettier' : '@biomejs/biome';
}

/**
 * Инструменты Node-проекта в порядке попыток.
 *
 * Объявленный в `package.json` идёт первым: проект уже выбрал, чем форматируется,
 * и спорить с ним нечем — настройки лежат в его конфиге. Если не объявлен ни один,
 * порядок обычный: второй инструмент подхватится, если он просто установлен.
 */
export function nodeFormatOrder(declaredDependencies: readonly string[]): readonly NodeFormatTool[] {
  const declared = new Set(declaredDependencies);
  const preferred = DEFAULT_ORDER.filter((tool) => declared.has(nodeFormatPackage(tool)));
  const rest = DEFAULT_ORDER.filter((tool) => !declared.has(nodeFormatPackage(tool)));
  return [...preferred, ...rest];
}

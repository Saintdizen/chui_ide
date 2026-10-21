import type { Grammar } from './grammar';

/**
 * Реестр грамматик — по требованию, для тех, кто подсвечивает текст асинхронно.
 *
 * Реестр тянет за собой все 34 языка (десятки КБ). В чате это заметно: блок кода —
 * не главное в ленте, а язык в нём известен только тогда, когда блок приехал. Поэтому
 * `core/highlight.ts` грузит реестр `import()`-ом, а не статическим импортом.
 *
 * Редактору ждать нечего — но `registry.ts` статически импортируют `diff-editor`,
 * `peek-widget` и others, и один статический импорт отменяет ленивость для всех:
 * сборщик не может вынести модуль в отдельный чанк, если его уже тянут синхронно.
 * Отсюда — этот путь: `import()` с кешем, чтобы чат и редактор шли одной дорогой.
 *
 * Кеш держит обещание, а не результат: два блока кода одного языка ждут один и тот
 * же `import()`, а не запускают второй.
 */
let loading: Promise<typeof import('./registry')> | null = null;

/** Загрузить реестр (один раз на всё приложение). */
export function loadRegistry(): Promise<typeof import('./registry')> {
  loading ??= import('./registry');
  return loading;
}

/** Грамматика языка по требованию: `null`, если подсветки для языка нет. */
export async function languageGrammar(languageId: string): Promise<Grammar | null> {
  const registry = await loadRegistry();
  return registry.grammarFor(languageId);
}

/**
 * Путь или имя с пробелами ломает команду в терминале: оборачиваем в кавычки.
 *
 * Живёт в `shared`, потому что нужен обоим концам: renderer собирает команды
 * запуска, а разбор `tasks.json` — тоже shared, и от renderer он зависеть не может.
 */
export function shellQuote(value: string): string {
  if (!/[^A-Za-z0-9_./:@%+-]/.test(value)) return value;
  if (value.includes("'")) return `"${value.replace(/"/g, '\\"')}"`;
  return `'${value}'`;
}

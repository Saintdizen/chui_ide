import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Стража контракта RPC.
 *
 * `ChuiMethods` (`shared/api.ts`) — единственное описание обмена main ↔ renderer.
 * Имя метода известно типам, но обработчик в main появляется только по вызову
 * `router.register`. Забыть регистрацию сборка не заметит: вызов уйдёт в main и
 * вернётся «Неизвестный метод» уже в рантайме. Поэтому полноту сверяет этот тест —
 * он читает оба файла текстом, без Electron.
 *
 * Проверка в ОБЕ стороны: и объявленный без обработчика, и зарегистрированный без
 * объявления — ошибка. Первое — забыли зарегистрировать; второе — переименовали в
 * контракте, но не в main (или наоборот), и метод стал недостижим из renderer'а.
 */

const read = (relative: string): string => readFileSync(resolve(process.cwd(), relative), 'utf8');

/** Имена методов, объявленных в интерфейсе `ChuiMethods`. */
function contractMethods(): string[] {
  const source = read('src/shared/api.ts');
  const start = source.indexOf('export interface ChuiMethods');
  expect(start, 'в shared/api.ts нет интерфейса ChuiMethods').toBeGreaterThanOrEqual(0);
  // Интерфейс закрывается строкой `}` без отступа — вложенные объектные типы
  // закрываются с отступом, поэтому первый `\n}` и есть конец ChuiMethods.
  const end = source.indexOf('\n}', start);
  const body = source.slice(start, end);
  return [...body.matchAll(/^\s*'([a-z]+(?:\.[A-Za-z0-9]+)+)'\s*:/gm)].map((match) => match[1]!);
}

/** Имена методов, зарегистрированных роутером в main. */
function registeredMethods(): string[] {
  const source = read('src/main/ipc/register.ts');
  return [...source.matchAll(/router\.register\(\s*(['"`])([a-z]+(?:\.[A-Za-z0-9]+)+)\1/g)].map((match) => match[2]!);
}

describe('контракт RPC: ChuiMethods ↔ регистрация в main', () => {
  it('разбор находит методы (иначе тест проверял бы пустоту)', () => {
    expect(contractMethods().length).toBeGreaterThan(100);
    expect(registeredMethods().length).toBeGreaterThan(100);
  });

  it('каждый объявленный метод зарегистрирован в main', () => {
    const registered = new Set(registeredMethods());
    const missing = contractMethods().filter((method) => !registered.has(method));
    expect(missing, `нет router.register для: ${missing.join(', ')}`).toEqual([]);
  });

  it('нет регистраций методов, которых нет в контракте', () => {
    const declared = new Set(contractMethods());
    const extra = registeredMethods().filter((method) => !declared.has(method));
    expect(extra, `зарегистрированы, но не объявлены: ${extra.join(', ')}`).toEqual([]);
  });

  it('контракт не содержит повторов', () => {
    const methods = contractMethods();
    const seen = new Set<string>();
    const duplicates = methods.filter((method) => (seen.has(method) ? true : (seen.add(method), false)));
    expect(duplicates, `повторяются: ${duplicates.join(', ')}`).toEqual([]);
  });
});

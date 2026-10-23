import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Дескриптор команды — объектный литерал с `id: 'a.b'`. Разбираем его целиком,
 * а не окном в N символов: в первом заходе окно в 400 знаков приписывало
 * `search.meaning` чужое сочетание клавиш от соседа, и три «дубля» из семи
 * оказались выдуманными. Здесь — литерал от `{` до парной `}`.
 */
// Только `fileURLToPath`: у `URL.pathname` остаются лишние `%20` в путях с пробелами
// и вид `/D:/…` на Windows — `readdirSync` такого адреса не знает.
const ROOT = fileURLToPath(new URL('../src/renderer', import.meta.url));

interface Descriptor {
  id: string;
  keybinding?: string;
  where: string;
}

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return files(path);
    return entry.name.endsWith('.ts') ? [path] : [];
  });
}

function descriptors(text: string, where: string): Descriptor[] {
  const found: Descriptor[] = [];
  for (const match of text.matchAll(/\{[^{}]*?\bid: '([a-z][a-zA-Z0-9]*\.[a-zA-Z0-9_.]+)'[^{}]*?\}/g)) {
    const body = match[0];
    const key = /keybinding: '([^']+)'/.exec(body);
    found.push({ id: match[1]!, ...(key ? { keybinding: key[1]! } : {}), where });
  }
  return found;
}

const texts = files(ROOT).map((file) => ({ where: file.slice(ROOT.length + 1), text: readFileSync(file, 'utf8') }));

/**
 * `app.ts` — сборка окна. Всё, что из него вынесено, живёт в `core/*`; после перевода
 * вызова на модуль объявления в сборке быть не должно. Исключений нет: `path-commands`
 * подключён, и единственная команда, оставшаяся в сборке, — `project.close` (он закрывает
 * окно, а не путь), в `core/*` её нет — значит это не копия, а само определение.
 *
 * Раньше здесь стояло послабление: объявление в `app.ts` прощалось, если такое же
 * есть в `core/*`. Оно было нужно на время переезда и стало пустым, когда переезд
 * кончился — убрано, чтобы тест ловил переписанную копию сразу.
 */
const all = texts.flatMap(({ where, text }) => descriptors(text, where));

describe('дескрипторы команд', () => {
  it('находятся: их больше двухсот', () => {
    expect(all.length).toBeGreaterThan(200);
  });

  it('один id — один дескриптор', () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const descriptor of all) {
      const first = seen.get(descriptor.id);
      if (first) duplicates.push(`${descriptor.id}: ${first} и ${descriptor.where}`);
      else seen.set(descriptor.id, descriptor.where);
    }
    expect(duplicates).toEqual([]);
  });

  it('одно сочетание клавиш — одна команда', () => {
    const seen = new Map<string, string>();
    const duplicates: string[] = [];
    for (const { id, keybinding, where } of all) {
      if (!keybinding) continue;
      const first = seen.get(keybinding);
      if (first) duplicates.push(`${keybinding}: ${first} и ${id} (${where})`);
      else seen.set(keybinding, `${id} (${where})`);
    }
    expect(duplicates).toEqual([]);
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Дескриптор команды — объектный литерал с `id: 'a.b'`. Разбираем его целиком,
 * а не окном в N символов: в первом заходе окно в 400 знаков приписывало
 * `search.meaning` чужое сочетание клавиш от соседа, и три «дубля» из семи
 * оказались выдуманными. Здесь — литерал от `{` до парной `}`.
 */
const ROOT = new URL('../src/renderer', import.meta.url).pathname;

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

const all = files(ROOT).flatMap((file) => descriptors(readFileSync(file, 'utf8'), file.slice(ROOT.length + 1)));

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

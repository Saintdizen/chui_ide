import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalMessages,
  isFailure,
  loadCensus,
  readRangeOf,
  retryNames,
  searchHitCount,
} from '../scripts/census-data';

const dirs: string[] = [];
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chui-census-'));
  dirs.push(dir);
  fs.writeFileSync(
    path.join(dir, 'chat.json'),
    JSON.stringify({
      conversations: [
        {
          messages: [
            {
              role: 'assistant',
              toolCalls: [{ id: 'r', name: 'read_file', arguments: '{"path":"a.ts","startLine":5,"endLine":10}' }],
            },
            { role: 'tool', toolCallId: 'r', content: '5 | code' },
          ],
        },
      ],
    }),
  );
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('общая выборка переписей', () => {
  it('фиксирует хеши, исключает индексы и сообщает о повреждённых беседах', () => {
    const dir = fixture();
    fs.writeFileSync(path.join(dir, 'chat.index.json'), '{}');
    fs.writeFileSync(path.join(dir, 'broken.json'), '{');
    const manifest = path.join(dir, 'sample.manifest');
    const sample = loadCensus([dir, '--write-manifest', manifest]);
    expect(sample.calls).toBe(1);
    expect(sample.results).toBe(1);
    expect(sample.skipped).toEqual(['broken.json']);
    expect(loadCensus(['--manifest', manifest]).fingerprint).toBe(sample.fingerprint);
    fs.writeFileSync(path.join(dir, 'chat.json'), '{}');
    expect(() => loadCensus(['--manifest', manifest])).toThrow('Выборка изменилась');
  });

  it('канонизирует границы вместе с именем инструмента', () => {
    const sample = loadCensus([fixture()]);
    const call = sample.messages[0]![0]!.toolCalls![0]!;
    expect(call.name).toBe('read');
    expect(JSON.parse(call.arguments!)).toMatchObject({ startLine: 5, endLine: 10 });
    const history = canonicalMessages([{ toolCalls: [{ name: 'session_search', arguments: '{"query":"hello"}' }] }]);
    expect(history[0]!.toolCalls![0]!.name).toBe('history');
    expect(JSON.parse(history[0]!.toolCalls![0]!.arguments!)).toMatchObject({ action: 'sessions', query: 'hello' });
  });

  it('отсутствующий каталог даёт пустую выборку', () => {
    expect(loadCensus([path.join(fixture(), 'missing')]).calls).toBe(0);
  });
});

describe('повторы и поиск без ложных промахов', () => {
  it('дочитывание без конца не считается чтением целого файла', () => {
    expect(readRangeOf('{"startLine":"20"}')).toEqual({ from: 20, to: Infinity, whole: false });
    expect(readRangeOf('{}')).toEqual({ from: 1, to: Infinity, whole: true });
  });
  it('нормальная серия команд не считается переделкой, а повтор после отказа считается', () => {
    const messages = canonicalMessages([
      { role: 'assistant', toolCalls: [{ id: 'a', name: 'terminal', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'a', content: 'done' },
      { role: 'assistant', toolCalls: [{ id: 'b', name: 'terminal', arguments: '{}' }] },
      { role: 'tool', toolCallId: 'b', content: 'Ошибка: bad command' },
      { role: 'assistant', toolCalls: [{ id: 'c', name: 'terminal', arguments: '{}' }] },
    ]);
    expect(retryNames(messages, 0)).toEqual([]);
    expect(retryNames(messages, 2)).toEqual(['terminal']);
    expect(isFailure({ content: 'Ничего не найдено' })).toBe(false);
    expect(isFailure({ ok: true, content: 'код выхода 1 — пример из документации' })).toBe(false);
  });

  it('считает старые и новые строки совпадений, но не контекст', () => {
    expect(searchHitCount('src/a.ts\n  42: match\n43- context\n45: second\nother.ts:8: match')).toBe(3);
    expect(searchHitCount('Ничего не найдено')).toBe(0);
    expect(searchHitCount('43- example src/a.ts:10: context')).toBe(0);
  });
});

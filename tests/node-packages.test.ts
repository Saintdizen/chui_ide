import { describe, expect, it } from 'vitest';
import { missingPackages } from '../src/main/node/packages';

/**
 * Отсутствующие пакеты Node. Ключевое здесь — встроенные модули: их не бывает в
 * `node_modules`, и подчёркивать их нельзя. Запись бывает и `fs`, и `node:fs` —
 * обе означают одно и то же, и обе не должны попадать в список отсутствующих.
 */
describe('missingPackages', () => {
  it('встроенные модули не считаются отсутствующими ни в одной записи', async () => {
    expect(await missingPackages(null, ['fs', 'path', 'node:fs', 'node:path'])).toEqual([]);
  });

  it('без корня проекта любой внешний пакет считается отсутствующим', async () => {
    expect(await missingPackages(null, ['totally-missing'])).toEqual(['totally-missing']);
  });

  it('дубли имён схлопываются', async () => {
    expect(await missingPackages(null, ['react', 'react'])).toEqual(['react']);
  });
});

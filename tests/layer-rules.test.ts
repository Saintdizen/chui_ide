import { describe, expect, it } from 'vitest';
import { checkSharedImport } from '../src/shared/layer-rules';

/**
 * Правила сторожа границы `shared`.
 *
 * Сторож нужен, чтобы из общего слоя не тянулись electron и Node: он собирается и в
 * браузер, и в main, и ломается сборка слоя, который заметит это первым — обычно не
 * того, кто сломал.
 */
const CONTEXT = { deps: new Set(['electron', 'node-pty', 'vue']), sharedDir: '/repo/src/shared' };
const FILE = '/repo/src/shared/lsp/positions.ts';

function check(specifier: string, file = FILE): string | null {
  return checkSharedImport(file, specifier, CONTEXT);
}

describe('граница общего слоя', () => {
  it('свои файлы — можно', () => {
    expect(check('./edits')).toBeNull();
    expect(check('../use-only')).toBeNull();
    expect(check('../../shared/line-endings')).toBeNull();
  });

  it('соседние слои — нельзя', () => {
    expect(check('../../main/ai/service')).toContain('main или renderer');
    expect(check('../../../preload/index')).toContain('main или renderer');
    expect(check('../../renderer/app')).toContain('main или renderer');
  });

  it('выход под видом возврата в shared — можно', () => {
    // Файл на верхнем уровне: `../shared/x` возвращает внутрь.
    expect(check('../shared/lsp-status', '/repo/src/shared/api.ts')).toBeNull();
  });

  it('пути Windows с `\\` — та же граница', () => {
    // Регрессия: сторож резал путь по `'/'`, и на Windows любой `./x` из shared
    // выглядел выходом из слоя — 263 ложных срабатывания в CI.
    const win = { ...CONTEXT, sharedDir: 'C:\\repo\\src\\shared' };
    const winFile = 'C:\\repo\\src\\shared\\api\\ai.ts';
    expect(checkSharedImport(winFile, './settings', win)).toBeNull();
    expect(checkSharedImport(winFile, '../permissions', win)).toBeNull();
    expect(checkSharedImport(winFile, '../../main/ai/service', win)).toContain('main или renderer');
  });

  it('модуль Node — нельзя, с префиксом и без', () => {
    expect(check('node:fs')).toContain('модуль Node');
    expect(check('fs')).toContain('модуль Node');
    expect(check('path')).toContain('модуль Node');
    expect(check('node:path')).toContain('модуль Node');
  });

  it('пакет с похожим именем — не встроенный модуль', () => {
    // Иначе `path-type`, `events-to-async` и подобные ловились бы по префиксу.
    expect(check('path-type')).toBeNull();
    expect(check('fs-extra')).toBeNull();
  });

  it('пакет приложения — нельзя', () => {
    expect(check('electron')).toContain('пакет проекта');
    expect(check('node-pty')).toContain('пакет проекта');
    expect(check('vue')).toContain('пакет проекта');
  });

  it('субпуть пакета ловится по имени пакета', () => {
    expect(check('vue/dist/vue.esm-bundler.js')).toContain('пакет проекта');
  });

  it('сообщение говорит, что делать', () => {
    // Не только «нельзя», а куда девать: иначе сторож воспринимается как помеха.
    expect(check('node:crypto')).toContain('src/main');
    expect(check('../../main/x')).toContain('src/shared');
  });
});

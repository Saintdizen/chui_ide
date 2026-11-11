import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProjectConfigStore } from '../src/main/project-config';
import { DEFAULT_LAYOUT, sanitizeLayout } from '../src/shared/api/settings';

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'chui-layout-'));
}

describe('макет рабочей области проекта', () => {
  it('без файла макета проекта нет — действует общий', async () => {
    const root = await tempRoot();
    expect(await new ProjectConfigStore().loadLayout(root)).toBeNull();
  });

  it('сохранённый макет читается обратно и лежит в .chui_ide/layout.json', async () => {
    const root = await tempRoot();
    const store = new ProjectConfigStore();
    const layout = { ...DEFAULT_LAYOUT, sidebarSize: 321, sidebarPosition: 'right' as const };

    const saved = await store.saveLayout(root, layout);
    expect(saved.sidebarSize).toBe(321);

    const onDisk = JSON.parse(await fs.readFile(path.join(root, '.chui_ide', 'layout.json'), 'utf8'));
    expect(onDisk.sidebarSize).toBe(321);
    expect((await store.loadLayout(root))?.sidebarSize).toBe(321);
  });

  it('мусор в файле не ломает открытие проекта — подставляются умолчания', async () => {
    const root = await tempRoot();
    await fs.mkdir(path.join(root, '.chui_ide'), { recursive: true });
    await fs.writeFile(path.join(root, '.chui_ide', 'layout.json'), '{ это не json', 'utf8');

    expect(await new ProjectConfigStore().loadLayout(root)).toBeNull();
  });

  it('clearLayout возвращает проект к общему макету', async () => {
    const root = await tempRoot();
    const store = new ProjectConfigStore();
    await store.saveLayout(root, sanitizeLayout({ sidebarSize: 400 }));
    await store.clearLayout(root);

    expect(await store.loadLayout(root)).toBeNull();
    await expect(fs.readFile(path.join(root, '.chui_ide', 'layout.json'), 'utf8')).rejects.toThrow();
  });

  it('настройки проекта и макет — разные файлы и не мешают друг другу', async () => {
    const root = await tempRoot();
    const store = new ProjectConfigStore();
    await store.updateSettings(root, { editor: { tabSize: 2 } } as never);
    await store.saveLayout(root, sanitizeLayout({ dockSize: 260 }));

    const files = await fs.readdir(path.join(root, '.chui_ide'));
    expect(files.sort()).toEqual(['layout.json', 'settings.json']);
    expect((await store.loadLayout(root))?.dockSize).toBe(260);
  });
});

describe('sanitizeLayout: края настроек', () => {
  it('пустые настройки целиком дают умолчания', () => {
    // `value ?? {}` — ветка для проекта без сохранённого макета: без неё
    // чтение падало бы на `undefined.sidebarSize`.
    expect(sanitizeLayout(undefined)).toEqual(DEFAULT_LAYOUT);
  });

  it('поле со значением undefined заменяется умолчанием, а не стирается', () => {
    // JSON из старой версии может не знать поля; `?? ` возвращает умолчание
    // только при null/undefined — здесь и проверяется вторая половина.
    const layout = sanitizeLayout({ sidebarSize: undefined });
    expect(layout.sidebarSize).toBe(DEFAULT_LAYOUT.sidebarSize);
  });

  it('панель инструментов может стоять справа', () => {
    // `bottom/right` — равноправные значения; раньше проверялась только
    // `sidebarPosition`, а `dockPosition` оставался непроверенным.
    expect(sanitizeLayout({ dockPosition: 'right' }).dockPosition).toBe('right');
    // Файл настроек — JSON с диска, там может быть любая строка;
    // приведение в тесте — это и есть имитация такого ввода.
    const junk = { dockPosition: 'сбоку' as unknown as 'bottom' };
    expect(sanitizeLayout(junk).dockPosition).toBe('bottom');
  });

  it('правая сторона панели остаётся правой', () => {
    expect(sanitizeLayout({ sidebarPosition: 'right' }).sidebarPosition).toBe('right');
  });
});

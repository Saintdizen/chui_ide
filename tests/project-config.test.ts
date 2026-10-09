import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectConfigStore } from '../src/main/project-config';
import {
  applyProjectSettingsPatch,
  sanitizeProjectLayout,
  sanitizeProjectSettings,
} from '../src/shared/project-config';

describe('sanitizeProjectSettings', () => {
  it('оставляет только известные секции-объекты', () => {
    expect(
      sanitizeProjectSettings({
        editor: { tabSize: 2 },
        run: { command: 'x' },
        ai: { model: 'y' },
        appearance: 'nope',
        svn: { z: 1 },
      }),
    ).toEqual({ editor: { tabSize: 2 }, run: { command: 'x' } });
  });

  it('не-объект даёт пустые настройки', () => {
    expect(sanitizeProjectSettings(null)).toEqual({});
    expect(sanitizeProjectSettings('x')).toEqual({});
    expect(sanitizeProjectSettings([1, 2])).toEqual({});
  });
});

describe('sanitizeProjectLayout', () => {
  it('размеры — положительные числа, видимость — boolean', () => {
    expect(
      sanitizeProjectLayout({
        sidebarSize: 260.6,
        rightSize: 0,
        dockSize: -5,
        sidebarVisible: true,
        rightVisible: 'yes',
        dockVisible: false,
        junk: 3,
      }),
    ).toEqual({ sidebarSize: 261, sidebarVisible: true, dockVisible: false });
  });
});

describe('applyProjectSettingsPatch', () => {
  it('дополняет секции рекурсивно и не мутирует вход', () => {
    const current = { editor: { tabSize: 2, font: { size: 12 } } };
    const patch = { editor: { font: { size: 14 } } };
    const next = applyProjectSettingsPatch(current, patch);
    expect(next).toEqual({ editor: { tabSize: 2, font: { size: 14 } } });
    expect(current).toEqual({ editor: { tabSize: 2, font: { size: 12 } } });
  });
});

describe('ProjectConfigStore', () => {
  const dirs: string[] = [];

  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeRoot(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'chui-cfg-'));
    dirs.push(dir);
    return dir;
  }

  it('пустой проект даёт пустую конфигурацию', async () => {
    const store = new ProjectConfigStore();
    expect(await store.load(await makeRoot())).toEqual({ settings: {}, layout: {} });
  });

  it('пишет настройки в .chui_ide/settings.json', async () => {
    const store = new ProjectConfigStore();
    const base = await makeRoot();
    await store.updateSettings(base, { editor: { tabSize: 4 } });
    const file = path.join(base, '.chui_ide', 'settings.json');
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ editor: { tabSize: 4 } });
  });

  it('объединяет патчи настроек внутри секции', async () => {
    const store = new ProjectConfigStore();
    const base = await makeRoot();
    await store.updateSettings(base, { editor: { tabSize: 4 } });
    const next = await store.updateSettings(base, { editor: { wordWrap: true } });
    expect(next.settings.editor).toEqual({ tabSize: 4, wordWrap: true });
  });

  it('сохраняет макет и объединяет его', async () => {
    const store = new ProjectConfigStore();
    const base = await makeRoot();
    await store.saveLayout(base, { sidebarSize: 280, dockVisible: true });
    expect(await store.saveLayout(base, { rightSize: 300 })).toEqual({
      sidebarSize: 280,
      dockVisible: true,
      rightSize: 300,
    });
  });

  it('битый JSON не роняет загрузку', async () => {
    const store = new ProjectConfigStore();
    const base = await makeRoot();
    await mkdir(path.join(base, '.chui_ide'), { recursive: true });
    await writeFile(path.join(base, '.chui_ide', 'settings.json'), '{ broken', 'utf8');
    expect((await store.load(base)).settings).toEqual({});
  });

  it('макет игнорирует мусорные значения', async () => {
    const store = new ProjectConfigStore();
    const base = await makeRoot();
    expect(await store.saveLayout(base, { sidebarSize: -1 } as never)).toEqual({});
  });
});

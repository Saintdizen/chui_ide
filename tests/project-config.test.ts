import { mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ProjectConfigStore } from '../src/main/project-config';
import { applyProjectSettingsPatch, sanitizeProjectSettings } from '../src/shared/project-config';

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

  describe('кегль редактора: один предел на все входы (TASKS 51)', () => {
    /**
     * Было три разных предела у одной настройки: `Ctrl+=`/`Ctrl+-` держали 6..72,
     * поле «Размер шрифта» — зашитые 8..32, а `.chui_ide/settings.json` не проверялся
     * вовсе: через файл проходили `0`, `-5` и `1e9`. Здесь проверяем общий слой.
     */
    it('значение из файла выше 72 поджимается к 72', () => {
      expect(sanitizeProjectSettings({ editor: { fontSize: 200 } })).toEqual({ editor: { fontSize: 72 } });
    });

    it('значение ниже 6 поджимается к 6', () => {
      expect(sanitizeProjectSettings({ editor: { fontSize: 1 } })).toEqual({ editor: { fontSize: 6 } });
    });

    it('ноль и отрицательное — не «мелкий шрифт», а мусор: дают 14', () => {
      // Раньше `0` доходил до редактора, и текст просто исчезал без сообщения.
      expect(sanitizeProjectSettings({ editor: { fontSize: 0 } })).toEqual({ editor: { fontSize: 14 } });
      expect(sanitizeProjectSettings({ editor: { fontSize: -5 } })).toEqual({ editor: { fontSize: 14 } });
    });

    it('мусор вместо числа — тоже 14', () => {
      expect(sanitizeProjectSettings({ editor: { fontSize: 'большой' } })).toEqual({ editor: { fontSize: 14 } });
      expect(sanitizeProjectSettings({ editor: { fontSize: null } })).toEqual({ editor: { fontSize: 14 } });
      expect(sanitizeProjectSettings({ editor: { fontSize: Number.NaN } })).toEqual({ editor: { fontSize: 14 } });
    });

    it('дробное округляется, допустимое не меняется', () => {
      expect(sanitizeProjectSettings({ editor: { fontSize: 15.6 } })).toEqual({ editor: { fontSize: 16 } });
      expect(sanitizeProjectSettings({ editor: { fontSize: 14 } })).toEqual({ editor: { fontSize: 14 } });
      expect(sanitizeProjectSettings({ editor: { fontSize: 72 } })).toEqual({ editor: { fontSize: 72 } });
      expect(sanitizeProjectSettings({ editor: { fontSize: 6 } })).toEqual({ editor: { fontSize: 6 } });
    });

    it('остальные поля редактора не трогаются', () => {
      expect(sanitizeProjectSettings({ editor: { fontSize: 200, tabSize: 2 } })).toEqual({
        editor: { fontSize: 72, tabSize: 2 },
      });
    });

    it('без fontSize секция остаётся как была', () => {
      expect(sanitizeProjectSettings({ editor: { tabSize: 2 } })).toEqual({ editor: { tabSize: 2 } });
    });
  });
});

describe('applyProjectSettingsPatch', () => {
  it('дополняет секции рекурсивно и не мутирует вход', () => {
    const current = { editor: { tabSize: 2, fontSize: 12 } };
    const patch = { editor: { fontSize: 14 } };
    const next = applyProjectSettingsPatch(current, patch);
    expect(next).toEqual({ editor: { tabSize: 2, fontSize: 14 } });
    expect(current).toEqual({ editor: { tabSize: 2, fontSize: 12 } });
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

  it('пустой проект даёт пустые настройки', async () => {
    const store = new ProjectConfigStore();
    expect(await store.load(await makeRoot())).toEqual({});
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
    const next = await store.updateSettings(base, { editor: { fontSize: 20 } });
    expect(next.editor).toEqual({ tabSize: 4, fontSize: 20 });
  });

  it('битый JSON не роняет загрузку', async () => {
    const store = new ProjectConfigStore();
    const base = await makeRoot();
    await mkdir(path.join(base, '.chui_ide'), { recursive: true });
    await writeFile(path.join(base, '.chui_ide', 'settings.json'), '{ broken', 'utf8');
    expect(await store.load(base)).toEqual({});
  });
});

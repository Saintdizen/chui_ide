import { describe, expect, it } from 'vitest';
import { ProjectToolsModel } from '../src/renderer/core/project-tools';
import { shellQuote } from '../src/shared/shell-quote';

/**
 * Кавычки для пути в команде терминала (`shared/shell-quote.ts`).
 *
 * От этой функции зависит, переживёт ли запуск путь с пробелом или апострофом.
 * Ошибка здесь выглядит как «команда не найдена» у человека, а не у нас, поэтому
 * проверяются именно неудобные пути.
 */

describe('кавычки в команде терминала', () => {
  it('простой путь остаётся как есть', () => {
    expect(shellQuote('/home/user/proj')).toBe('/home/user/proj');
    expect(shellQuote('src/a.ts')).toBe('src/a.ts');
  });

  it('пробел заворачивает путь в одинарные кавычки', () => {
    const quote = String.fromCharCode(39);
    expect(shellQuote('/home/my proj')).toBe(`${quote}/home/my proj${quote}`);
  });

  it('путь с апострофом уходит в двойные кавычки', () => {
    // Одинарная кавычка внутри одинарных закрыла бы строку, и остаток пути стал бы
    // отдельной командой.
    const quoted = shellQuote(`/home/o${String.fromCharCode(39)}brien/proj`);
    expect(quoted.startsWith('"')).toBe(true);
    expect(quoted.endsWith('"')).toBe(true);
  });

  it('знаки оболочки экранируются', () => {
    for (const value of ['a b', 'a|b', 'a;b', 'a$(b)', 'a&b', 'a>b']) {
      expect(shellQuote(value), value).not.toBe(value);
    }
  });

  it('пустая строка остаётся пустой', () => {
    // Кавычки вокруг пустоты дали бы аргумент, которого не было: `''` — это уже
    // пустой аргумент, и команда получила бы лишний.
    expect(shellQuote('')).toBe('');
  });
});

describe('инструменты проекта', () => {
  interface Answers {
    manifest?: unknown;
    files?: string[];
    node?: string | null;
    settings?: { packageManager: string };
  }

  function makeModel(answers: Answers = {}) {
    const files = new Set(answers.files ?? []);
    const calls: string[] = [];
    const rpc = {
      request: async (method: string, params?: { path?: string }) => {
        calls.push(method);
        if (method === 'workspace.stat') {
          if (!files.has(String(params?.path))) throw new Error('нет файла');
          return { size: 0 };
        }
        if (method === 'node.info') {
          if (!answers.node) throw new Error('нет node');
          return { runtime: { version: answers.node } };
        }
        // `workspace.readFile` отдаёт файл с полем `text`: модель разбирает его как JSON.
        if (method === 'workspace.readFile') return { text: JSON.stringify(answers.manifest ?? {}) };
        return {};
      },
    };
    const settings = { packageManager: 'auto', pythonByRoot: {}, pythonPath: '', ...(answers.settings ?? {}) };
    // Второй аргумент — уже раздел `run` настроек, третий — платформа окна.
    const model = new ProjectToolsModel(rpc as never, () => settings as never, 'linux');
    return { model, calls, files, settings };
  }

  it('без проекта инструментов нет', async () => {
    const { model } = makeModel();

    await model.refresh(null);

    expect(model.get().root).toBeNull();
    expect(model.get().scripts).toEqual([]);
  });

  it('скрипты package.json становятся задачами', async () => {
    const { model, files } = makeModel({
      files: ['/p/package.json'],
      manifest: { scripts: { build: 'tsc', test: 'vitest' } },
    });
    files.add('/p/package.json');

    await model.refresh('/p');

    expect(model.get().scripts.map((script) => script.name)).toEqual(['build', 'test']);
  });
});

describe('инструменты проекта: выбор', () => {
  function makeModel(answers: { manifest?: unknown; files?: string[]; node?: string | null; pm?: string } = {}) {
    const files = new Set(answers.files ?? []);
    const calls: string[] = [];
    const rpc = {
      request: async (method: string, params?: { path?: string }) => {
        calls.push(method);
        if (method === 'workspace.stat') {
          if (!files.has(String(params?.path))) throw new Error('нет файла');
          return { size: 0 };
        }
        if (method === 'node.info') {
          if (!answers.node) throw new Error('нет node');
          return { runtime: { version: answers.node } };
        }
        // `workspace.readFile` отдаёт файл с полем `text`: модель разбирает его как JSON.
        if (method === 'workspace.readFile') return { text: JSON.stringify(answers.manifest ?? {}) };
        return {};
      },
    };
    // Настройки читаются целиком: модель смотрит и менеджер пакетов, и пути
    // интерпретаторов (в `run`), поэтому пустой объект здесь не годится.
    const settings = { packageManager: answers.pm ?? 'auto', pythonByRoot: {}, pythonPath: '' };
    return { model: new ProjectToolsModel(rpc as never, () => settings as never, 'linux'), calls, files };
  }

  it('менеджер пакетов берётся из замка при настройке auto', async () => {
    const { model, files } = makeModel({ manifest: { scripts: {} } });
    files.add('/p/package.json');
    files.add('/p/pnpm-lock.yaml');

    await model.refresh('/p');

    expect(model.get().packageManager).toBe('pnpm');
  });

  it('выбранный вручную менеджер важнее замка', async () => {
    const { model, files } = makeModel({ manifest: { scripts: {} }, pm: 'yarn' });
    files.add('/p/package.json');
    files.add('/p/pnpm-lock.yaml');

    await model.refresh('/p');

    expect(model.get().packageManager).toBe('yarn');
  });

  it('нет Node — версия пустая, а не падение', async () => {
    const { model, files } = makeModel({ manifest: { scripts: {} } });
    files.add('/p/package.json');

    await model.refresh('/p');

    expect(model.get().nodeVersion ?? null).toBeNull();
  });

  it('повторный refresh того же корня не перечитывает файлы', async () => {
    const { model, calls, files } = makeModel({ manifest: { scripts: {} } });
    files.add('/p/package.json');
    await model.refresh('/p');
    const before = calls.length;

    await model.refresh('/p');

    expect(calls.length).toBe(before);
  });

  it('force перечитывает даже тот же корень', async () => {
    // Нужен, когда package.json поправили: файлы изменились, решение тоже.
    const { model, calls, files } = makeModel({ manifest: { scripts: {} } });
    files.add('/p/package.json');
    await model.refresh('/p');
    const before = calls.length;

    await model.refresh('/p', true);

    expect(calls.length).toBeGreaterThan(before);
  });
});

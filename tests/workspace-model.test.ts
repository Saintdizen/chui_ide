import { describe, expect, it, vi } from 'vitest';
import { relativePath, WorkspaceModel } from '../src/renderer/core/workspace-model';
import type { WorkspaceInfo } from '../src/shared/api';
import type { WorkspaceRoot } from '../src/shared/workspace-roots';

/**
 * Рабочая область в окне (`renderer/core/workspace-model.ts`).
 *
 * Файловой системы здесь нет — только RPC, поэтому тест отвечает за main. Главное:
 * чем отличается смена проекта от смены набора папок. От этого зависит, закроются
 * ли вкладки и сбросится ли сессия, — ошибка стоит человеку открытых файлов.
 */

function root(path: string): WorkspaceRoot {
  // Поле называется `root`, а не `path`: так его ждёт `rootForPath` в shared.
  return { root: path, name: path.split('/').pop() ?? path } as WorkspaceRoot;
}

function info(rootPath: string, others: string[] = []): WorkspaceInfo {
  return {
    root: rootPath,
    roots: [root(rootPath), ...others.map((item) => root(item))],
    name: rootPath.split('/').pop() ?? rootPath,
  } as WorkspaceInfo;
}

function makeModel(answers: Record<string, unknown> = {}) {
  const reasons: string[] = [];
  const rpc = {
    request: vi.fn(async (method: string) => {
      if (method in answers) return answers[method];
      if (method === 'workspace.open') return info('/p');
      if (method === 'workspace.addRoot') return info('/p', ['/q']);
      if (method === 'workspace.removeRoot') return null;
      if (method === 'workspace.setActiveRoot') return info('/q');
      return {};
    }),
  };
  const model = new WorkspaceModel(rpc as never);
  model.onDidChange((change) => reasons.push(change.reason));
  return { model, rpc, reasons };
}

describe('состояние рабочей области', () => {
  it('пустая область: имени нет, корень пустой', () => {
    const { model } = makeModel();

    expect(model.current).toBeNull();
    expect(model.root).toBeNull();
    expect(model.roots).toEqual([]);
    expect(model.name).toBe('нет папки');
  });

  it('открытие папки — смена проекта', async () => {
    // Именно проект: вкладки прежней папки к новой не относятся.
    const { model, reasons } = makeModel();

    await model.open('/p');

    expect(model.root).toBe('/p');
    expect(reasons).toEqual(['project']);
  });

  it('добавление папки — смена набора корней, а не проекта', async () => {
    const { model, reasons } = makeModel();

    await model.addRoot('/q');

    expect(reasons).toEqual(['roots']);
    expect(model.isMultiRoot).toBe(true);
  });

  it('удаление последнего корня — проект закрыт', async () => {
    // Область опустела: рабочее место сбрасывается, как при закрытии папки.
    const { model, reasons } = makeModel();

    await model.removeRoot('/p');

    expect(model.current).toBeNull();
    expect(reasons).toEqual(['project']);
  });

  it('смена активного корня — тот же проект, другая папка', async () => {
    const { model, reasons } = makeModel();

    await model.setActiveRoot('/q');

    expect(reasons).toEqual(['roots']);
  });

  it('выбор папки: отмена не меняет область', async () => {
    const { model, reasons } = makeModel({ 'dialog.pickFolder': {} });

    expect(await model.pick()).toBeNull();
    expect(reasons).toEqual([]);
  });

  it('выбор папки открывает её и возвращает путь', async () => {
    const { model } = makeModel({ 'dialog.pickFolder': { path: '/p' } });

    expect(await model.pick()).toBe('/p');
    expect(model.root).toBe('/p');
  });

  it('обновление без открытой папки ничего не запрашивает', async () => {
    const { model, rpc } = makeModel();

    await model.refresh();

    expect(rpc.request).not.toHaveBeenCalled();
  });
});

describe('пути внутри области', () => {
  function withInfo(model: WorkspaceModel): void {
    (model as unknown as { info: WorkspaceInfo }).info = info('/p', ['/q']);
  }

  it('путь показывается относительно своего корня', () => {
    // С несколькими корнями «относительно текущего проекта» даёт `../../…`, и
    // человек не понимает, где файл.
    const { model } = makeModel();
    withInfo(model);

    expect(model.relative('/p/src/a.ts')).toBe('src/a.ts');
    expect(model.relative('/q/lib/b.ts')).toBe('lib/b.ts');
  });

  it('файл вне области показывается как есть', () => {
    const { model } = makeModel();
    withInfo(model);

    expect(model.relative('/other/x.ts')).toBe('/other/x.ts');
  });

  it('путь, равный корню, даёт имя области, а не пустоту', () => {
    const { model } = makeModel();
    withInfo(model);

    expect(model.relative('/p')).toBe('p');
  });

  it('корень файла находится', () => {
    const { model } = makeModel();
    withInfo(model);

    expect(model.ownerOf('/q/lib/b.ts')?.root).toBe('/q');
    expect(model.ownerOf('/other/x.ts')).toBeNull();
  });

  it('relativePath понимает и прямой, и обратный разделитель', () => {
    // main на Windows отдаёт обратные слэши: со «всегда /» файл выглядел лежащим
    // вне корня, и у него пропадала кнопка запуска. Разделитель при этом остаётся
    // родным — путь показывают человеку на его системе.
    expect(relativePath('/p', '/p/src/a.ts')).toBe('src/a.ts');
    expect(relativePath('C:\\proj', 'C:\\proj\\src\\a.ts')).toBe('src\\a.ts');
  });
});

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createExplorer } from '../src/renderer/ui/explorer';
import { installMiniDom } from './helpers/mini-dom';
import { Emitter } from '../src/renderer/core/events';
import { WorkspaceModel } from '../src/renderer/core/workspace-model';

/**
 * Автораскрытие: сменили вкладку — дерево само находит файл (п.22).
 *
 * Без этого файл из вкладки ищут глазами по всему дереву: подсветка есть, но
 * строка остаётся за краем экрана или в свёрнутой папке.
 *
 * Проверяем два решения, которые легко сломать молча:
 * - `onDidChange` зовётся и при смене «грязности», и при правке порядка вкладок.
 *   Водить дерево на каждое такое событие — значит раскрывать папки против воли;
 *   поэтому реагируем только на СМЕНУ активного пути.
 * - выключенная настройка оставляет дерево на месте.
 */

const ROOT = '/project';

/**
 * Заглушка модели открытых вкладок: тесту нужны `active`, `onDidChange` и
 * возможность позвать стек самому — настоящий `OpenEditors` тянет за собой
 * хранилище документов и редактор.
 */
function openEditorsStub() {
  const emitter = new Emitter<void>();
  let active: string | null = null;
  return {
    get active() {
      return active === null ? null : { path: active };
    },
    onDidChange: emitter.event,
    set(path: string | null): void {
      active = path;
      emitter.fire();
    },
    /** Событие без смены активного — как при правке текста. */
    fireQuietly(): void {
      emitter.fire();
    },
  };
}

function setup(options: { autoReveal?: () => boolean } = {}) {
  const openEditors = openEditorsStub();
  // Чтение папки идёт запросом `workspace.readDir` — его и считаем поводом.
  const request = vi.fn(async (method: string, params: { path?: string }) => {
    if (method !== 'workspace.readDir') return [];
    return params.path === ROOT
      ? [{ name: 'src', path: `${ROOT}/src`, directory: true }]
      : [{ name: 'a.ts', path: `${ROOT}/src/a.ts`, directory: false }];
  });
  const readDir = (dir: string): boolean =>
    request.mock.calls.some(([method, params]) => method === 'workspace.readDir' && (params as { path?: string }).path === dir);
  // Дерево смотрит на `workspace.current`, а модель берёт корень у rpc —
  // проще применить ответ `workspace.open`, чем подделывать модель целиком.
  const workspace = new WorkspaceModel({
    request: vi.fn(async (method: string) =>
      method === 'workspace.open'
        ? {
            root: ROOT,
            name: 'project',
            entries: [{ name: 'src', path: `${ROOT}/src`, directory: true }],
            roots: [{ root: ROOT, name: 'project' }],
          }
        : [],
    ),
  } as never);
  void workspace.open(ROOT);
  const view = createExplorer({
    workspace,
    rpc: { request } as never,
    commands: { execute: vi.fn() } as never,
    openEditors: openEditors as never,
    // Сортировка спрашивает пометку git у каждого пути — без неё чтение падает.
    git: {
      onDidChange: new Emitter<void>().event,
      statusOf: () => undefined,
      deletedIn: () => [],
    } as never,
    documents: {
      dirty: () => [],
      get: () => undefined,
      has: () => false,
      all: () => [],
      onDidChange: () => () => {},
      onDidChangeDirty: () => () => {},
      onDidClose: () => () => {},
    } as never,
    ...(options.autoReveal ? { autoReveal: options.autoReveal } : {}),
  });
  return { view, openEditors, readDir, request, workspace, calls: () => request.mock.calls.length };
}

/** Раскрытие папки видно по запросу её содержимого. */
const waited = async (check: () => boolean): Promise<void> => {
  for (let i = 0; i < 40 && !check(); i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
};

describe('файл из вкладки находится в дереве сам', () => {
  beforeEach(() => {
    installMiniDom();
  });

  it('смена вкладки раскрывает папки файла', async () => {
    const { view, openEditors, readDir } = setup();
    view.element; // дерево поднимается отрисовкой
    await waited(() => readDir(ROOT));
    expect(readDir(ROOT)).toBe(true);

    openEditors.set(`${ROOT}/src/a.ts`);
    await waited(() => readDir('/project/src'));

    expect(readDir('/project/src')).toBe(true);
  });

  it('событие без смены активного файла дерево не двигает', async () => {
    const { view, openEditors, readDir, calls } = setup();
    view.element; // корень читается первой отрисовкой
    await waited(() => readDir(ROOT));
    openEditors.set(`${ROOT}/src/a.ts`);
    await waited(() => readDir('/project/src'));
    const before = calls();

    // Правка текста, смена «грязности», перестановка вкладок — активный путь тот же.
    openEditors.fireQuietly();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(calls()).toBe(before);
    view.render();
  });

  it('выключенная настройка оставляет дерево на месте', async () => {
    const { view, openEditors, readDir } = setup({ autoReveal: () => false });
    openEditors.set(`${ROOT}/src/a.ts`);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(readDir('/project/src')).toBe(false);
    view.render();
  });
});


import { describe, expect, it } from 'vitest';
import { MAX_MACRO_STEPS, rawMacroSteps } from '../src/shared/macro';
import {
  EMPTY_SESSION,
  MAX_EXPANDED,
  MAX_TABS,
  MAX_UNSAVED_CHARS,
  MAX_UNSAVED_FILES,
  MAX_WATCH,
  sanitizeSession,
  selectUnsavedBuffers,
  unsavedBuffers,
} from '../src/shared/session';

describe('sanitizeSession', () => {
  it('не объект → пустая сессия', () => {
    expect(sanitizeSession(null)).toEqual(EMPTY_SESSION);
    expect(sanitizeSession('нет')).toEqual(EMPTY_SESSION);
    expect(sanitizeSession(42)).toEqual(EMPTY_SESSION);
  });

  it('читает корректную сессию', () => {
    const state = sanitizeSession({
      tabs: ['/p/a.ts', '/p/b.ts'],
      activeTab: '/p/b.ts',
      expanded: ['/p/src'],
      dockActive: 'terminal',
    });
    expect(state).toEqual({
      tabs: ['/p/a.ts', '/p/b.ts'],
      activeTab: '/p/b.ts',
      expanded: ['/p/src'],
      dockActive: 'terminal',
    });
  });

  it('активную вкладку оставляет только среди открытых', () => {
    const state = sanitizeSession({ tabs: ['/p/a.ts'], activeTab: '/p/zzz.ts' });
    expect(state.activeTab).toBeUndefined();
  });

  it('нестроковые элементы отбрасываются', () => {
    const state = sanitizeSession({ tabs: ['/p/a.ts', 42, null, '', '/p/b.ts'], expanded: [null, '/p/x'] });
    expect(state.tabs).toEqual(['/p/a.ts', '/p/b.ts']);
    expect(state.expanded).toEqual(['/p/x']);
  });

  it('уважает границы количества', () => {
    const manyTabs = Array.from({ length: MAX_TABS + 10 }, (_, i) => `/p/${i}.ts`);
    const manyFolders = Array.from({ length: MAX_EXPANDED + 10 }, (_, i) => `/p/d${i}`);
    const state = sanitizeSession({ tabs: manyTabs, expanded: manyFolders });
    expect(state.tabs).toHaveLength(MAX_TABS);
    expect(state.expanded).toHaveLength(MAX_EXPANDED);
  });

  it('несколько корней рабочей области сохраняются, один — нет', () => {
    // Две папки в одном окне — это часть рабочего места, её и помним.
    expect(sanitizeSession({ roots: ['/a', '/b'] }).roots).toEqual(['/a', '/b']);
    // Один корень — обычный проект: дублировать его в файле незачем.
    expect(sanitizeSession({ roots: ['/a'] }).roots).toBeUndefined();
    expect(sanitizeSession({ roots: [] }).roots).toBeUndefined();
    expect(sanitizeSession({}).roots).toBeUndefined();
  });

  it('битый список корней не ломает сессию', () => {
    expect(sanitizeSession({ roots: [1, null, '', '/a', '/b'] }).roots).toEqual(['/a', '/b']);
    expect(sanitizeSession({ roots: 'нет' }).roots).toBeUndefined();
  });

  it('видимость панелей в сессию не попадает (это часть общего макета)', () => {
    const state = sanitizeSession({ sidebarVisible: false, rightVisible: false, dockVisible: true });
    expect('sidebarVisible' in state).toBe(false);
    expect('rightVisible' in state).toBe(false);
    expect('dockVisible' in state).toBe(false);
  });

  it('dockActive без содержимого не сохраняется', () => {
    expect(sanitizeSession({ dockActive: '' }).dockActive).toBeUndefined();
    expect(sanitizeSession({ dockActive: 'search' }).dockActive).toBe('search');
  });

  it('параметры запуска отладки читаются целиком', () => {
    const state = sanitizeSession({
      debugLaunch: { args: ['--port', '8080'], env: { LOG_LEVEL: 'debug' }, cwd: '/p/run' },
    });
    expect(state.debugLaunch).toEqual({ args: ['--port', '8080'], env: { LOG_LEVEL: 'debug' }, cwd: '/p/run' });
  });

  it('пустые параметры запуска не пишутся в сессию', () => {
    expect(sanitizeSession({ debugLaunch: { args: [], env: {} } }).debugLaunch).toBeUndefined();
    expect(sanitizeSession({ debugLaunch: null }).debugLaunch).toBeUndefined();
    expect(sanitizeSession({ debugLaunch: 'args' }).debugLaunch).toBeUndefined();
  });

  it('битые параметры запуска отбрасываются, живые остаются', () => {
    const state = sanitizeSession({ debugLaunch: { args: ['--x', 42, ''], env: { A: '1', B: 2 }, cwd: 7 } });
    expect(state.debugLaunch).toEqual({ args: ['--x'], env: { A: '1' } });
  });

  it('наблюдаемые выражения сохраняются и ограничены по количеству', () => {
    const many = Array.from({ length: MAX_WATCH + 10 }, (_, i) => `n + ${i}`);
    const state = sanitizeSession({ debugWatch: many });
    expect(state.debugWatch).toHaveLength(MAX_WATCH);
  });

  it('пустое наблюдение не пишется в сессию', () => {
    expect(sanitizeSession({ debugWatch: [] }).debugWatch).toBeUndefined();
    expect(sanitizeSession({ debugWatch: ['ok', '', 5] }).debugWatch).toEqual(['ok']);
  });

  it('останов по исключению читается и валиден', () => {
    expect(sanitizeSession({ debugExceptions: { uncaught: true, caught: false } }).debugExceptions).toEqual({
      uncaught: true,
      caught: false,
    });
  });

  it('выключенный останов по исключению в сессию не пишется', () => {
    expect(sanitizeSession({ debugExceptions: { uncaught: false, caught: false } }).debugExceptions).toBeUndefined();
    expect(sanitizeSession({ debugExceptions: null }).debugExceptions).toBeUndefined();
    expect(sanitizeSession({ debugExceptions: [true] }).debugExceptions).toBeUndefined();
  });

  it('точки останова читаются с настройками', () => {
    const state = sanitizeSession({
      breakpoints: [
        { path: '/p/a.py', line: 3 },
        { path: '/p/a.py', line: 5, condition: '  n > 1  ', logMessage: 'n = {n}' },
        { path: '/p/b.py', line: 2, hitCondition: '5' },
      ],
    });
    expect(state.breakpoints).toEqual([
      { path: '/p/a.py', line: 3 },
      { path: '/p/a.py', line: 5, condition: 'n > 1', logMessage: 'n = {n}' },
      { path: '/p/b.py', line: 2, hitCondition: '5' },
    ]);
  });

  it('битые точки останова отбрасываются', () => {
    const state = sanitizeSession({
      breakpoints: [
        { path: '/p/a.py', line: 0 },
        { path: '/p/a.py', line: 1.5 },
        { path: '', line: 2 },
        { path: '/p/a.py', line: '3' },
        { path: '/p/a.py', line: 4 },
      ],
    });
    expect(state.breakpoints).toEqual([{ path: '/p/a.py', line: 4 }]);
  });

  it('пустой список точек не пишется и мусор не считается списком', () => {
    expect(sanitizeSession({ breakpoints: [] }).breakpoints).toBeUndefined();
    expect(sanitizeSession({ breakpoints: 'нет' }).breakpoints).toBeUndefined();
  });

  it('закладки читаются и приводятся к каноническому порядку', () => {
    const state = sanitizeSession({
      bookmarks: [
        { path: '/p/b.ts', line: 9 },
        { path: '/p/a.ts', line: 4 },
        { path: '/p/a.ts', line: 4 },
        { path: '/p/a.ts', line: 0 },
      ],
    });
    expect(state.bookmarks).toEqual([
      { path: '/p/a.ts', line: 4 },
      { path: '/p/b.ts', line: 9 },
    ]);
  });

  it('пустые и битые закладки в сессию не пишутся', () => {
    expect(sanitizeSession({ bookmarks: [] }).bookmarks).toBeUndefined();
    expect(sanitizeSession({ bookmarks: 'нет' }).bookmarks).toBeUndefined();
    expect(sanitizeSession({ bookmarks: [{ path: '/p/a.ts', line: 0 }] }).bookmarks).toBeUndefined();
  });

  it('позиции курсоров читаются для открытых файлов', () => {
    const state = sanitizeSession({
      tabs: ['/p/a.ts', '/p/b.ts'],
      cursors: { '/p/a.ts': { line: 12, column: 4 } },
    });
    expect(state.cursors).toEqual({ '/p/a.ts': { line: 12, column: 4 } });
  });

  it('позиция закрытого файла отбрасывается: она мертва', () => {
    const state = sanitizeSession({
      tabs: ['/p/a.ts'],
      cursors: { '/p/a.ts': { line: 1, column: 1 }, '/p/gone.ts': { line: 5, column: 2 } },
    });
    expect(Object.keys(state.cursors ?? {})).toEqual(['/p/a.ts']);
  });

  it('битые позиции курсоров отбрасываются', () => {
    const state = sanitizeSession({
      tabs: ['/p/a.ts', '/p/b.ts', '/p/c.ts'],
      cursors: {
        '/p/a.ts': { line: 0, column: 1 },
        '/p/b.ts': { line: 3, column: 1.5 },
        '/p/c.ts': 'нет',
      },
    });
    expect(state.cursors).toBeUndefined();
  });

  it('строки без позиций в сессию не пишутся', () => {
    expect(sanitizeSession({ tabs: ['/p/a.ts'] }).cursors).toBeUndefined();
    expect(sanitizeSession({ tabs: [], cursors: [] }).cursors).toBeUndefined();
  });
});

describe('границы пустой сессии не мутируются', () => {
  it('EMPTY_SESSION не меняется при возврате', () => {
    const snapshot = JSON.stringify(EMPTY_SESSION);
    const state = sanitizeSession(null);
    state.tabs.push('/p/x.ts');
    expect(JSON.stringify(EMPTY_SESSION)).toBe(snapshot);
  });
});

describe('несохранённые правки («hot exit»)', () => {
  it('отбор: пустой текст, дубли и гиганты не берём', () => {
    const picked = selectUnsavedBuffers([
      { path: '/p/a.ts', text: 'правка' },
      { path: '/p/empty.ts', text: '' },
      { path: '/p/a.ts', text: 'дубль' },
      { path: '/p/huge.ts', text: 'x'.repeat(MAX_UNSAVED_CHARS + 1) },
      { path: '/p/b.ts', text: 'ещё' },
    ]);
    expect(picked).toEqual([
      { path: '/p/a.ts', text: 'правка' },
      { path: '/p/b.ts', text: 'ещё' },
    ]);
  });

  it('отбор: порядок сохраняется, число файлов ограничено', () => {
    const many = Array.from({ length: MAX_UNSAVED_FILES + 5 }, (_, i) => ({ path: `/p/${i}.ts`, text: 'x' }));
    const picked = selectUnsavedBuffers(many);
    expect(picked).toHaveLength(MAX_UNSAVED_FILES);
    expect(picked[0]!.path).toBe('/p/0.ts');
  });

  it('из сессии читаются только объекты с путём и текстом', () => {
    expect(unsavedBuffers(null)).toEqual([]);
    expect(unsavedBuffers('нет')).toEqual([]);
    expect(unsavedBuffers([{ path: '', text: 'x' }, { path: '/p/a.ts' }, 5, null])).toEqual([]);
    expect(unsavedBuffers([{ path: '/p/a.ts', text: 'код' }])).toEqual([{ path: '/p/a.ts', text: 'код' }]);
  });

  it('sanitizeSession сохраняет несохранённое и не пишет пустое', () => {
    const state = sanitizeSession({ tabs: ['/p/a.ts'], expanded: [], unsaved: [{ path: '/p/a.ts', text: 'код' }] });
    expect(state.unsaved).toEqual([{ path: '/p/a.ts', text: 'код' }]);
    expect(sanitizeSession({ tabs: [], expanded: [], unsaved: [] }).unsaved).toBeUndefined();
    expect(
      sanitizeSession({ tabs: [], expanded: [], unsaved: [{ path: '/p/a.ts', text: '' }] }).unsaved,
    ).toBeUndefined();
  });
});

describe('макрос в сессии', () => {
  it('длинный список обрезается по пределу', () => {
    const many = Array.from({ length: MAX_MACRO_STEPS + 50 }, (_, index) => ({ kind: 'move', index }));
    expect(rawMacroSteps(many)).toHaveLength(MAX_MACRO_STEPS);
  });

  it('не массив — пусто: форму шага проверяет редактор, а не сессия', () => {
    expect(rawMacroSteps(null)).toEqual([]);
    expect(rawMacroSteps('нет')).toEqual([]);
    expect(rawMacroSteps({ kind: 'move' })).toEqual([]);
  });

  it('sanitizeSession сохраняет непустой макрос и не пишет пустой', () => {
    const steps = [{ kind: 'move' }];
    expect(sanitizeSession({ tabs: [], expanded: [], macro: steps }).macro).toEqual(steps);
    expect(sanitizeSession({ tabs: [], expanded: [], macro: [] }).macro).toBeUndefined();
    expect(sanitizeSession({ tabs: [], expanded: [], macro: 'нет' }).macro).toBeUndefined();
  });
});

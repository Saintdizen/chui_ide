import { describe, expect, it } from 'vitest';
import { EMPTY_SESSION, MAX_EXPANDED, MAX_TABS, MAX_WATCH, sanitizeSession } from '../src/shared/session';

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
});

describe('границы пустой сессии не мутируются', () => {
  it('EMPTY_SESSION не меняется при возврате', () => {
    const snapshot = JSON.stringify(EMPTY_SESSION);
    const state = sanitizeSession(null);
    state.tabs.push('/p/x.ts');
    expect(JSON.stringify(EMPTY_SESSION)).toBe(snapshot);
  });
});

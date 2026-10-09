import { describe, expect, it } from 'vitest';
import { EMPTY_SESSION, MAX_EXPANDED, MAX_TABS, sanitizeSession } from '../src/shared/session';

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
      dockVisible: true,
      dockActive: 'terminal',
      sidebarVisible: false,
      rightVisible: true,
    });
    expect(state).toEqual({
      tabs: ['/p/a.ts', '/p/b.ts'],
      activeTab: '/p/b.ts',
      expanded: ['/p/src'],
      dockVisible: true,
      dockActive: 'terminal',
      sidebarVisible: false,
      rightVisible: true,
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

  it('видимость панелей по умолчанию — правая и боковая видны', () => {
    const state = sanitizeSession({});
    expect(state.sidebarVisible).toBe(true);
    expect(state.rightVisible).toBe(true);
    expect(state.dockVisible).toBe(false);
  });

  it('dockActive без содержимого не сохраняется', () => {
    expect(sanitizeSession({ dockActive: '' }).dockActive).toBeUndefined();
    expect(sanitizeSession({ dockActive: 'search' }).dockActive).toBe('search');
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

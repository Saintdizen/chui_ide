import { describe, expect, it } from 'vitest';
import { installMiniDom } from './helpers/mini-dom';
import { createTerminalPanel } from '../src/renderer/ui/terminal';

/**
 * П.18: «Раскладка помнит себя не только в размерах».
 *
 * Размеры панелей и раскрытые папки в сессии жили давно, а вкладки терминала —
 * нет: после перезапуска окно открывалось с пустой консолью и заново набранным
 * `cd`. Сами оболочки не переживают перезапуск (pty живёт в процессе), поэтому
 * сессия хранит их рабочие каталоги и номер той, что была на экране.
 */

installMiniDom();

interface Created {
  cwd?: string;
}

/** Мост, который притворяется main: помнит, с какими каталогами заводили pty. */
function fakeRpc(): { rpc: never; created: Created[] } {
  const created: Created[] = [];
  const rpc = {
    onPush: () => undefined,
    request: async (channel: string, params?: { cwd?: string }) => {
      if (channel === 'terminal.create') {
        created.push({ cwd: params?.cwd });
        const index = created.length;
        return { id: `s${index}`, shell: 'bash', cwd: params?.cwd ?? '/проект', title: `bash ${index}` };
      }
      return undefined;
    },
  };
  return { rpc: rpc as never, created };
}

function panel(cwd = '/проект') {
  const { rpc, created } = fakeRpc();
  const view = createTerminalPanel({
    rpc: rpc as never,
    cwd: () => cwd,
    ligatures: () => false,
    openLink: () => undefined,
  });
  return { view, created };
}

describe('вкладки терминала в сессии проекта', () => {
  it('свежая панель не пишет ничего: терминала в окне нет', () => {
    const { view } = panel();
    expect(view.tabsState()).toEqual({ cwd: [], active: 0 });
  });

  it('после открытия вкладки её каталог и номер уезжают в состояние', async () => {
    const { view, created } = panel();
    await view.newSession('/проект/исходники');
    expect(created[0]?.cwd).toBe('/проект/исходники');
    expect(view.tabsState()).toEqual({ cwd: ['/проект/исходники'], active: 0 });
  });

  it('восстановление заводит оболочки в прежних каталогах и возвращает активную на экран', async () => {
    const { view, created } = panel();
    // Три вкладки: человек работал во второй, а первая и третья — фон.
    await view.restoreTabs(['/a', '/b', '/c'], 1);
    expect(created.map((entry) => entry.cwd)).toEqual(['/a', '/b', '/c']);
    // Активная — та, что была: иначе на экране оказалась бы последняя созданная.
    expect(view.tabsState()).toEqual({ cwd: ['/a', '/b', '/c'], active: 1 });
  });

  it('номер за пределами списка не ломает восстановление', async () => {
    const { view, created } = panel();
    await view.restoreTabs(['/a', '/b'], 9);
    expect(created).toHaveLength(2);
    // Девятой нет — показываем последнюю существующую, а не ничего.
    expect(view.tabsState().active).toBe(1);
  });

  it('живой терминал не перезаписывается восстановлением', async () => {
    const { view, created } = panel();
    await view.newSession('/своя');
    // Человек уже открыл вкладку в этом окне — сессия из прошлого раза ей не указ.
    await view.restoreTabs(['/чужой'], 0);
    expect(created.map((entry) => entry.cwd)).toEqual(['/своя']);
    expect(view.tabsState().cwd).toEqual(['/своя']);
  });
});

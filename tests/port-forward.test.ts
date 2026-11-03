// biome-ignore-all lint/suspicious/noExplicitAny: узлы мини-DOM шире настоящих —
// тип нужен только внутри файла, чтобы обойти дерево в проверках.
import { describe, expect, it, vi } from 'vitest';
import { ownerSession, parseListings, parsePsTree, portEntries } from '../src/shared/port-forward';

/**
 * Проброс портов: разбор вывода системных утилит (часть 8, п. 2 TASKS).
 *
 * Всё, что можно проверить без ОС, проверяется здесь: текст → структура.
 * Запуск `lsof`/`ss` тестами не покрыть — разные системы и права.
 */

describe('parseListings: lsof', () => {
  it('берёт pid, имя и порт из строки LISTEN', () => {
    const text = [
      'COMMAND    PID     USER FD   TYPE DEVICE SIZE/OFF NODE NAME',
      'node      1234 dethmond 20u  IPv4 111111      0t0  TCP 127.0.0.1:5173 (LISTEN)',
      'python3   4321 dethmond  3u  IPv4 222222      0t0  TCP *:8000 (LISTEN)',
    ].join('\n');
    expect(parseListings(text)).toEqual([
      { port: 5173, pid: 1234, command: 'node' },
      { port: 8000, pid: 4321, command: 'python3' },
    ]);
  });

  it('строки не в состоянии LISTEN не попадают в список', () => {
    const text = [
      'node 1 u IPv4 1 0t0 TCP 127.0.0.1:5173 (ESTABLISHED)',
      'node 1 u IPv4 1 0t0 TCP 127.0.0.1:5174 (LISTEN)',
    ].join('\n');
    expect(parseListings(text).map((item) => item.port)).toEqual([5174]);
  });
});

describe('parseListings: ss', () => {
  it('читает порт из Local Address и имя процесса из users:(...)', () => {
    const text = [
      'State  Recv-Q Send-Q Local Address:Port Peer Address:Port Process',
      'LISTEN 0 4096 0.0.0.0:8080 0.0.0.0:* users:(("node",pid=777,fd=20))',
    ].join('\n');
    expect(parseListings(text)).toEqual([{ port: 8080, pid: 777, command: 'node' }]);
  });

  it('без -p (нет users) порт остаётся, но pid нулевой', () => {
    const text = 'LISTEN 0 4096 127.0.0.54:53 0.0.0.0:*';
    expect(parseListings(text)).toEqual([{ port: 53, pid: 0, command: '' }]);
  });
});

describe('parsePsTree', () => {
  it('собирает pid → ppid', () => {
    expect(parsePsTree('  100   1\n  200 100\n  300 200\n')).toEqual(
      new Map([
        [100, 1],
        [200, 100],
        [300, 200],
      ]),
    );
  });

  it('мусорные строки пропускает, а не падает', () => {
    expect(parsePsTree('100 1\n\nне число\n200 100')).toEqual(
      new Map([
        [100, 1],
        [200, 100],
      ]),
    );
  });
});

describe('ownerSession', () => {
  const sessions = new Map([[100, 'term-1']]);
  const tree = new Map([
    [100, 1],
    [200, 100],
    [300, 200],
  ]);

  it('находит сессию по предку, а не только по прямому pid', () => {
    expect(ownerSession(300, sessions, tree)).toBe('term-1');
  });

  it('чужое дерево — без сессии', () => {
    expect(ownerSession(999, sessions, tree)).toBeUndefined();
  });

  it('цикл в дереве не вешает поиск', () => {
    const loop = new Map([
      [1, 2],
      [2, 1],
    ]);
    expect(ownerSession(1, sessions, loop)).toBeUndefined();
  });
});

describe('portEntries', () => {
  it('порты терминалов идут первыми, остальные — по номеру', () => {
    const tree = new Map([
      [100, 1],
      [200, 100],
    ]);
    const entries = portEntries(
      [
        { port: 9000, pid: 555, command: 'postgres' },
        { port: 3000, pid: 200, command: 'node' },
        { port: 1000, pid: 777, command: 'other' },
      ],
      new Map([[100, 'term-1']]),
      tree,
    );
    expect(entries.map((item) => item.port)).toEqual([3000, 1000, 9000]);
    expect(entries[0]?.terminalId).toBe('term-1');
  });

  it('адрес для браузера — всегда 127.0.0.1, даже если слушают на 0.0.0.0', () => {
    const entries = portEntries([{ port: 8080, pid: 1, command: 'node' }], new Map(), new Map());
    expect(entries[0]?.url).toBe('http://127.0.0.1:8080/');
  });

  it('один порт — одна строка, и выигрывает та, где известен терминал', () => {
    const entries = portEntries(
      [
        { port: 8080, pid: 555, command: 'node' },
        { port: 8080, pid: 200, command: 'node' },
      ],
      new Map([[100, 'term-1']]),
      new Map([
        [100, 1],
        [200, 100],
      ]),
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]?.pid).toBe(200);
    expect(entries[0]?.terminalId).toBe('term-1');
  });
});

describe('ports-panel', () => {
  it('показывает порт и открывает его по кнопке', async () => {
    vi.resetModules();
    const { installMiniDom } = await import('./helpers/mini-dom');
    installMiniDom();
    const { createPortsPanel } = await import('../src/renderer/ui/ports-panel');

    const open = vi.fn();
    const panel = createPortsPanel({
      list: async () => [
        { port: 5173, pid: 200, command: 'node', terminalId: 'term-1', url: 'http://127.0.0.1:5173/' },
      ],
      open,
      revealTerminal: vi.fn(),
    });

    await panel.refresh();
    const text = (node: any): string => [node.textContent ?? '', ...(node.childNodes ?? []).map(text)].join(' ');
    expect(text(panel.element)).toContain('5173');

    const find = (node: any, cls: string): any => {
      if ((node.className ?? '').split(/\s+/).includes(cls)) return node;
      for (const child of node.childNodes ?? []) {
        const hit = find(child, cls);
        if (hit) return hit;
      }
      return undefined;
    };
    const button = find(panel.element, 'ports-open');
    expect(button).toBeDefined();
    button.dispatchEvent({ type: 'click', stopPropagation: () => {}, preventDefault: () => {} });
    expect(open).toHaveBeenCalledWith('http://127.0.0.1:5173/');
  });

  it('сломанный опрос говорит об ошибке, а не «портов нет»', async () => {
    const { installMiniDom } = await import('./helpers/mini-dom');
    installMiniDom();
    const { createPortsPanel } = await import('../src/renderer/ui/ports-panel');

    const panel = createPortsPanel({
      list: async () => {
        throw new Error('lsof: command not found');
      },
      open: vi.fn(),
      revealTerminal: vi.fn(),
    });

    await panel.refresh();
    const text = (node: any): string => [node.textContent ?? '', ...(node.childNodes ?? []).map(text)].join(' ');
    expect(text(panel.element)).toContain('lsof: command not found');
  });
});

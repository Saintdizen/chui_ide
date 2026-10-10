import { FitAddon } from '@xterm/addon-fit';
import { Terminal } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { PushTopic, type TerminalDataPayload, type TerminalExitPayload, type TerminalSession } from '../../shared/api';
import type { RpcClient } from '../core/rpc';
import { TERMINAL_THEMES, type Scheme } from '../core/theme';
import { h, svgIcon } from './dom';
import { showToast } from './toast';

export interface TerminalPanelView {
  element: HTMLElement;
  /** Открыть панель: создаёт сессию, если её ещё нет. */
  open(): Promise<void>;
  newSession(): Promise<void>;
  /**
   * Выполнить готовую команду в новой сессии.
   * Команда набирается в терминале, а не запускается «в фоне»: человек должен
   * видеть процесс, уметь его прервать и посмотреть вывод.
   */
  run(command: string, title?: string): Promise<void>;
  clearActive(): void;
  killActive(): Promise<void>;
  /** Пересчитать размер: вызывать, когда панель стала видимой. */
  fit(): void;
  /** Сменить палитру консоли вместе с темой приложения. */
  setScheme(scheme: Scheme): void;
}

interface SessionView {
  session: TerminalSession;
  terminal: Terminal;
  fit: FitAddon;
  container: HTMLElement;
  tab: HTMLButtonElement;
  exited: boolean;
}

/** Цвета консоли берём из темы: фон совпадает с полотном редактора. */
export function createTerminalPanel(deps: {
  rpc: RpcClient;
  cwd: () => string | null;
  scheme: Scheme;
}): TerminalPanelView {
  let scheme = deps.scheme;

  const tabsHost = h('div', { class: 'term-tabs' });
  const body = h('div', { class: 'term-body' });

  const addButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Новый терминал', onClick: () => void createSession() },
    svgIcon('plus', 15),
  );
  const clearButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Очистить экран', onClick: () => clearActive() },
    svgIcon('refresh', 14),
  );
  const killButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Завершить процесс', onClick: () => void killActive() },
    svgIcon('trash', 14),
  );

  const element = h(
    'div',
    { class: 'terminal-panel' },
    h(
      'div',
      { class: 'term-toolbar' },
      tabsHost,
      h('div', { class: 'toolbar-spacer' }),
      addButton,
      clearButton,
      killButton,
    ),
    body,
  );

  const sessions = new Map<string, SessionView>();
  /** Вывод, пришедший раньше, чем мы успели зарегистрировать сессию. */
  const orphanData = new Map<string, string[]>();
  let activeId: string | null = null;
  /**
   * Незавершённое создание сессии. Промис, а не флаг: запуску нужно ДОЖДАТЬСЯ
   * той сессии, которую уже создаёт открытие панели, иначе команда уходит
   * в пустоту или появляется вторая вкладка.
   */
  let creating: Promise<string | null> | null = null;

  deps.rpc.onPush((message) => {
    if (message.topic === PushTopic.TerminalData) {
      const payload = message.payload as TerminalDataPayload;
      const view = sessions.get(payload.id);
      if (view) view.terminal.write(payload.data);
      else {
        const buffer = orphanData.get(payload.id) ?? [];
        buffer.push(payload.data);
        orphanData.set(payload.id, buffer);
      }
      return;
    }

    if (message.topic === PushTopic.TerminalExit) {
      const payload = message.payload as TerminalExitPayload;
      const view = sessions.get(payload.id);
      if (!view) return;
      view.exited = true;
      view.tab.classList.add('is-exited');
      view.terminal.write(`\r\n\x1b[90m[процесс завершён, код ${payload.exitCode}]\x1b[0m\r\n`);
    }
  });

  /** Создать сессию и вернуть её id — он нужен, чтобы сразу отправить команду. */
  function createSession(): Promise<string | null> {
    if (creating) return creating;
    const task = openSession().finally(() => {
      creating = null;
    });
    creating = task;
    return task;
  }

  async function openSession(): Promise<string | null> {
    const container = h('div', { class: 'term-instance' });
    body.appendChild(container);

    const terminal = new Terminal({
      fontFamily: '"JetBrains Mono", "Fira Code", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 5000,
      theme: TERMINAL_THEMES[scheme],
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(container);
    fit.fit();

    try {
      const session = await deps.rpc.request('terminal.create', {
        cols: Math.max(terminal.cols, 20),
        rows: Math.max(terminal.rows, 5),
        cwd: deps.cwd() ?? undefined,
      });

      const tab = h(
        'button',
        { class: 'term-tab', type: 'button', title: `${session.shell} · ${session.cwd}` },
        session.title,
      );
      tab.addEventListener('click', () => activate(session.id));
      tab.addEventListener('auxclick', (event) => {
        if (event.button === 1) void closeSession(session.id);
      });

      const view: SessionView = { session, terminal, fit, container, tab, exited: false };
      sessions.set(session.id, view);
      tabsHost.appendChild(tab);

      terminal.onData((data) => {
        void deps.rpc.request('terminal.write', { id: session.id, data }).catch(() => undefined);
      });
      terminal.onResize(({ cols, rows }) => {
        void deps.rpc.request('terminal.resize', { id: session.id, cols, rows }).catch(() => undefined);
      });

      // Пока JetBrains Mono не загрузился, xterm измерил клетку по запасному
      // шрифту. Пересчитываем сетку, когда шрифт есть: иначе размеры терминала
      // в символах не совпадают с настоящими.
      void document.fonts.load('13px "JetBrains Mono"').then(() => {
        fit.fit();
        terminal.refresh(0, Math.max(terminal.rows - 1, 0));
      });

      for (const chunk of orphanData.get(session.id) ?? []) terminal.write(chunk);
      orphanData.delete(session.id);

      activate(session.id);
      terminal.focus();
      return session.id;
    } catch (error) {
      container.remove();
      terminal.dispose();
      showToast(error instanceof Error ? error.message : String(error), 'error');
      return null;
    }
  }

  function activate(id: string): void {
    const view = sessions.get(id);
    if (!view) return;
    activeId = id;

    for (const [key, item] of sessions) {
      item.container.hidden = key !== id;
      item.tab.classList.toggle('is-active', key === id);
    }

    fitSession(view);
    view.terminal.focus();
  }

  async function closeSession(id: string): Promise<void> {
    const view = sessions.get(id);
    if (!view) return;

    sessions.delete(id);
    view.tab.remove();
    view.terminal.dispose();
    view.container.remove();
    orphanData.delete(id);

    if (activeId === id) {
      const next = [...sessions.keys()].at(-1);
      activeId = null;
      if (next) activate(next);
    }

    await deps.rpc.request('terminal.kill', { id }).catch(() => undefined);
  }

  function fitSession(view: SessionView): void {
    // xterm не умеет измерять скрытый контейнер — размеры будут нулевыми.
    if (view.container.offsetWidth === 0 || view.container.offsetHeight === 0) return;
    try {
      view.fit.fit();
    } catch {
      // контейнер ещё не разложен — пересчитаем при следующем показе
    }
  }

  function active(): SessionView | null {
    return activeId ? (sessions.get(activeId) ?? null) : null;
  }

  function clearActive(): void {
    active()?.terminal.clear();
  }

  async function killActive(): Promise<void> {
    if (activeId) await closeSession(activeId);
  }

  const resizeObserver = new ResizeObserver(() => {
    const view = active();
    if (view && !view.exited) fitSession(view);
  });
  resizeObserver.observe(body);

  return {
    element,
    async open() {
      if (sessions.size === 0) await createSession();
      else {
        const view = active();
        if (view) fitSession(view);
      }
    },
    newSession: async () => {
      await createSession();
    },
    async run(command, title) {
      // Команда идёт в уже открытую оболочку, а не в новую вкладку: вкладка
      // создаётся только если терминала ещё нет. Панель показывает вызывающая
      // сторона — поэтому здесь никакой связи с доком.
      const current = active();
      const id = current && !current.exited ? current.session.id : await createSession();
      if (!id) return;

      const view = sessions.get(id);
      if (view && title) {
        // Имя вкладки — по запуску, как в PyCharm: видно, что это запуск, а не
        // свободная оболочка. Подсказка хранит саму команду, если она отличается
        // от имени (у задачи из package.json они совпадают).
        view.tab.textContent = title;
        view.tab.title = title === command ? title : `${title} · ${command}`;
        activate(id);
      }
      await deps.rpc.request('terminal.write', { id, data: `${command}\r` }).catch(() => undefined);
      view?.terminal.focus();
    },
    clearActive,
    killActive,
    fit() {
      const view = active();
      if (view) fitSession(view);
    },
    setScheme(next: Scheme) {
      scheme = next;
      for (const view of sessions.values()) view.terminal.options.theme = TERMINAL_THEMES[next];
    },
  };
}

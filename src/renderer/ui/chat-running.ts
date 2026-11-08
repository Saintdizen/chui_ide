import type { RunningSnapshot } from '../../shared/api';
import { h } from './dom';

/**
 * Полоса «что ещё идёт»: какие инструменты живут в main прямо сейчас.
 *
 * Зачем. «Стоп» гасит и инструменты, но человеку нужно видеть это до нажатия:
 * терминал, чтение или запись, оставшиеся после остановки ответа, — работа,
 * которая продолжает менять файлы молча.
 *
 * Окончательный источник правды — main (`ai.running`); полоса только рисует
 * снимок. Между опросами возраст считается по местным часам от `runningMs`,
 * чтобы цифра не прыгала, если ответ задержался.
 */

export interface ChatRunningDeps {
  /** Снимок того, что идёт. `null` — спросить не удалось. */
  snapshot: () => Promise<RunningSnapshot | null>;
  /** Остановить всё, что идёт в беседе. */
  abort: () => void;
  /**
   * Снять ОДИН инструмент, не гася прогон.
   *
   * Зачем отдельно от `abort`: зависший терминал — обычная беда, а гасить
   * из-за него весь ответ — терять остальную работу. Прогон получит отмену
   * инструмента как ошибку и пойдёт дальше.
   */
  abortTool?: (callId: string, name: string) => void;
  intervalMs?: number;
  /** Часы: подменяются в тестах, чтобы возраст был предсказуем. */
  now?: () => number;
}

export interface ChatRunningView {
  element: HTMLElement;
  /** Обновить сейчас, не дожидаясь тика. */
  refresh(): void;
  /** Опрашивать ли процесс: когда ничего не идёт, незачем. */
  follow(on: boolean): void;
  dispose(): void;
}

/** Сколько имён влезает в строку: длинный список не поместится. */
const MAX_NAMES = 3;

/** Возраст словами: «12 с», «1 мин 20 с». */
export function runningAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} с`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? `${minutes} мин` : `${minutes} мин ${rest} с`;
}

/** Строка полосы: «терминал, read · 12 с»; пустая — нечего показывать. */
export function runningLabel(snapshot: RunningSnapshot | null): string {
  if (!snapshot || snapshot.tools.length === 0) return '';
  const names = snapshot.tools.flatMap((entry) => entry.names);
  const head = names.slice(0, MAX_NAMES).join(', ');
  const tail = names.length > MAX_NAMES ? ` и ещё ${names.length - MAX_NAMES}` : '';
  const oldest = Math.max(...snapshot.tools.map((entry) => entry.runningMs));
  return `${head}${tail} · ${runningAge(oldest)}`;
}

export function createChatRunning(deps: ChatRunningDeps): ChatRunningView {
  const now = deps.now ?? Date.now;
  const intervalMs = deps.intervalMs ?? 1000;

  const label = h('span', { class: 'chat-running-label' });
  const stopButton = h(
    'button',
    {
      class: 'chat-running-stop',
      title: 'Остановить то, что ещё идёт',
      'aria-label': 'Остановить идущие инструменты',
      onclick: () => deps.abort(),
    },
    'остановить',
  );
  // Список поимённо: сводка «идёт 2 · 40 с» не говорит, что именно висит, а
  // гасить хочется конкретное. Отдельной строкой на каждый инструмент.
  const perTool = h('div', { class: 'chat-running-tools' });
  const element = h('div', { class: 'chat-running' }, label, perTool, stopButton);
  element.hidden = true;

  /** Последний снимок и момент, когда он пришёл: от него считается возраст. */
  let latest: { snapshot: RunningSnapshot; at: number } | null = null;
  let timer: number | null = null;
  let disposed = false;
  /** Пока идёт запрос, второй не начинается: опрос не должен плодить их пачкой. */
  let inFlight = false;

  function paint(): void {
    if (!latest) {
      element.hidden = true;
      return;
    }
    // Возраст растёт сам: снимок говорит, сколько шёл инструмент к моменту
    // ответа, а сколько прошло с тех пор — местные часы.
    const { snapshot, at } = latest;
    const grown: RunningSnapshot = {
      runs: snapshot.runs,
      tools: snapshot.tools.map((entry) => ({ ...entry, runningMs: entry.runningMs + (now() - at) })),
    };
    const text = runningLabel(grown);
    element.hidden = text === '';
    if (text) label.textContent = text;
    paintTools(snapshot);
  }

  /**
   * Список инструментов с крестиком у каждого. Дети пересоздаются только при
   * смене набора: перерисовка каждую секунду сбрасывала бы наведение и фокус
   * с кнопки, которую человек собирается нажать.
   */
  let shownKey = '';
  function paintTools(snapshot: RunningSnapshot): void {
    const entries = snapshot.tools.flatMap((run) =>
      run.names.map((name) => ({ callId: run.callId, name })),
    );
    const key = entries.map((entry) => `${entry.callId}:${entry.name}`).join('|');
    if (key === shownKey) return;
    shownKey = key;
    perTool.replaceChildren(
      ...entries.map((entry) =>
        h(
          'span',
          { class: 'chat-running-tool' },
          h('span', { class: 'chat-running-tool-name' }, entry.name),
          h(
            'button',
            {
              class: 'chat-running-tool-drop',
              type: 'button',
              title: `Снять «${entry.name}», не трогая остальное`,
              'aria-label': `Снять ${entry.name}`,
              onclick: () => deps.abortTool?.(entry.callId, entry.name),
            },
            '×',
          ),
        ),
      ),
    );
    perTool.hidden = entries.length === 0;
  }

  function refresh(): void {
    if (disposed || inFlight) return;
    inFlight = true;
    void deps
      .snapshot()
      .then((snapshot) => {
        if (disposed) return;
        latest = snapshot && snapshot.tools.length > 0 ? { snapshot, at: now() } : null;
        paint();
      })
      .catch(() => {
        // Спросить не удалось — это не повод показывать вчерашнее.
        latest = null;
        paint();
      })
      .finally(() => {
        inFlight = false;
      });
  }

  function follow(on: boolean): void {
    if (disposed) return;
    if (on && timer === null) {
      refresh();
      timer = window.setInterval(refresh, intervalMs);
    } else if (!on && timer !== null) {
      window.clearInterval(timer);
      timer = null;
      latest = null;
      paint();
    }
  }

  function dispose(): void {
    disposed = true;
    follow(false);
  }

  return { element, refresh, follow, dispose };
}

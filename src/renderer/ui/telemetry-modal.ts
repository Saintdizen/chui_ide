import type { AiTelemetrySnapshot } from '../../shared/api';
import { describeRecord, finishedLabel } from '../../shared/telemetry';
import type { RpcClient } from '../core/rpc';
import { clear, h } from './dom';
import { createModal } from './modal';

/**
 * Окно «Журнал прогонов»: последние прогоны агента из файла.
 *
 * Зачем отдельное окно, если есть «Прогон» под ответом? Тот живёт в памяти
 * беседы и пропадает с перезапуском, а вопрос «что было в инструкциях вчера,
 * когда модель начала звать не тот инструмент» задают на следующий день. Журнал
 * (`ai/telemetry`) лежит в файле, и здесь видно, что в нём есть сейчас.
 *
 * Окно ничего не пишет и не разбирает: строки собирает main, подписи — общие
 * (`shared/telemetry.ts`), так что окно и файл говорят одинаково.
 */
export interface TelemetryModalDeps {
  rpc: RpcClient;
  notify(message: string, kind?: 'info' | 'error'): void;
  /** Открыть папку с файлом в проводнике системы. */
  reveal(path: string): void;
}

export interface TelemetryModalView {
  element: HTMLElement;
  open(): Promise<void>;
  close(): void;
}

/** Сколько строк показывать: журнал — список последних прогонов, а не архив. */
const VISIBLE_RECORDS = 20;

export function createTelemetryModal(deps: TelemetryModalDeps): TelemetryModalView {
  const body = h('div', { class: 'telemetry-body' });
  const noteBox = h('p', { class: 'telemetry-note' });
  const listBox = h('div', { class: 'telemetry-list' });

  const revealButton = h(
    'button',
    { class: 'btn', type: 'button', onClick: () => (path ? deps.reveal(path) : undefined) },
    'Показать файл',
  );
  const clearButton = h('button', { class: 'btn', type: 'button', onClick: () => void wipe() }, 'Очистить журнал');
  // Действия окна — в подвале: тело растёт вместе со списком прогонов.
  const footer = h('footer', { class: 'modal-footer is-end' }, revealButton, clearButton);

  const modal = createModal({
    className: 'telemetry-modal',
    title: 'Журнал прогонов',
    headerIcon: 'clock',
    footer,
  });
  body.append(noteBox, listBox);
  modal.body.append(body);

  /** Путь к файлу журнала: нужен кнопке «Показать файл». */
  let path = '';
  let busy = false;

  async function wipe(): Promise<void> {
    if (busy) return;
    busy = true;
    try {
      await deps.rpc.request('ai.telemetryClear');
      deps.notify('Журнал прогонов очищен');
      await open();
    } catch (error) {
      deps.notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      busy = false;
    }
  }

  function render(snapshot: AiTelemetrySnapshot | null): void {
    clear(noteBox);
    clear(listBox);
    path = snapshot?.path ?? '';
    revealButton.disabled = !path;
    clearButton.disabled = !snapshot || snapshot.bytes === 0;

    if (!snapshot?.enabled) {
      noteBox.append(
        'Прогоны не записываются. Включить: Настройки → AI → «Писать журнал прогонов в файл». ' +
          'По умолчанию выключено: в записи лежат системные инструкции и ответы модели.',
      );
      return;
    }

    noteBox.append(
      'Файл: ' +
        (snapshot.path || 'ещё не создан') +
        ' · ' +
        sizeLabel(snapshot.bytes) +
        '. ' +
        'Ключи и пароли вычищаются при записи; файл лежит только на этой машине.',
    );

    if (snapshot.records.length === 0) {
      listBox.append(h('p', { class: 'telemetry-empty' }, 'Записей пока нет: прогон ещё не шёл.'));
      return;
    }

    for (const record of snapshot.records.slice(-VISIBLE_RECORDS)) {
      listBox.append(
        h(
          'div',
          { class: 'telemetry-row', title: record.project ?? '' },
          h('span', { class: 'telemetry-when' }, describeRecord(record)),
          h(
            'span',
            { class: 'telemetry-what' },
            finishedLabel(record.finished) +
              (record.system.goal ? ` · цель: ${record.system.goal}` : '') +
              (record.conversation ? ` · беседа ${record.conversation.slice(0, 8)}` : ''),
          ),
        ),
      );
    }
  }

  async function open(): Promise<void> {
    modal.open();
    render(null);
    try {
      const snapshot = await deps.rpc.request('ai.telemetry');
      render(snapshot);
    } catch (error) {
      deps.notify(error instanceof Error ? error.message : String(error), 'error');
    }
  }

  return {
    element: modal.element,
    open,
    close: () => modal.close(),
  };
}

/** Размер по-человечески: «пусто», «12 КБ», «1.4 МБ». */
function sizeLabel(bytes: number): string {
  if (bytes <= 0) return 'журнал пуст';
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / 1024 / 1024).toFixed(1)} МБ`;
}

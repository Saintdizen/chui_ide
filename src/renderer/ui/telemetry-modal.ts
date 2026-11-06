import type { AiTelemetrySnapshot } from '../../shared/api';
import { digestLine, digestRuns } from '../../shared/run-digest';
import { describeRecord, finishedLabel } from '../../shared/telemetry';
import type { RpcClient } from '../core/rpc';
import { clear, h } from './dom';
import { createModal } from './modal';
import { errorText } from '../core/file-errors';

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
/** Сколько бесед показать сводкой: больше — уже лента записей под ней. */
const VISIBLE_DIGESTS = 5;

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
      deps.notify(errorText(error), 'error');
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

    // Сводка по беседам — над лентой записей. Записи отвечают «что было»,
    // сводка — «сколько это стоило и что в этом сломалось»; человек приходит
    // именно за вторым, а складывать токены по строкам глазами — работа машины.
    const digests = digestRuns(snapshot.records);
    const worst = digests.slice(0, VISIBLE_DIGESTS);
    if (worst.length > 0) {
      const box = h('div', { class: 'telemetry-digests' });
      for (const digest of worst) {
        const failures = digest.failures.reduce((sum, item) => sum + item.count, 0);
        box.append(
          h(
            'div',
            { class: `telemetry-digest${failures > 0 ? ' has-failures' : ''}` },
            h('span', { class: 'telemetry-digest-line' }, digestLine(digest)),
            digest.failures.length > 0
              ? h(
                  'span',
                  {
                    class: 'telemetry-digest-why',
                    title: digest.failures.map((f) => `${f.tool}: ${f.why}`).join('\n'),
                  },
                  digest.failures
                    .slice(0, 3)
                    .map((f) => `${f.tool}: ${f.why}${f.count > 1 ? ` ×${f.count}` : ''}`)
                    .join(' · '),
                )
              : null,
          ),
        );
      }
      listBox.append(box);
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
      deps.notify(errorText(error), 'error');
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

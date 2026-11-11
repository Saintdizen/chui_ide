import type { ChatExportFormat } from '../../shared/chat-export';
import type { PopupMenuItem } from './popup-menu';

/**
 * План меню вкладки беседы (TASKS 9) — чистая, поэтому проверяема.
 *
 * Живёт отдельно от `chat.ts`: там DOM и 4.8k строк, и импорт ради одной
 * функции тянул в покрытие весь файл, топя общий процент.
 *
 * Было три пункта подряд без единого разделителя: два экспорта-близнеца и
 * закрытие стояли вплотную, подменю не было ни одного. Теперь вывод — в
 * подменю «Экспорт» (два формата одного действия), затем отдельно закрытие:
 * одну, другие, все — последствия разные, и места им по группе.
 *
 * `enabled: false`, а не исчезающие пункты: нулевой пункт двигал бы остальные
 * под курсором ровно в момент клика.
 */
export function chatTabMenuPlan(
  state: { empty: boolean; others: boolean },
  actions: {
    exportAs(format: ChatExportFormat): void;
    close(): void;
    closeOthers(): void;
    closeAll(): void;
  },
): PopupMenuItem[] {
  return [
    {
      label: 'Экспорт',
      enabled: !state.empty,
      submenu: [
        { label: 'В Markdown…', onSelect: () => actions.exportAs('markdown') },
        { label: 'В JSON…', onSelect: () => actions.exportAs('json') },
      ],
    },
    { separator: true },
    { label: 'Закрыть беседу', onSelect: () => actions.close() },
    { label: 'Закрыть другие беседы', enabled: state.others, onSelect: () => actions.closeOthers() },
    { label: 'Закрыть все беседы', enabled: state.others, onSelect: () => actions.closeAll() },
  ];
}

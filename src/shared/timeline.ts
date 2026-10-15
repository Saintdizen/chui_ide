/**
 * Лента версий файла: локальные снимки и коммиты git ВМЕСТЕ.
 *
 * Было две отдельные истории, и это неудобно ровно в тот момент, когда они нужны
 * обе: «что было до моей правки» — это и снимок редактора (сохранение минуту
 * назад), и коммит (вчера, когда ветку начинали). Смотреть их в двух окнах и
 * сопоставлять на глаз — работа, которую может сделать машина.
 *
 * Здесь — сведение двух списков в один, отсортированный по времени (новое сверху).
 * Модуль чистый: обе истории уже собраны (renderer зовёт `history.list` и
 * `git.log`), а тут только порядок, подписи и признак источника. Поэтому поведение
 * видно в тестах, без ФС, окна и git.
 *
 * Что не смешивается: локальный снимок — это ТЕКСТ, который можно вернуть в файл,
 * а коммит — состояние, которое смотрят сравнением. Поэтому запись ленты несёт
 * источник, и действия у них разные (см. `ui/history-modal.ts`).
 */

import type { GitCommit } from './api';
import { describeAge, formatClock, historyEntryLabel, type HistoryEntry } from './file-history';

/** Откуда запись: снимок редактора или коммит git. */
export type TimelineSource = 'local' | 'git';

/** Запись ленты: общая форма для снимка и коммита. */
export interface TimelineItem {
  source: TimelineSource;
  /** Ключ записи: id снимка или хеш коммита. */
  id: string;
  /** Время записи, миллисекунды эпохи. */
  at: number;
  /** Основная подпись строки. */
  title: string;
  /** Подробности: время, возраст, размер — вторым планом. */
  detail: string;
  /** Снимок: его текст можно вернуть в файл. */
  entry?: HistoryEntry;
  /** Коммит: с ним сравнивают текущий файл. */
  hash?: string;
}

/** Дата коммита `ГГГГ-ММ-ДД` в миллисекунды: полночь местного времени. */
export function commitDateToMs(date: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date.trim());
  if (!match) return 0;
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day)).getTime();
}

/**
 * Свести снимки и коммиты в одну ленту. Порядок — по времени, новое сверху; при
 * равном времени (коммит дня и снимок того же дня) первым идёт снимок: он точнее
 * по времени и обычно важнее для возврата.
 *
 * `nowMs` нужен для подписи «сколько назад» — время приходит аргументом, чтобы
 * поведение было повторяемым.
 */
export function mergeTimeline(
  snapshots: readonly HistoryEntry[],
  commits: readonly GitCommit[],
  nowMs: number = Date.now(),
): TimelineItem[] {
  const items: TimelineItem[] = snapshots.map((entry) => ({
    source: 'local',
    id: entry.id,
    at: entry.mtimeMs,
    title: `${formatClock(entry.mtimeMs)} · снимок редактора`,
    detail: historyEntryLabel(entry, nowMs),
    entry,
  }));

  for (const commit of commits) {
    // Время коммита берём точное, если main его отдал; иначе — дата (полночь дня).
    const at = commit.at && Number.isFinite(commit.at) ? commit.at : commitDateToMs(commit.date);
    items.push({
      source: 'git',
      id: commit.hash,
      at,
      title: `${commit.hash} · ${commit.summary}`,
      detail: [commit.date, commit.author, at ? describeAge(at, nowMs) : ''].filter(Boolean).join(' · '),
      hash: commit.hash,
    });
  }

  return items.sort((left, right) => {
    if (right.at !== left.at) return right.at - left.at;
    // Равное время — снимок выше: он про этот файл прямо сейчас.
    if (left.source !== right.source) return left.source === 'local' ? -1 : 1;
    return right.title.localeCompare(left.title);
  });
}

/** Сколько записей каждого источника — для строки-сводки над лентой. */
export function timelineSummary(items: readonly TimelineItem[]): string {
  const local = items.filter((item) => item.source === 'local').length;
  const git = items.length - local;
  const parts: string[] = [];
  if (local > 0) parts.push(`снимков: ${local}`);
  if (git > 0) parts.push(`коммитов: ${git}`);
  return parts.join(' · ') || 'записей нет';
}

/** Что можно сделать с записью — разные действия у снимка и коммита. */
export function timelineActionLabel(item: TimelineItem): string {
  return item.source === 'git' ? 'Показать различие с коммитом' : 'Вернуть эту версию';
}

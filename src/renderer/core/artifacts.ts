/**
 * Артефакты прогона: файлы, которые агент предъявил человеку (`presented`).
 *
 * В ленте такая карточка живёт один шаг: пролистал — и следа нет. А нужна она
 * после прогона: «что агент сделал» — это именно эти файлы. Поэтому карточка
 * остаётся в ленте как была, а панель артефактов держит постоянный список.
 *
 * Список живёт в памяти окна: он про этот разговор, а не про проект, и на диск
 * не едет. Очистка — с очисткой беседы, иначе чужой прогон примешался бы к новому.
 */

export interface RunArtifact {
  path: string;
  /** Строка, ради которой файл предъявили: «план», «отчёт тестов». */
  note: string;
  /** Когда предъявили: свежие сверху, но не пересортировываются каждым шагом. */
  at: number;
}

export interface RunArtifacts {
  add(items: readonly { path: string; note?: string }[]): void;
  /** Показать список другой беседы: при переключении вкладки он свой. */
  set(items: readonly RunArtifact[]): void;
  list(): readonly RunArtifact[];
  clear(): void;
  /** Подписка для панели: список меняется на каждом шаге агента. */
  onChange(listener: () => void): () => void;
}

/** Больше сорока — это уже не «что сделал прогон», а свалка файлов. */
export const MAX_RUN_ARTIFACTS = 40;

export function createRunArtifacts(now: () => number = () => Date.now()): RunArtifacts {
  let items: RunArtifact[] = [];
  const listeners = new Set<() => void>();

  const notify = (): void => {
    for (const listener of listeners) listener();
  };

  return {
    add(incoming) {
      const at = now();
      for (const item of incoming) {
        const path = item.path.trim();
        if (!path) continue;
        const note = (item.note ?? '').trim();
        // Тот же файл второй раз — не дубль в списке, а «предъявлен снова»:
        // поднимаем наверх и обновляем подпись.
        items = [{ path, note, at }, ...items.filter((other) => other.path !== path)].slice(0, MAX_RUN_ARTIFACTS);
      }
      notify();
    },
    list: () => items,
    set(next) {
      const same =
        next.length === items.length &&
        next.every((item, at) => item.path === items[at]?.path && item.note === items[at]?.note);
      if (same) return;
      items = [...next];
      notify();
    },
    clear() {
      if (items.length === 0) return;
      items = [];
      notify();
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

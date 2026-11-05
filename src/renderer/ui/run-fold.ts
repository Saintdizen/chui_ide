/**
 * Раскрытие ленты прогона как одно состояние, а не дело каждой группы.
 *
 * Зачем отдельно от DOM. Группы действий создаются по мере прихода вызовов:
 * пока прогон идёт, их число растёт. «Свернуть всё» не может обойти DOM и
 * расставить `hidden` — группа, созданная через секунду, снова окажется
 * свёрнутой по своему правилу, и кнопка перестанет быть правдой. Поэтому
 * живёт режим, а группа при создании спрашивает его; и новый режим
 * применяется ко всем, кто уже есть.
 *
 * Значений ровно три, и среднее — не «ни то ни другое»:
 * - `auto` — как задумано: группа свёрнута, шапка одна строка. По умолчанию.
 * - `expanded` — «развернуть всё»: каждый вызов виден целиком.
 * - `collapsed` — «свернуть всё, кроме ответа»: группы закрыты даже после
 *   того, как человек раскрыл одну руками. Это явное указание, и следующая
 *   созданная группа обязана ему подчиниться.
 *
 * Раскрытие одной группы руками НЕ трогает режим: частное не должно
 * переписывать общее. Иначе развернул один вызов — и «свернуть всё» уже врёт.
 */
export type RunFoldMode = 'auto' | 'expanded' | 'collapsed';

export interface RunFold {
  /** Что показывать группе при её создании. */
  mode(): RunFoldMode;
  /**
   * Переключить режим по кругу. Возвращает новый.
   *
   * Порядок именно такой: `auto` → `collapsed` → `expanded` → `auto`.
   * Первый щелчок должен СВОРАЧИВАТЬ: лента по умолчанию и так свёрнута, но
   * человек, дотянувшийся до кнопки, обычно хочет именно убрать лишнее, а не
   * показать его. Обратный порядок заставлял бы щёлкать дважды впустую.
   */
  cycle(): RunFoldMode;
  /** Подписка: режим сменился — применить к существующим группам. */
  onChange(listener: (mode: RunFoldMode) => void): () => void;
}

const ORDER: readonly RunFoldMode[] = ['auto', 'collapsed', 'expanded'];

/** Подпись кнопки для режима: что произойдёт по клику, а не что сейчас. */
export function nextFoldLabel(mode: RunFoldMode): string {
  switch (mode) {
    case 'auto':
      return 'Свернуть всё, кроме ответа';
    case 'collapsed':
      return 'Развернуть все действия';
    case 'expanded':
      return 'Вернуть обычный вид';
  }
}

/** Значок кнопки: он показывает действие, а не состояние — как подпись. */
export function nextFoldIcon(mode: RunFoldMode): 'chevronUp' | 'chevronDown' | 'chevronsUp' {
  switch (mode) {
    case 'auto':
      return 'chevronsUp';
    case 'collapsed':
      return 'chevronDown';
    case 'expanded':
      return 'chevronUp';
  }
}

export function createRunFold(initial: RunFoldMode = 'auto'): RunFold {
  let mode: RunFoldMode = initial;
  const listeners = new Set<(mode: RunFoldMode) => void>();

  return {
    mode: () => mode,
    cycle: () => {
      const at = ORDER.indexOf(mode);
      mode = ORDER[(at + 1) % ORDER.length] ?? 'auto';
      for (const listener of listeners) listener(mode);
      return mode;
    },
    onChange: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

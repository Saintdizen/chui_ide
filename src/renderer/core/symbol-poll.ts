/**
 * Опрос сборки карты символов.
 *
 * Карту собирает main в фоне, а окну известен только итог опроса. Пока сборка идёт
 * (`warming`), спрашивать надо повторно; как только карта готова — прекратить.
 * Раньше этот цикл жил прямо в `app.ts` вперемешку с RPC и статусбаром, и проверить
 * главное — «ровно один таймер, и он гаснет на готовой карте» — было нельзя.
 *
 * Здесь только расписание: как спросить и куда положить ответ, решает окно.
 */

/** Состояние из `index.status`, в котором интересен только фазовый признак. */
export interface SymbolPollStatus {
  phase: string;
}

export interface SymbolPollOptions {
  /** Опросить карту один раз. Ошибка опроса прекращает цикл — молча. */
  request: () => Promise<SymbolPollStatus>;
  /** Показать ответ: вызывается на каждый удачный опрос, включая последний. */
  show: (status: SymbolPollStatus) => void;
  /** Пауза между опросами, мс. */
  intervalMs: number;
  /** Таймеры — вставляются для проверок. */
  setTimer?: (fn: () => void, ms: number) => number;
  clearTimer?: (id: number) => void;
}

export interface SymbolPoller {
  /** Спросить сейчас и, если сборка идёт, назначить следующий опрос. */
  poll: () => void;
  /** Идёт ли опрос — для проверок и для «замри перед закрытием». */
  polling: () => boolean;
  /** Замолчать: таймер снят, следующий `poll` начнёт заново. */
  stop: () => void;
}

export function createSymbolPoller(options: SymbolPollOptions): SymbolPoller {
  const setTimer = options.setTimer ?? ((fn, ms) => window.setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((id) => window.clearTimeout(id));
  let timer: number | null = null;

  const stop = (): void => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };

  const poll = (): void => {
    void options
      .request()
      .then((status) => {
        options.show(status);
        // Карта готова — молчим и снимаем таймер: сборка кончилась.
        if (status.phase !== 'warming') {
          stop();
          return;
        }
        // Ответ пришёл, пока таймер уже назначен, — второй не заводим, иначе сборка
        // породит две параллельные цепочки опросов.
        if (timer !== null) return;
        timer = setTimer(() => {
          timer = null;
          poll();
        }, options.intervalMs);
      })
      // Опрос не удался (окно закрывается, main не отвечает) — цикл не держим.
      .catch(() => stop());
  };

  return { poll, polling: () => timer !== null, stop };
}

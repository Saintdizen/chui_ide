import { InterjectQueue } from './interject';
import { PauseGate } from './pause';

/**
 * Управление прогонами по отдельности: у каждого своя пауза и своя очередь
 * сказанного на ходу.
 *
 * Раньше и то и другое было одно на сервис. Пока прогон один — правильно, просто
 * и без вопросов. Как только бесед две, общая пауза становится багом: человек
 * жмёт «пауза» во второй задаче, а встаёт та, что работает в фоне, или обе сразу.
 * Сказанное на ходу уезжает не в тот разговор — и человек этого не видит, пока
 * модель не отреагирует на чужое замечание.
 *
 * Ключ — беседа, а не сессия окна: он приходит вместе с запросом
 * (`ChatRequest.conversationUid`) и с паузой (`ai.setPaused`), поэтому обе
 * стороны говорят об одном и том же прогоне.
 */
export interface RunEntry {
  readonly pause: PauseGate;
  readonly interject: InterjectQueue;
}

/** Пустой ключ — законное имя: старые вызовы без беседы продолжают работать. */
export const DEFAULT_RUN = 'default';

/**
 * Сколько прогонов держим в памяти. Больше одновременно не запускают руками,
 * а записи брошенных прогонов надо чем-то ограничивать: ключи приходят
 * снаружи и могут копиться.
 */
const MAX_RUNS = 8;

export class RunControls {
  /** Порядок — от старых к новым: при переполнении уходит самый старый. */
  private readonly runs = new Map<string, RunEntry>();

  /** Ключ прогона из того, что прислала сторона окна. */
  static key(conversation: string | null | undefined): string {
    const trimmed = (conversation ?? '').trim();
    return trimmed.length > 0 ? trimmed : DEFAULT_RUN;
  }

  /**
   * Прогон начинается: с этой минуты его слушают.
   *
   * Одна и та же беседа может быть запущена повторно — тогда старая запись
   * обнуляется, а не наследуется: сказанное прошлому прогону не адресовано
   * этому.
   */
  open(conversation: string | null | undefined): RunEntry {
    const key = RunControls.key(conversation);
    const existing = this.runs.get(key);
    if (!existing) {
      const entry = this.replace(key);
      entry.interject.open();
      return entry;
    }
    // Пауза, нажатая ровно в момент старта, не должна потеряться: запись
    // переживает `open`, обнуляется только очередь сказанного.
    this.runs.delete(key);
    this.runs.set(key, existing);
    existing.interject.open();
    return existing;
  }

  /** Прогон кончился — по любому исходу. Запись убираем, чтобы не текла. */
  close(conversation: string | null | undefined): void {
    const key = RunControls.key(conversation);
    const entry = this.runs.get(key);
    entry?.interject.close();
    entry?.pause.set(false);
    this.runs.delete(key);
  }

  /**
   * Пауза прогона. Снимается без прогона молча: человек мог нажать «продолжить»
   * уже после того, как ответ пришёл сам.
   */
  setPaused(conversation: string | null | undefined, value: boolean): void {
    const key = RunControls.key(conversation);
    const entry = this.runs.get(key);
    if (!entry) {
      // Ставим паузу заранее — не беда: запись живёт до начала прогона, а
      // `open` её обнулит. Иначе пауза, нажатая в момент старта, потерялась бы.
      if (!value) return;
      this.replace(key).pause.set(true);
      return;
    }
    entry.pause.set(value);
  }

  /**
   * Запись прогона. Нет записи — создаём: прогон, который ещё не открылся,
   * тоже имеет право на паузу (её поставят заранее), а очередь скажет «некуда».
   */
  entry(conversation: string | null | undefined): RunEntry {
    const key = RunControls.key(conversation);
    return this.runs.get(key) ?? this.replace(key);
  }

  /** Сказать что-то одному прогону. Ложь — если его нет или он уже кончился. */
  interject(conversation: string | null | undefined, text: string): boolean {
    return this.runs.get(RunControls.key(conversation))?.interject.push(text) ?? false;
  }

  /** Сколько сказанного ждёт границы шага у этого прогона. */
  pending(conversation: string | null | undefined): number {
    return this.runs.get(RunControls.key(conversation))?.interject.size ?? 0;
  }

  /** Сколько прогонов сейчас в памяти. Нужно тестам и проверке утечки. */
  get size(): number {
    return this.runs.size;
  }

  private replace(key: string): RunEntry {
    const entry: RunEntry = { pause: new PauseGate(), interject: new InterjectQueue() };
    // Переустановка возвращает запись в конец очереди — она самая свежая.
    this.runs.delete(key);
    this.runs.set(key, entry);
    while (this.runs.size > MAX_RUNS) {
      const oldest = this.runs.keys().next();
      if (oldest.done) break;
      this.runs.delete(oldest.value);
    }
    return entry;
  }
}

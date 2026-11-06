/**
 * Один канал на одно событие.
 *
 * Беда, которую это лечит: одна и та же ошибка всплывает тостом, висит в
 * статус-баре и ждёт в панели «Проблемы». Человек видит три сообщения об
 * одном, а если ошибка повторяется в цикле (переподключение LSP, обрыв сети) —
 * тост перекрывает тост и читать нечего вовсе.
 *
 * Устройство:
 *   • у уведомления есть КЛЮЧ (`lsp:typescript:crash`) — по нему и склеиваем;
 *   • повтор поднимает старое и увеличивает счётчик, а не плодит новое;
 *   • группа глушится целиком («не беспокоить» для `git`), история при этом
 *     продолжает писаться — человек вернётся к ней, когда захочет;
 *   • история одна на всё: она и есть список «что было, пока я смотрел в код».
 *
 * Модуль чистый: ни DOM, ни таймеров. Кто показывает — решает вызывающий.
 */

export type NoticeKind = 'info' | 'error' | 'success';

/**
 * Шаг, который уведомление предлагает: «Показать», «Переподключиться».
 *
 * Дефект, который это лечит: `label` был, `command` был, а ИСПОЛНИТЬ запись
 * из истории было нечем — у неё нет ссылки на реестр команд, да и не должно
 * быть. Теперь запись несёт свою функцию, и история ведёт туда же, куда
 * вела кнопка в тосте.
 */
export interface NoticeAction {
  label: string;
  command: string;
  args?: unknown[];
  /** Исполнить шаг. Необязателен: чистая запись годится и без него. */
  run?: () => void;
}

export interface NoticeInput {
  /** Устойчивый ключ события: `группа:что`. Повтор с этим ключом склеивается. */
  key: string;
  text: string;
  kind?: NoticeKind;
  /** Группа для «не беспокоить»: по умолчанию часть ключа до двоеточия. */
  group?: string;
  action?: NoticeAction;
  /**
   * Куда смотреть человеку, когда тост уже ушёл. Отказ без этого — это «Опять не
   * работает»: текст есть, а куда идти — не сказано.
   */
  source?: NoticeSource;
}

/**
 * «Где это чинится» — подсказка у отказа.
 *
 * Не ссылка на код: у отказа провайдера причина в настройке, у отказа LSP — в
 * журнале сервера. Одно поле на всё, потому что человеку в момент ошибки нужен
 * ответ «куда идти», а не классификация.
 */
export interface NoticeSource {
  /** Место в человеческих словах: «Настройки → AI → Ключ». */
  where: string;
  /** Окно или панель, которую откроет шаг «Куда смотреть», если оно есть. */
  command?: string;
  args?: unknown[];
}

export interface Notice {
  key: string;
  text: string;
  kind: NoticeKind;
  group: string;
  action: NoticeAction | null;
  /** Сколько раз пришло с одним ключом. 1 — первый раз. */
  count: number;
  /** Когда появилось впервые (мс): для подписи «5 минут назад». */
  firstAt: number;
  /** Последний раз. */
  lastAt: number;
  /** Где это чинится — подсказка у отказа. */
  source: NoticeSource | null;
  /** Человек видел это уведомление (закрыл тост или открыл модалку). */
  seen: boolean;
}

/** Сколько помним: журнал нужен, чтобы посмотреть вчерашнее, не больше. */
const HISTORY_LIMIT = 200;

/** Что должно произойти после `push`. */
export interface NoticeOutcome {
  /** Показать тост сейчас. `false` — группа приглушена или это повтор. */
  toast: boolean;
  /** Уведомление после обработки — со счётчиком и свежим `lastAt`. */
  notice: Notice;
  /** Это повтор: вызывающий обновит уже висящий тост, а не добавит второй. */
  repeat: boolean;
}

export class NoticeRegistry {
  private readonly items: Notice[] = [];
  private readonly muted = new Set<string>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /**
   * Принять уведомление.
   *
   * Группа по умолчанию — часть ключа до двоеточия. Это не украшение: LSP, git
   * и чат шлют много уведомлений, и «не беспокоить» имеет смысл именно группой,
   * а не по одному ключу.
   */
  push(input: NoticeInput): NoticeOutcome {
    const group = input.group ?? input.key.split(':')[0] ?? input.key;
    const at = this.now();
    const existing = this.items.find((item) => item.key === input.key);

    if (existing) {
      existing.count += 1;
      existing.lastAt = at;
      existing.text = input.text;
      existing.kind = input.kind ?? existing.kind;
      // Источник обновляем только когда он известен: повтор без подсказки не должен
      // стирать ту, что уже была.
      if (input.source) existing.source = input.source;
      // Повтор возвращает уведомление в начало журнала: он снова актуален.
      this.items.splice(this.items.indexOf(existing), 1);
      this.items.unshift(existing);
      const toast = !this.muted.has(group);
      if (toast) existing.seen = false;
      return { toast, notice: existing, repeat: true };
    }

    const notice: Notice = {
      key: input.key,
      text: input.text,
      kind: input.kind ?? 'info',
      group,
      action: input.action ?? null,
      source: input.source ?? null,
      count: 1,
      firstAt: at,
      lastAt: at,
      seen: false,
    };
    this.items.unshift(notice);
    if (this.items.length > HISTORY_LIMIT) this.items.length = HISTORY_LIMIT;
    // Приглушённое в историю пишем, но тостом не показываем — иначе «не
    // беспокоить» означало бы «не помнить», и человек терял бы следы.
    return { toast: !this.muted.has(group), notice, repeat: false };
  }

  /** Заглушить группу (`true`) или вернуть (`false`). */
  mute(group: string, on = true): void {
    if (on) this.muted.add(group);
    else this.muted.delete(group);
  }

  isMuted(group: string): boolean {
    return this.muted.has(group);
  }

  mutedGroups(): string[] {
    return [...this.muted].sort();
  }

  /** Пометить прочитанным — тостом или в открытой модалке. */
  markSeen(key: string): void {
    const found = this.items.find((item) => item.key === key);
    if (found) found.seen = true;
  }

  markAllSeen(): void {
    for (const item of this.items) item.seen = true;
  }

  /** История: свежее сверху; по умолчанию — всё, не только непрочитанное. */
  history(options: { unreadOnly?: boolean; group?: string } = {}): Notice[] {
    return this.items.filter((item) => {
      if (options.unreadOnly && item.seen) return false;
      if (options.group !== undefined && item.group !== options.group) return false;
      return true;
    });
  }

  unreadCount(): number {
    return this.items.reduce((sum, item) => sum + (item.seen ? 0 : 1), 0);
  }

  /** Убрать всё: «очистить журнал». */
  clear(): void {
    this.items.length = 0;
  }
}

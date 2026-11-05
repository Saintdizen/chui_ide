import { h, svgIcon, type IconName } from './dom';
import { OCCLUDERS } from './occluders';
import { type NoticeAction, NoticeRegistry } from '../core/notice-registry';

export type ToastKind = 'info' | 'error' | 'success';

/**
 * Кнопка в уведомлении: короткий глагол и то, КУДА он ведёт.
 *
 * Было: только `run` — произвольное замыкание. Из-за этого тост не мог быть
 * ничем, кроме «закрыть себя»: журнал уведомлений его не помнил, и «Показать»
 * из истории было выразить нечем. Теперь главный способ — команда: у неё есть
 * имя, по ней можно проверить `isEnabled`, и она переживает запись в историю.
 * `run` остаётся для мелочей вроде «открыть это окно настроек», где команды нет.
 */
export interface ToastAction {
  label: string;
  /** Команда реестра — предпочтительный способ: её видно и можно повторить. */
  command?: string;
  args?: unknown[];
  /** Запасной путь, когда команды нет; при `command` не вызывается. */
  run?: () => void | Promise<void>;
}

export interface ToastOptions {
  /** Кнопка действия — например «Отменить»: возвращает только что сделанное. */
  action?: ToastAction;
  /**
   * Ключ уведомления: одно событие — один тост.
   *
   * Без ключа каждый вызов рисует свой тост, и повтор в цикле (LSP отвечает на
   * каждое сохранение, git — на каждый файл) засыпает экран одинаковыми
   * строками. С ключом повтор поднимает уже висящий тост и увеличивает счётчик,
   * а группа до двоеточия глушится целиком (`registry.mute('lsp')`).
   */
  key?: string;
  /**
   * Кто исполняет `action.command`. Без этого команда из тоста — мёртвый текст:
   * `toast.ts` не знает про реестр команд и знать не должен.
   */
  execute?: (command: string, args?: unknown[]) => void;
}

let container: HTMLElement | null = null;

/** Значок по роли уведомления: успех — галочка, ошибка — предупреждение, прочее — «искра». */
const TOAST_ICON: Record<ToastKind, IconName> = {
  info: 'sparkle',
  error: 'warning',
  success: 'check',
};

/** Одноразовые уведомления в правом нижнем углу — самый дешёвый способ показать ошибку. */
/**
 * Журнал уведомлений: пока тосты — это только то, что видно сейчас. Реестр
 * помнит историю, счётчики повторов и приглушённые группы.
 */
export const notices = new NoticeRegistry();

/**
 * Тост-действие → действие журнала. `run` намеренно не передаётся: замыкание
 * живёт до перезагрузки окна, а запись в истории — дольше, и хранить в ней
 * функцию значило бы обещать возврат туда, куда вернуться нечем. Для истории
 * годится только то, у чего есть имя — команда.
 */
function toNoticeAction(action: ToastAction | undefined): NoticeAction | undefined {
  if (!action?.command) return undefined;
  return { label: action.label, command: action.command, args: action.args };
}

export function showToast(message: string, kind: ToastKind = 'info', options: ToastOptions = {}): void {
  // Ключ задан — спрашиваем реестр, показывать ли. Без ключа поведение прежнее:
  // у большинства сообщений ключ не нужен, они и так уникальны.
  let text = message;
  if (options.key) {
    const outcome = notices.push({
      key: options.key,
      text: message,
      kind,
      // Журнал помнит, куда вёл тост: иначе «Показать» из истории было бы
      // надписью без адреса — самая частая причина «кнопка не работает».
      action: toNoticeAction(options.action),
    });
    // Группа приглушена — не показываем, но в историю уже записали.
    if (!outcome.toast) return;
    // Повтор: не второй тост, а тот же со счётчиком. Иначе пачка одинаковых
    // строк закрывает собой всё, что человек читает.
    if (outcome.repeat && outcome.notice.count > 1) text = `${message} (×${outcome.notice.count})`;
  }

  if (!container) {
    // Область живёт всё время: читалка замечает подмену содержимого только у того
    // узла, который уже был в документе, — на созданном «в момент события» она молчит.
    container = h('div', { class: 'toasts', role: 'region', 'aria-live': 'polite', 'aria-label': 'Уведомления' });
    document.body.appendChild(container);
    bindEscape();
  }

  const action = options.action;
  // Одна точка исполнения на кнопку и на клик по сообщению. Команда идёт
  // через реестр (её видно в палитре, у неё есть isEnabled), замыкание —
  // запасной путь для мест, где команды нет.
  const runAction = (): void => {
    if (action?.command) options.execute?.(action.command, action.args);
    else if (action?.run) void action.run();
  };
  const toast = h(
    'div',
    {
      // `is-actionable` — единственный признак «на меня можно нажать»: по нему
      // CSS даёт курсор-руку, и его же доля `Escape`/пауза ниже.
      class: action ? `toast toast-${kind} is-actionable` : `toast toast-${kind}`,
      // Подсказка — только когда действие НАСТОЯЩЕЕ. Было `title` у любой
      // плашки, и тост без действия обещал кнопку, которой нет.
      ...(action ? { title: action.label } : {}),
      // Ошибку объявляем сразу (это важное), остальное — когда читалка дойдёт.
      role: kind === 'error' ? 'alert' : 'status',
    },
    svgIcon(TOAST_ICON[kind], 14),
    h('span', { class: 'toast-text' }, text),
    // Кнопка — настоящий `<button>`: берётся фокусом с клавиатуры, а её клик
    // не закрывает уведомление (иначе «Отменить» не успело бы выполниться).
    action &&
      h(
        'button',
        {
          type: 'button',
          class: 'toast-action',
          onclick: (event: Event) => {
            event.stopPropagation();
            toast.remove();
            runAction();
          },
        },
        action.label,
      ),
  );

  toast.addEventListener('click', () => {
    // Клик по сообщению — тот же прыжок, что и кнопка: у ошибки «Показать»
    // и есть единственное осмысленное действие. Тост всё равно закрываем:
    // увести человека в журнал и оставить висеть над ним плашку — лишнее.
    if (action) runAction();
    toast.remove();
  });
  container.appendChild(toast);

  // Тост с действием живёт дольше: за обычные 4 секунды человек не успеет
  // передумать и нажать «Отменить».
  const life = action ? 8000 : kind === 'error' ? 8000 : 4000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let remaining = life;
  let startedAt = 0;

  const dismiss = (): void => {
    toast.classList.add('is-leaving');
    setTimeout(() => toast.remove(), 220);
  };
  const start = (): void => {
    if (timer !== null) return;
    startedAt = Date.now();
    timer = setTimeout(dismiss, remaining);
  };
  // Пауза, пока на плашку смотрят или целятся мышью: иначе текст уезжает
  // ровно в тот момент, когда его дочитывают, а кнопку не нажать.
  const pause = (): void => {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    remaining -= Date.now() - startedAt;
    if (remaining < 800) remaining = 800;
  };

  toast.addEventListener('mouseenter', pause);
  toast.addEventListener('mouseleave', start);
  toast.addEventListener('focusin', pause);
  toast.addEventListener('focusout', start);
  start();
}

/**
 * «Убрать с глаз» без мыши: Esc гасит последнее уведомление.
 *
 * Тост не берёт фокус на себя и не встаёт в очередь событий — слушатель на
 * `window` в фазе перехвата смотрит только на клавишу и никогда не
 * `preventDefault`. Иначе ошибка, вылетевшая во время набора, съедала бы Esc у
 * меню и пикеров, и «закрыть всплывающее» перестало бы работать.
 */
let escapeBound = false;
function bindEscape(): void {
  if (escapeBound) return;
  escapeBound = true;
  window.addEventListener(
    'keydown',
    (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Что-то открыто поверх (меню, попап, окно) — тогда Esc его, не наш.
      // Список берём тот же, что и страница браузера в сцене: разбирать «кто
      // там сверху» по каждому окну — значит забывать новые попапы по одному.
      if (document.querySelector(OCCLUDERS)) return;
      const last = container?.querySelector<HTMLElement>('.toast:not(.is-leaving)');
      if (!last) return;
      event.preventDefault();
      last.classList.add('is-leaving');
      setTimeout(() => last.remove(), 220);
    },
    // Перехват: раньше обработчиков на полях ввода. Предотвращение — только
    // когда тост и правда убран, поэтому набор не страдает.
    { capture: true },
  );
}

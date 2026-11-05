/**
 * Что делает клавиша, нажатая в поле ввода, когда идёт прогон.
 *
 * До этого стоп, пауза и «продолжить» жили только в кнопках — и человек,
 * который в этот момент пишет в поле, должен был бросить клавиатуру и
 * целиться мышью, чтобы остановить тратящий токены прогон. Кнопка же
 * остаётся: мышь — тоже законный способ.
 *
 * Здесь только разбор события, без DOM и без RPC: модуль говорит, что
 * надо сделать, а поле ввода это делает.
 */

/** Что сделать с прогоном по нажатой клавише. */
export type ComposerAction = 'stop' | 'pause' | 'resume' | 'none';

/** Что известно о поле ввода: идёт ли прогон и на паузе ли он. */
export interface ComposerState {
  busy: boolean;
  paused: boolean;
}

/** Подмножество `KeyboardEvent`, которое здесь правда нужно — чтобы тест не строил DOM. */
export interface ComposerKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  /** Необязателен: в разборе прогона Alt не участвует, а старые тесты его не передают. */
  altKey?: boolean;
}

/**
 * Разобрать нажатие в поле ввода.
 *
 * Правила — не про удобство, а про то, что нельзя сделать случайно:
 * • Escape — стоп. Это привычка, а не риск: Escape уже означает «уйти отсюда»
 *   в десятках мест, и чат — не исключение.
 * • Ctrl/⌘+Shift+Space — пауза/продолжить. Просто Ctrl+Space занят
 *   автодополнением, а Shift+Space без модификатора — обычный пробел.
 * • Никакого Ctrl+Shift+X на стоп: сочетание можно прожать, когда в фокусе
 *   редактор и человек правит код; тогда Escape — единственное, что он сам
 *   нажимает осознанно.
 *
 * Стоп на Escape срабатывает ТОЛЬКО при идущем прогоне: иначе тихое нажатие
 * на пустой беседе выдавало бы «сейчас ничего не генерируется».
 */
export function composerAction(key: ComposerKey, state: ComposerState): ComposerAction {
  if (!state.busy) return 'none';
  const mod = key.ctrlKey || key.metaKey;

  if (key.key === 'Escape' && !mod && !key.shiftKey) return 'stop';

  // Пробел — это `' '`, а не `'Space'`: `KeyboardEvent.key` отдаёт символ.
  // `'Space'` понимаем тоже — так могут прийти события синтетические и
  // старые сборки Electron, и молча не сработать здесь хуже, чем сработать
  // дважды на одно нажатие.
  const isSpace = key.key === ' ' || key.key === 'Space';
  if (mod && key.shiftKey && isSpace) return state.paused ? 'resume' : 'pause';

  return 'none';
}

/** Что сказать человеку, когда клавиша сработала впустую. */
export function composerHint(action: ComposerAction, state: ComposerState): string | null {
  if (action === 'none') return null;
  if (action === 'pause') return 'Продолжу, когда скажете — Ctrl+Shift+Space';
  if (action === 'resume') return 'Дальше';
  return state.paused ? 'Остановлено на паузе' : 'Остановлено';
}

/**
 * Куда вернуть фокус после ответа на карточку в ленте.
 *
 * Карточка заменяет себе содержимое, и кнопка, на которой стоял фокус,
 * исчезает вместе с ним: фокус улетает в `document.body`, и следующий Tab
 * начинает обход страницы с самого начала — мимо чата назад в редактор.
 *
 * Возвращать всегда в поле ввода неверно: там начинается новый текст, а
 * человек только что ответил на карточку и, может, хочет перечитать ленту.
 * Поэтому решение зависит от того, что произошло.
 */
export type FocusTarget = 'composer' | 'thread';

/**
 * `answered` — ответили на карточку и прогон идёт дальше: человеку смотреть
 * на ленту, следующий вопрос придёт туда же, а поле ввода до этого нельзя
 * даже заполнить осмысленно. `settled` — прогон кончился: самое время писать
 * дальше, иначе фокус висит на мёртвой карточке.
 */
export function focusAfterCard(answered: boolean): FocusTarget {
  return answered ? 'thread' : 'composer';
}

/** Что сделать с лентой по нажатой в ней клавише. */
export type FeedAction = 'page-up' | 'page-down' | 'to-start' | 'to-end' | 'composer' | 'none';

/**
 * Разобрать нажатие в ленте беседы.
 *
 * Лента — не обычный текст, а список сообщений, и человек ждёт от неё
 * поведения списка: PageUp/PageDown листают экран, Home/End — к началу
 * и к концу, Escape уводит обратно в поле ввода.
 *
 * • С Shift/Alt/Ctrl/⌘ не лезем: там браузерное выделение и системные жесты,
 *   и отнимать их у человека без нужды — хуже, чем не иметь своих.
 * • Escape — именно «уйти отсюда», а не «остановить прогон»: в ленте прогон
 *   не останавливают, человек сюда пришёл читать.
 */
export function feedAction(key: ComposerKey): FeedAction {
  if (key.ctrlKey || key.metaKey || key.shiftKey || key.altKey) return 'none';
  if (key.key === 'PageUp') return 'page-up';
  if (key.key === 'PageDown') return 'page-down';
  if (key.key === 'Home') return 'to-start';
  if (key.key === 'End') return 'to-end';
  if (key.key === 'Escape') return 'composer';
  return 'none';
}

/**
 * Шаг по истории вопросов: `↑` — назад по времени, `↓` — вперёд.
 *
 * `current` — где стоит человек сейчас: `null` — в своём черновике, число —
 * индекс вопроса в списке (0 — самый старый, `count - 1` — самый свежий).
 * Возвращает новый индекс или `null`, если шаг уводит обратно в черновик:
 * так `↓` за последним вопросом возвращает то, что было набрано до `↑`,
 * а не застревает на последнем.
 *
 * Модуль чистый: список вопросов собирает тот, у кого есть беседа.
 */
export function recallStep(current: number | null, direction: -1 | 1, count: number): number | null {
  if (count <= 0) return null;
  if (direction === -1) {
    if (current === null) return count - 1;
    return Math.max(0, current - 1);
  }
  if (current === null) return null;
  const next = current + 1;
  return next >= count ? null : next;
}

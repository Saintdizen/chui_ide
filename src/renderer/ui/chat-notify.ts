import type { ChatMessage } from '../../shared/api';

/**
 * Конец прогона, пока окно не в фокусе.
 *
 * Прогон агента идёт минуты: человек ушёл в браузер, вернулся — и гадает, закончил
 * ассистент или всё ещё думает. Системное всплывающее окно не нужно: ОС спросит
 * разрешение, а звук по умолчанию — лишний шум. Нужна отметка ВНУТРИ окна (док и
 * название вкладки) и одна заметка там, куда человек всё равно смотрит.
 */
export type RunEnd = 'done' | 'stopped' | 'failed';

/**
 * Чем кончился ход: `done` — ответ дошёл, остальные — отказ до или во время него
 * (с тем же смыслом, что `PromptRun` и `StreamOutcome` в панели).
 */
export type RunOutcome = 'done' | 'started' | 'failed' | 'stopped' | 'busy' | 'unavailable';

/**
 * Стоит ли вообще говорить, что прогон кончился.
 *
 * Правила все — про шум: в фокусе окно или нет, `seen` решает вызывающий (он
 * знает и про фокус, и про видимость панели). `busy`/`unavailable` — это не
 * прогон, а отказ от него: сообщение о них уже было, повторять в доке нельзя.
 */
export function runEnd(run: RunOutcome): RunEnd | undefined {
  if (run === 'failed') return 'failed';
  if (run === 'stopped') return 'stopped';
  if (run === 'started' || run === 'done') return 'done';
  return undefined;
}

/**
 * Обрезать название для дока и заголовка вкладки.
 *
 * В доке одна строка, у вкладки — тоже: длинное имя вопроса вытеснило бы само
 * «ответ готов», и человек читал бы "Как перенести все настройки из VS Cod…».
 */
export function announceTitle(how: RunEnd, chatTitle: string): string {
  const name = chatTitle.replace(/\s+/g, ' ').trim();
  const short = name.length > 24 ? `${name.slice(0, 23)}…` : name;
  const words = how === 'done' ? 'ответ готов' : how === 'stopped' ? 'остановлено' : 'ошибка';
  return short ? `${short} · ${words}` : words;
}

/**
 * Строка заметки: что сказать и когда всё-таки молчать.
 *
 * `seen` — человек смотрел на ленту в момент конца. Для «готово» тогда заметка не
 * нужна: она перекрыла бы ответ. Ошибка и остановка — всегда: первую надо чинить,
 * вторую — не ждать зря.
 */
export function announceMessage(how: RunEnd, chatTitle: string, tail: string, seen: boolean): string | undefined {
  if (how === 'done' && seen) return;
  const name = chatTitle.trim() || 'Беседа';
  if (how === 'failed') return `${name}: прогон упал — лента ждёт, что посмотреть`;
  if (how === 'stopped') return `${name}: остановлено`;
  const text = tail.replace(/\s+/g, ' ').trim();
  const short = text.length > 90 ? `${text.slice(0, 89)}…` : text;
  return short ? `${name}: ${short}` : `${name}: ответ готов`;
}

/**
 * Возвращать ли фокус в поле вопроса после ответа.
 *
 * Фокус можно ЗАБРАТЬ из редактора, но нельзя — из поля, где человек сам сейчас
 * пишет (он успел начать следующий вопрос), и из раскрытого меню: переход сбросил бы
 * его выбор. Окно без фокуса — тоже «нет»: там фокус никому не виден.
 */
export function shouldRefocus(how: RunEnd, context: { typed: boolean; menuOpen: boolean; windowFocused: boolean }): boolean {
  if (context.typed) return false;
  if (context.menuOpen) return false;
  if (!context.windowFocused) return false;
  return how === 'done' || how === 'failed';
}

/**
 * Последний абзац ответа — та самая строка заметки.
 *
 * Берём последнее сообщение ассистента: у оборванного прогона конца нет, а у
 * неудавшегося тем более — тогда вернётся пусто, и заметка скажет это словами.
 */
export function tailOf(history: readonly ChatMessage[]): string {
  for (let at = history.length - 1; at >= 0; at -= 1) {
    const message = history[at];
    if (message?.role === 'assistant') return message.content;
  }
  return '';
}

import type { ChatSession } from './chat-session';

/**
 * Чекпойнт — «как было до этого вопроса».
 *
 * Отмена правки (`chat-changes`) откатывает ОДИН файл. Агентная работа — это шаг
 * за шагом: пять файлов, каждый правлен по разу, и «верни всё, как было до этого
 * вопроса» из меню правки одного файла не собирается. Здесь — снимок содержимого
 * файлов на момент начала хода; откат возвращает их разом.
 *
 * Отличие от `ToggledFile.original`: там исходный текст ПЕРВОЙ правки (по нему
 * считается добавленное/убранное), и накопление (`+=`) его портит. Здесь — полный
 * снимок СВОЕГО хода, положенный перед первым изменением и не трогаемый больше.
 */
export interface CheckpointFile {
  /** Было ли что откатывать — файл мог быть создан агентом, тогда его надо удалить. */
  existed: boolean;
  text: string;
}

/** Один ход: что человек спросил и какими файлы были в тот момент. */
export interface Checkpoint {
  /** Номер сообщения вопроса в `history` — по нему видно, к какому ходу откат. */
  messageIndex: number;
  /** Короткий заголовок для меню: первые слова вопроса. */
  title: string;
  files: Map<string, CheckpointFile>;
}

/**
 * Глубина истории чекпойнтов.
 *
 * Живёт в памяти беседы и держит полные тексты файлов: без потолка длинная
 * сессия на большом проекте съела бы память целиком. Старое отваливается первым.
 */
export const CHECKPOINT_LIMIT = 20;

/** Заголовок для меню: одна строка, коротко. */
export function checkpointTitle(question: string): string {
  const flat = question.replace(/\s+/g, ' ').trim();
  return flat.length > 60 ? `${flat.slice(0, 59)}…` : flat;
}

/**
 * Начать чекпойнт хода. Файлы добавляются по мере правки (`addCheckpointFile`).
 *
 * Возвращает undefined на пустом вопросе: пустой ход (приветствие, отмена)
 * откатывать нечего, и мусорный пункт в меню только мешает.
 */
export function beginCheckpoint(session: ChatSession, messageIndex: number, question: string): Checkpoint | undefined {
  const title = checkpointTitle(question);
  if (!title) return;
  const checkpoint: Checkpoint = { messageIndex, title, files: new Map() };
  // Стек, а не массив: нужен только конец, а срез с начала каждый раз копирует всё.
  //
  // Снимок на тот же вопрос ЗАМЕНЯЕТ прежний, а не ложится рядом. Повтор ответа
  // (`regenerate`) — это тот же вопрос, пройденный заново: файлы к этому моменту
  // уже в том виде, в каком их оставила прошлая попытка, и именно это «до» нужно
  // вернуть. Без замены `addCheckpointFile` видел бы файлы уже записанными и
  // молча пропускал их, а откат возвращал бы состояние до первой попытки.
  const stack = (session.checkpoints ?? []).filter((item) => item.messageIndex !== messageIndex);
  session.checkpoints = [...stack, checkpoint].slice(-CHECKPOINT_LIMIT);
  return checkpoint;
}

/**
 * Запомнить «как было» для файла — до правки и только один раз.
 *
 * Повторный вызов на тот же файл в том же ходе игнорируется: агент идёт шагами и
 * может тронуть файл дважды, а откат должен вернуть состояние ДО хода, а не
 * после первого шага.
 */
export function addCheckpointFile(checkpoint: Checkpoint | undefined, path: string, state: CheckpointFile): void {
  if (!checkpoint || checkpoint.files.has(path)) return;
  checkpoint.files.set(path, state);
}

/** Есть ли откат для вопроса с таким номером: без снимка кнопку не показываем. */
export function hasCheckpoint(session: ChatSession, messageIndex: number): boolean {
  return (session.checkpoints ?? []).some((checkpoint) => checkpoint.messageIndex === messageIndex);
}

/**
 * Что откатывать, если открутиться к чекпойнту `index`.
 *
 * Берём всё, что изменили ходы НАЧИНАЯ с `index`: конец работы возвращается к
 * состоянию перед `index`. Файл, тронутый дважды, берёт снимок САМОГО РАННЕГО
 * хода — к нему и возвращаемся, иначе откат отменил бы только часть изменения.
 *
 * В ответе — плоская карта путь → что записать (последнее слово за самым ранним).
 */
export function revertPlan(checkpoints: readonly Checkpoint[], index: number): Map<string, CheckpointFile> {
  const plan = new Map<string, CheckpointFile>();
  for (const checkpoint of checkpoints.slice(index)) {
    for (const [path, state] of checkpoint.files) {
      if (!plan.has(path)) plan.set(path, state);
    }
  }
  return plan;
}

/**
 * Обрезать чекпойнты после отката: возвращённая беседа больше не содержит этих ходов.
 *
 * Без этого пункты меню остались бы от работы, которой уже нет, и второй откат
 * вернул бы файлы в состояние, которого человек никогда не видел.
 */
export function truncateCheckpoints(session: ChatSession, index: number): void {
  session.checkpoints = (session.checkpoints ?? []).slice(0, index);
}

/**
 * Что именно случится при откате — ДО того, как он случится.
 *
 * Откат молчит: файлы меняются на диске, несохранённые правки летят, и человек
 * узнаёт об этом после. Предосмотр отвечает на три вопроса, каждый из которых
 * он не может проверить сам: сколько файлов откатится, сколько будет УДАЛЕНО
 * (агент их создал — вернуть их нельзя, файла до хода не было) и сколько
 * потеряют несохранённое.
 */
export interface RevertPreview {
  /** Сколько файлов откат тронет. */
  files: number;
  /** Из них созданных агентом — они будут удалены, а не возвращены. */
  removed: string[];
  /** Из них с несохранёнными правками — их нынешний вид пропадёт без следа. */
  unsaved: string[];
  /** Сколько ходов пропадёт из беседы (включая выбранный). */
  turns: number;
}

/**
 * Собрать предосмотр отката.
 *
 * `unsaved` — пути, у которых редактор держит изменения в памяти. Передаются
 * списком, а не читаются из редактора: модуль чистый и про редактор не знает.
 */
export function revertPreview(
  checkpoints: readonly Checkpoint[],
  index: number,
  unsaved: readonly string[] = [],
): RevertPreview {
  const plan = revertPlan(checkpoints, index);
  const dirty = new Set(unsaved);
  const removed: string[] = [];
  const lost: string[] = [];
  for (const [path, state] of plan) {
    if (!state.existed) removed.push(path);
    // Удаляемый файл отдельно не считаем дважды: пропадёт весь файл, и сказать
    // «пропадут несохранённые правки» про него — lesser way of same thing.
    else if (dirty.has(path)) lost.push(path);
  }
  return {
    files: plan.size,
    removed: removed.sort(),
    unsaved: lost.sort(),
    turns: checkpoints.filter((checkpoint) => checkpoint.messageIndex >= (checkpoints[index]?.messageIndex ?? 0))
      .length,
  };
}

/**
 * Одна фраза для окна подтверждения.
 *
 * Счёт файлов — первым: это то, из-за чего человек вообще задумается. Удаление
 * и потеря несохранённого — отдельными строками, потому что обратно их вернуть
 * нельзя, и «просто число файлов» об этом бы умолчало.
 */
export function revertSummary(preview: RevertPreview, title: string): string {
  // Склонение по-русски: «2 файла», но «5 файлов». Общая форма «2 файла/файлов»
  // читается как машинный шаблон ровно там, где человек взвешивает риск.
  const plural = (n: number, one: string, few: string, many: string): string => {
    const tail10 = n % 10;
    const tail100 = n % 100;
    if (tail10 === 1 && tail100 !== 11) return `${n} ${one}`;
    if (tail10 >= 2 && tail10 <= 4 && (tail100 < 12 || tail100 > 14)) return `${n} ${few}`;
    return `${n} ${many}`;
  };
  const ходы = plural(preview.turns, 'ход', 'хода', 'ходов');
  const файлы = plural(preview.files, 'файл', 'файла', 'файлов');
  const parts: string[] = [];
  parts.push(
    preview.files === 0
      ? `Файлы не меняются — к состоянию до «${title}» вернётся только беседа.`
      : `Файлов вернётся к состоянию до «${title}»: ${файлы}.`,
  );
  if (preview.removed.length > 0) {
    parts.push(`Будут УДАЛЕНЫ (созданы агентом): ${preview.removed.join(', ')}.`);
  }
  if (preview.unsaved.length > 0) {
    parts.push(`Пропадут несохранённые правки: ${preview.unsaved.join(', ')}.`);
  }
  parts.push(`Из беседы уйдёт ${ходы}.`);
  return parts.join('\n');
}

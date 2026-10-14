/**
 * Макросы: запись нажатий и повтор того же действия.
 *
 * Макрос записывает не клавиши, а ДЕЙСТВИЯ — то, во что их переводит раскладка
 * (`keymap.ts`): движение, правку или вставленный текст. Поэтому повтор не зависит от
 * раскладки и от того, где стоит курсор: макрос «вниз, в конец строки, точка с запятой»
 * сработает на любой строке, а не только на той, где его записали.
 *
 * Записывается только то, что меняет текст и двигает курсор. Буфер обмена, выделение
 * мышью и команды, открывающие панели (поиск, палитра, переход к символу), в макрос не
 * попадают: повторять их бессмысленно, а на экране они открывали бы окна из ниоткуда.
 *
 * Модуль чистый: ни DOM, ни редактора — исполнитель шагов приходит снаружи
 * (`MacroTarget`). Поэтому запись и повтор проверяются без окна
 * (`tests/editor-macro.test.ts`).
 */

import { MAX_MACRO_STEPS } from '../../../shared/macro';
import type { EditCommand, Motion } from './keymap';

/** Шаг макроса: движение курсора, правка текста или вставленный кусок. */
export type MacroStep =
  | { kind: 'move'; motion: Motion; extend: boolean }
  | { kind: 'edit'; command: EditCommand }
  | { kind: 'insert'; text: string };

/**
 * Команды, которые в макрос не пишутся. Панели и переходы открывали бы окна при
 * повторе, а отмена и повтор истории крутили бы не то, что человек записал.
 */
const NOT_RECORDED: ReadonlySet<EditCommand> = new Set<EditCommand>([
  'undo',
  'redo',
  'find',
  'replace',
  'gotoLine',
  'palette',
  'codeActions',
  'goToDefinition',
  'references',
  'peekDefinition',
  'surroundWith',
  'formatSelection',
]);

/** Попадёт ли эта правка в макрос. */
export function recordsCommand(command: EditCommand): boolean {
  return !NOT_RECORDED.has(command);
}

/** Запись макроса: копит шаги, пока идёт. */
export class MacroRecorder {
  private recording = false;
  private steps: MacroStep[] = [];

  get isRecording(): boolean {
    return this.recording;
  }

  /** Сколько шагов уже записано — по этому числу видно, что запись идёт не впустую. */
  get length(): number {
    return this.steps.length;
  }

  /** Начать запись: прежний макрос забывается (записываем заново, а не дописываем). */
  start(): void {
    this.recording = true;
    this.steps = [];
  }

  /** Закончить запись и вернуть накопленное. */
  stop(): readonly MacroStep[] {
    this.recording = false;
    return this.steps;
  }

  /** Записать шаг. Вне записи и сверх предела шаг пропускается. */
  push(step: MacroStep): void {
    if (!this.recording || this.steps.length >= MAX_MACRO_STEPS) return;
    this.steps.push(step);
  }

  /** Накопленные шаги (для показа «что записано»). */
  taken(): readonly MacroStep[] {
    return this.steps;
  }

  /** Взять набор шагов извне (макрос из сессии прошлой работы). */
  set(steps: readonly MacroStep[]): void {
    this.recording = false;
    this.steps = [...steps];
  }
}

/**
 * Шаги макроса из сессии проекта. Проверяется ФОРМА шага, а не имена движений и
 * команд: незнакомое имя при повторе просто ничего не сделает (переключатели
 * движений и правок не знают такого случая), а вот мусор в полях сломал бы разбор.
 */
export function sanitizeMacroSteps(raw: unknown): MacroStep[] {
  if (!Array.isArray(raw)) return [];
  const steps: MacroStep[] = [];
  for (const item of raw.slice(0, MAX_MACRO_STEPS)) {
    if (typeof item !== 'object' || item === null) continue;
    const value = item as Record<string, unknown>;
    if (value.kind === 'move' && typeof value.motion === 'string' && value.motion.length > 0) {
      steps.push({ kind: 'move', motion: value.motion as Motion, extend: value.extend === true });
    } else if (value.kind === 'edit' && typeof value.command === 'string' && value.command.length > 0) {
      steps.push({ kind: 'edit', command: value.command as EditCommand });
    } else if (value.kind === 'insert' && typeof value.text === 'string' && value.text.length > 0) {
      steps.push({ kind: 'insert', text: value.text });
    }
  }
  return steps;
}

/** Что умеет редактор, чтобы исполнить шаг макроса. Реализует ввод (`editor-input.ts`). */
export interface MacroTarget {
  move(motion: Motion, extend: boolean): void;
  edit(command: EditCommand): void;
  insert(text: string): void;
}

/**
 * Выполнить макрос: каждый шаг идёт тем же путём, что и нажатие. Возвращает число
 * выполненных шагов — по нему видно, что макрос не оказался пустым.
 */
export function runMacro(steps: readonly MacroStep[], target: MacroTarget): number {
  for (const step of steps) {
    if (step.kind === 'move') target.move(step.motion, step.extend);
    else if (step.kind === 'edit') target.edit(step.command);
    else target.insert(step.text);
  }
  return steps.length;
}

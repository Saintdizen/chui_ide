import { isInsidePath, joinPath, nameOf, parentOf } from './paths';

/**
 * Что пришло из окна — перенос файлов, копия или ничего.
 *
 * Только решение, без DOM: `explorer.ts` читает событие и отдаёт сюда то, что
 * оттуда достал. Так правило проверяется тестом, а не перетаскиванием мышью.
 */
export type DropKind = 'move' | 'copy' | 'none';

/**
 * Тип переноса по флагам `dataTransfer`. Копию просят зажатым Ctrl (на macOS —
 * Alt): без этого перетаскивание в ту же файловую систему означает перенос.
 */
export function dropKind(hasFiles: boolean, types: readonly string[], copyModifier: boolean): DropKind {
  if (!hasFiles || types.length === 0) return 'none';
  return copyModifier ? 'copy' : 'move';
}

export interface DropVerdict {
  readonly accept: boolean;
  /** Почему не принимаем — текст для пояснения под курсором. `null`, если берём. */
  readonly reason: string | null;
}

/**
 * Понимаем ли мы то, что бросили.
 *
 * Правило одно: берём файлы из этой же файловой системы (у них есть путь) и не
 * берём ссылки (`text/uri-list` без файлов — это адрес страницы: переносить его
 * в папку некуда). Молча глотать чужой тип хуже, чем отказать вслух: иначе
 * человек не понимает, почему перетаскивание «не работает».
 */
export function dropVerdict(hasFiles: boolean, types: readonly string[]): DropVerdict {
  if (types.length === 0) return { accept: false, reason: null };
  if (hasFiles) return { accept: true, reason: null };
  if (types.includes('text/uri-list')) return { accept: false, reason: 'Это адрес, а не файл' };
  if (types.includes('text/plain')) return { accept: false, reason: 'Это текст, а не файл' };
  return { accept: false, reason: 'Это не файлы' };
}

/**
 * Куда положить: папка остаётся собой, файл — его каталог.
 *
 * Правило нужно, когда бросили НА файл: ожидание — «рядом с ним», а не «в него».
 */
export function dropTargetDir(path: string, isDirectory: boolean): string {
  return isDirectory ? path : parentOf(path);
}

/**
 * Несёт ли перенос папку в себя.
 *
 * Перенос папки в собственный подкаталог — обычный промах мышью, и главное, он
 * не значит ничего осмысленного: после него папка оказалась бы внутри себя.
 */
export function movesInsideItself(source: string, targetDir: string): boolean {
  return isInsidePath(source, targetDir);
}

/** Куда ляжет файл после переноса. */
export function movedTo(source: string, targetDir: string): string {
  return joinPath(targetDir, nameOf(source));
}

/**
 * Почему этот файл из брошенных не трогаем. `null` — переносим.
 *
 * Две причины разной природы: цель — та же папка (переноса нет) или папка внутри
 * брошенной (перенос в себя). Обе — отказ, но объясняются по-разному.
 */
export type SkipReason = 'same-dir' | 'inside-itself';

export function skippedSource(source: string, targetDir: string): SkipReason | null {
  if (parentOf(source) === targetDir) return 'same-dir';
  if (movesInsideItself(source, targetDir)) return 'inside-itself';
  return null;
}

/**
 * Сообщение об отказе для одной цели.
 *
 * Не спрашиваем «заменить?»: две копии с одинаковым именем перезаписали бы друг
 * друга без следа, а «переименовать» требует ещё одного диалога. Поэтому называем
 * то, что мешает, и не делаем ничего.
 */
export function alreadyThereNotice(target: string): string {
  return `Уже есть: ${nameOf(target)}`;
}

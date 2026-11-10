import { isInsidePath, joinPath, nameOf, parentOf } from '../../shared/paths';

/**
 * Буфер файлов проводника: что именно копируют или переносят и куда положат.
 *
 * Решение без DOM — как и `drop-guard.ts`: проводник отдаёт пути, а правила
 * (что нельзя, что уже есть, куда ляжет) проверяются тестом, а не руками.
 *
 * Системный буфер для этого не годится: в нём пути текстом, и обратно их не
 * отличить от скопированного имени. Держим свой — живёт до перезапуска окна.
 */
export type ClipMode = 'copy' | 'move';

export interface FileClip {
  readonly mode: ClipMode;
  readonly paths: readonly string[];
}

/**
 * Что даст вставка в папку `targetDir`. `plan` — то, что реально сделаем:
 * источники могут выпасть (уже здесь, папка внутри себя).
 */
export interface PastePlan {
  /** Источники, которые действительно трогаем. */
  readonly sources: readonly string[];
  /** Куда придётся каждый: в порядке `sources`. */
  readonly targets: readonly string[];
  /** Сколько источников пропущено и почему — для сообщения человеку. */
  readonly skipped: number;
  /** Имена, которые уже есть на месте: без перезаписи, без вопросов. */
  readonly conflicts: readonly string[];
}

/**
 * План вставки. `exists` отвечает, есть ли путь на диске — через него, а не
 * через `fs`: ядро не знает о файловой системе, а тест не трогает диск.
 */
export function planPaste(clip: FileClip, targetDir: string, exists: (path: string) => boolean): PastePlan {
  const sources: string[] = [];
  const targets: string[] = [];
  const conflicts: string[] = [];
  let skipped = 0;

  for (const source of clip.paths) {
    // Перенос в ту же папку и папку внутри себя — не действие, а промах.
    if (parentOf(source) === targetDir || movesInto(source, targetDir)) {
      skipped += 1;
      continue;
    }
    const target = joinPath(targetDir, nameOf(source));
    // Копия в ту же папку создала бы вторую копию — её отдельно не просили.
    if (exists(target)) {
      conflicts.push(nameOf(source));
      continue;
    }
    sources.push(source);
    targets.push(target);
  }

  return { sources, targets, skipped, conflicts };
}

/** Папка целиком не уезжает в свой же подкаталог: она бы содержала себя. */
function movesInto(source: string, targetDir: string): boolean {
  return isInsidePath(source, targetDir);
}

/**
 * Сообщение после вставки. `null` — говорить нечего.
 *
 * Считаем вслух: вставка без числа («вставлено») не отвечает на вопрос
 * «сколько?», а это единственное, что человек здесь проверяет.
 */
export function pasteNotice(plan: PastePlan, clip: FileClip): string | null {
  const done = plan.sources.length;
  const noun = clip.mode === 'copy' ? 'скопировано' : 'перенесено';
  const parts: string[] = [];
  if (done > 0) parts.push(`${noun}: ${done}`);
  if (plan.conflicts.length > 0) parts.push(`уже есть: ${plan.conflicts.length}`);
  if (plan.skipped > 0) parts.push(`пропущено: ${plan.skipped}`);
  if (parts.length === 0) return 'Вставлять нечего';
  return parts.join(' · ');
}

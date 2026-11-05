/**
 * Чем кончился прогон — одной сводкой, которую можно прочитать в ленте.
 *
 * Зачем. Раньше конец прогона был виден только там, где его специально ждали:
 * строка ошибки, если прогон упал, и метка в доке. А «что осталось сделанным»
 * человек собирал сам — из группы действий, панели изменений и списка файлов.
 * При падении на середине это худший момент, чтобы искать: непонятно, то ли
 * агент ничего не успел, то ли успел, но не сказал.
 *
 * Модуль чистый: на вход — то, что беседа и так про себя знает, на выход —
 * строки для ленты. Ни DOM, ни хранилища, поэтому проверяется без окна.
 */
import type { ChangeKind } from '../../shared/tool-files';

export type RunEndHow = 'failed' | 'stopped';

/** Один затронутый путь: что с ним сделали. */
export interface RunEndFile {
  path: string;
  kind: ChangeKind;
}

export interface RunEndInput {
  how: RunEndHow;
  /** Правки, ещё лежащие в буфере без сохранения: их и надо заметить первым делом. */
  unsaved: readonly string[];
  /** Изменения, о которых сообщили инструменты: создано, изменено, удалено. */
  files: readonly RunEndFile[];
  /** Предъявленные по ходу файлы: план, отчёт тестов. Не изменения, но след. */
  artifacts: readonly string[];
  /** Текст ошибки, если прогон упал не по нашей воле (нажали «Стоп» — её нет). */
  reason?: string;
}

export interface RunEndReport {
  /** Заголовок: что случилось, одной фразой, без технического шума. */
  title: string;
  /** Пояснение под заголовком: почему, если знаем. */
  detail: string;
  /** Что успело остаться после прогона — по строкам, человеческими словами. */
  facts: string[];
  /**
   * Есть ли хоть один след работы. Если нет — говорить «что осталось» не о чем,
   * и блок должен честно сказать «ничего не изменилось», а не молчать.
   */
  hasWork: boolean;
}

/** Больше восьми путей в строке — это уже список, а не сводка. */
const MAX_NAMED = 8;

/** Тот же счёт по-русски, что и в остальной ленте: 1 файл, 2 файла, 5 файлов. */
function plural(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

/** «a.ts, b.ts и ещё 5» — сначала имена, остальное числом. */
function nameList(paths: readonly string[]): string {
  const named = paths.slice(0, MAX_NAMED);
  const rest = paths.length - named.length;
  if (rest <= 0) return named.join(', ');
  return `${named.join(', ')} и ещё ${rest}`;
}

/**
 * Сколько чего изменилось, по родам. Роды разные по смыслу, поэтому и строки
 * разные: «создал» и «удалил» нельзя складывать в одно «изменил файлов: 3» —
 * это скроет, что часть работы была удалением.
 */
function describeFiles(files: readonly RunEndFile[]): string[] {
  const byKind = new Map<ChangeKind, string[]>();
  for (const file of files) {
    const list = byKind.get(file.kind) ?? [];
    list.push(file.path);
    byKind.set(file.kind, list);
  }
  const out: string[] = [];
  const kinds: readonly ChangeKind[] = ['created', 'modified', 'moved', 'edited', 'deleted'];
  for (const kind of kinds) {
    const paths = byKind.get(kind);
    if (!paths || paths.length === 0) continue;
    const many = paths.length > 1;
    const base =
      kind === 'created'
        ? many
          ? 'создано файлов'
          : 'создан файл'
        : kind === 'deleted'
          ? many
            ? 'удалено файлов'
            : 'удалён файл'
          : kind === 'moved'
            ? many
              ? 'перемещено файлов'
              : 'перемещён файл'
            : many
              ? 'изменено файлов'
              : 'изменён файл';
    out.push(many ? `${base}: ${paths.length} — ${nameList(paths)}` : `${base}: ${nameList(paths)}`);
  }
  return out;
}

export function runEndReport(input: RunEndInput): RunEndReport {
  const title = input.how === 'stopped' ? 'Прогон остановлен' : 'Прогон прерван ошибкой';
  const detail =
    input.how === 'stopped'
      ? 'Работа прервана вручную. Ниже — что успело остаться.'
      : input.reason?.trim() || 'Причина неизвестна: модель или провайдер не сообщили её.';

  const facts: string[] = [];
  // Несохранённое — первым: это единственное, что пропадёт, если закрыть окно.
  if (input.unsaved.length > 0) {
    const count = input.unsaved.length;
    facts.push(`Не сохранено ${count} ${plural(count, 'файл', 'файла', 'файлов')}: ${nameList(input.unsaved)}`);
  }
  facts.push(...describeFiles(input.files));
  if (input.artifacts.length > 0) {
    const count = input.artifacts.length;
    facts.push(`Сохранено ${count} ${plural(count, 'заметка', 'заметки', 'заметок')}: ${nameList(input.artifacts)}`);
  }

  return {
    title,
    detail,
    facts,
    hasWork: input.unsaved.length > 0 || input.files.length > 0 || input.artifacts.length > 0,
  };
}

import { isImagePath } from '../../shared/images';
import { isOfficePath } from '../../shared/office';
import { fileName } from '../../shared/tool-files';
import type { showToast } from '../ui/toast';
import type { TextDocument } from './document';

/** Опция «Перечитать» в тосте: тот же вызов, что и везде в панелях. */
type ToastFn = typeof showToast;

/** Что модуль отдаёт наружу. */
export interface DiskConflict {
  reloadIfOpen(path: string): Promise<void>;
  revertFilesToDisk(targets: readonly string[]): Promise<void>;
}

/** Буферы документов: только то, что нужно этому модулю. */
export interface DiskConflictPorts {
  documents: {
    get(path: string): TextDocument | undefined;
    onDidChangeDirty(listener: (document: TextDocument) => void): unknown;
    onDidClose(listener: (document: TextDocument) => void): unknown;
  };
  /** Перечитать текст с диска, не тронув несохранённые правки. */
  reloadFromDisk(path: string): Promise<TextDocument>;
  /** Вернуть файл к версии на диске, правки в буфере отбросив. */
  revertToDisk(path: string): Promise<TextDocument>;
  /** Файл на диске сменился у картинки или документа Office — обновить экран. */
  refreshView(path: string): void;
  /** Файл и его окружение могли измениться — пересобрать дерево. */
  scheduleTreeRefresh(): void;
  /** Спросить человека, прежде чем отбрасывать правки. */
  confirmRevert(targets: readonly string[]): Promise<boolean>;
  showToast: ToastFn;
}

/**
 * Буфер разошёлся с диском: перечитывание и возврат к версии файла.
 *
 * Граница этой работы — пометка «не сохранён». `reloadFromDisk` (в `edits.ts`)
 * буфер бережёт: правки человека — его работа, терять их нельзя без спроса. Но
 * если файл переписал другой инструмент, документ остаётся правленым навсегда:
 * обе точки перечитывания пропускают «грязные» документы. Отсюда две половинки:
 * тихое перечитывание и громкий возврат с вопросом.
 *
 * Своё состояние тоже здесь: `warned` — сказали ли уже про этот файл, чтобы
 * наблюдатель файлов не сыпал тостами на каждое событие.
 */
export function createDiskConflict(ports: DiskConflictPorts): DiskConflict {
  const { documents, reloadFromDisk, revertToDisk, refreshView, scheduleTreeRefresh, confirmRevert, showToast } = ports;

  const warned = new Set<string>();
  documents.onDidChangeDirty((document) => {
    if (!document.dirty) warned.delete(document.path);
  });
  // Закрытая вкладка: набор не должен держать путь вечно — иначе после повторного
  // открытия о расхождении с диском уже не скажем.
  documents.onDidClose((document) => {
    warned.delete(document.path);
  });

  const diskConflict: DiskConflict = {
    /**
     * Файл изменился на диске. Открытый документ перечитываем: иначе в редакторе
     * останется старая версия — например, после правки во внешнем инструменте или
     * в терминале. Несохранённые правки при этом НЕ теряются — решение принимает
     * сам `reloadFromDisk` (содержимое совпало — снимаем «грязность», разошлось —
     * оставляем буфер).
     *
     * О разошедшемся буфере говорим вслух и сразу предлагаем перечитать: иначе
     * пометка «не сохранён» висит без объяснения, а Ctrl+S спрашивает про файл,
     * которого человек не трогал, — и непонятно, чьи правки в буфере и что с ними делать.
     */
    async reloadIfOpen(path: string): Promise<void> {
      const document = documents.get(path);
      if (!document) return;
      // Картинка и документ Office — не текст: перечитывать их в буфер нельзя
      // (в него попадёт бинарь). Файл мог смениться на диске — об этом узнаёт
      // вьюер, а не буфер.
      if (isImagePath(path) || isOfficePath(path)) {
        refreshView(path);
        return;
      }
      await reloadFromDisk(path).catch(() => undefined);
      // Буфер остался правленым — значит версия на диске с ним разошлась: совпавший
      // текст снял бы «грязность» (см. `reloadFromDisk`).
      if (!document.dirty || warned.has(path)) return;
      warned.add(path);
      showToast(`Файл «${fileName(path)}» изменился на диске: ваши правки в редакторе целы`, 'info', {
        action: { label: 'Перечитать', run: () => void confirmRevert([path]) },
      });
    },

    /**
     * Вернуть файлы к версии на диске: перечитать и отбросить правки в буфере.
     *
     * Спрашиваем всегда: правки в буфере — работа человека, терять их без спроса
     * нельзя. Файл, который и так равен диску, в список не идёт — там терять нечего.
     */
    async revertFilesToDisk(targets: readonly string[]): Promise<void> {
      const dirty = targets.filter((target) => documents.get(target)?.dirty === true);
      if (dirty.length === 0) {
        showToast('Правок в буфере нет', 'info');
        return;
      }
      if (!(await confirmRevert(dirty))) return;

      let done = 0;
      for (const target of dirty) {
        try {
          await revertToDisk(target);
          done += 1;
        } catch {
          showToast(`Не удалось прочитать файл: ${fileName(target)}`, 'error');
        }
      }
      if (done === 0) return;
      // Файл мог измениться и за пределами буфера (его переписал другой инструмент) —
      // поэтому вместе с документами обновляем и дерево.
      scheduleTreeRefresh();
      showToast(done === 1 ? `Перечитано с диска: ${fileName(dirty[0] ?? '')}` : `Перечитано с диска: файлов ${done}`);
    },
  };

  return diskConflict;
}

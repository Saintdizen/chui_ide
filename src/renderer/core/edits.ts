import type { ApplyFailure, ApplyReport, ApplyResult, FileEdit } from '../../shared/edits';
import { isImagePath } from '../../shared/images';
import { isOfficePath } from '../../shared/office';
import { diskConflict, normalize, type TextDocument } from './document';
import type { DocumentStore } from './document-store';
import type { EditSource } from './document';
import type { EditorApi } from './editor-api';
import type { RpcClient } from './rpc';

export interface EditServiceDeps {
  documents: DocumentStore;
  editors: EditorApi;
  rpc: RpcClient;
}

/**
 * Точка входа для любых программных правок: и для reload с диска, и для
 * ассистента. Документ обновляется первым, затем редактор — это гарантирует,
 * что версия документа всегда опережает то, что видно на экране.
 */
export class EditService {
  constructor(private readonly deps: EditServiceDeps) {}

  /** Открывает документ, подгружая текст с диска при необходимости. */
  async ensureDocument(path: string): Promise<TextDocument> {
    // Картинка и документ Office — не текст: читать их в документ нельзя. В буфере
    // оказался бы бинарь — он же уехал бы в копию кода («заглядывание»), в поиск по
    // открытым файлам и на диск при сохранении. Заглушка нужна вкладке, дереву и
    // статусбару, а полотно показывает свой экран (см. `syncImage`/`syncDoc` в app.ts).
    // Проверка идёт до «уже открыт»: в открытом документе мог остаться бинарь
    // от прежней версии — заглушка его очистит.
    if (isImagePath(path) || isOfficePath(path)) return this.binaryDocument(path);

    const existing = this.deps.documents.get(path);
    if (existing) return existing;

    const file = await this.deps.rpc.request('workspace.readFile', { path });
    const document = this.deps.documents.open(path, file.text, { readOnly: file.readOnly });
    document.markDisk(file.mtimeMs);
    return document;
  }

  /**
   * Записать документ на диск. Перед записью сверяем время файла: если он
   * изменился снаружи после нашего чтения, писать буфер нельзя — иначе молча
   * перетрём чужую правку (ассистента, из терминала, другим инструментом).
   * Решение принимает вызывающий: `force` — человек уже подтвердил перезапись.
   */
  async saveDocument(document: TextDocument, options: { force?: boolean } = {}): Promise<'saved' | 'conflict'> {
    if (!options.force) {
      const stat = await this.deps.rpc.request('workspace.stat', { path: document.path }).catch(() => null);
      if (diskConflict(document.diskMtime, stat?.mtimeMs ?? null)) {
        // Файл изменился снаружи — но, может быть, ровно на нашу правку (её записал
        // другой инструмент: агент применил к документу, а на диск записал файловый
        // инструмент). Тогда сохранять нечего: снимаем «грязность» и рапортуем успех,
        // иначе человек видит ложный конфликт и файл навсегда остаётся «не сохранён».
        const file = await this.deps.rpc.request('workspace.readFile', { path: document.path }).catch(() => null);
        if (file && normalize(file.text) === document.value) {
          document.markSaved(file.mtimeMs);
          return 'saved';
        }
        return 'conflict';
      }
    }
    const { mtimeMs } = await this.deps.rpc.request('workspace.writeFile', {
      path: document.path,
      text: document.value,
    });
    document.markSaved(mtimeMs);
    return 'saved';
  }

  /**
   * Подтянуть чистый буфер к диску, если файл переписали снаружи.
   *
   * Возвращает `true`, если текст документа заменился текстом с диска. Зовётся
   * перед правкой агента: якоря приходят из чтения ГЛАВНОГО процесса, то есть с
   * диска, а не из буфера. Пока вкладка открыта давно и файл с тех пор изменили
   * (git, терминал, другой инструмент), правка ляжет мимо — `oldText` совпадёт с
   * диском и не совпадёт с буфером, — а сохранение затем откажет «файл изменён
   * на диске». Для агента это выглядело как неудавшаяся правка, и он повторял
   * круг с тем же якорем. Грязный буфер не трогаем: в нём несохранённая работа
   * человека, и расхождение с диском там настоящее.
   */
  private async refreshStale(document: TextDocument): Promise<boolean> {
    if (document.dirty) return false;
    const stat = await this.deps.rpc.request('workspace.stat', { path: document.path }).catch(() => null);
    if (!diskConflict(document.diskMtime, stat?.mtimeMs ?? null)) return false;
    const before = document.version;
    await this.reloadFromDisk(document.path);
    return document.version !== before;
  }

  async applyFileEdits(fileEdits: readonly FileEdit[], source: EditSource = 'programmatic'): Promise<ApplyResult> {
    const reports: ApplyReport[] = [];
    const failed: ApplyFailure[] = [];

    for (const file of fileEdits) {
      try {
        const document = await this.ensureDocument(file.path);
        if (document.readOnly) {
          throw new Error('файл открыт только для чтения: он слишком большой для правок');
        }
        // Свежий текст с диска — до сверки версий: подтягивание меняет версию само,
        // и ожидание из чтения к ней уже не относится.
        const refreshed = await this.refreshStale(document);
        if (!refreshed && file.expectedVersion !== undefined && file.expectedVersion !== document.version) {
          throw new Error(`Версия документа устарела: ожидалась ${file.expectedVersion}, текущая ${document.version}`);
        }

        // Применяет кто-то ОДИН — редактор для открытого файла, документ для файла за кадром
        // (см. `EditorHost.applyEdits`). Раньше обе ступени шли подряд, и до второй текст
        // доезжал уже применённым — правка ложилась ещё раз, а совпавший `oldText` повтор
        // не отсекал: от этого в файлах задваивались строки.
        const translated = this.deps.editors.applyEdits(document, file.edits, source);
        if (translated.changes.length === 0) {
          // Разбор прошёл, но текст не изменился: позиции указывают не туда.
          // «применено 0» без объяснения модель читает как успех и повторяет ошибку.
          const reason = translated.skipped[0]?.reason;
          throw new Error(
            reason
              ? `правки не изменили документ: ${reason} — перечитай файл и повтори`
              : 'правки не изменили документ: позиции не совпали с содержимым файла — перечитай файл и повтори',
          );
        }
        // Пропущенная правка не молчит: рядом с применёнными о ней надо сказать отдельно.
        for (const skip of translated.skipped) {
          failed.push({ path: file.path, message: `правка пропущена: ${skip.reason}` });
        }
        reports.push({ path: file.path, applied: translated.changes.length, version: document.version });
      } catch (error) {
        failed.push({ path: file.path, message: error instanceof Error ? error.message : String(error) });
      }
    }

    return { reports, failed };
  }

  /**
   * Перечитывает файл с диска.
   *
   * Несохранённые правки в буфере НЕ перетираются. Но если на диске ровно то же,
   * что в буфере, «грязность» снимаем: файл уже сохранён — просто записал его не
   * редактор (правку агента продублировал файловый инструмент, файл перезаписал
   * терминал или git). Без этого такой документ навсегда оставался бы «не сохранён»:
   * обе точки перечитывания пропускают «грязные» документы, и сам он не очистится.
   */
  async reloadFromDisk(path: string): Promise<TextDocument> {
    // Картинку не перечитываем: её содержимое — не текст. Документ-заглушка
    // остаётся пустой, а показывать её умеет только вьюер; его кэш сбрасывает
    // приложение (см. `reloadIfOpen` в app.ts) — иначе на диске новое, а на экране старое.
    if (isImagePath(path) || isOfficePath(path)) return this.binaryDocument(path);

    const file = await this.deps.rpc.request('workspace.readFile', { path });
    const existing = this.deps.documents.get(path);

    if (existing?.dirty) {
      // Содержимое совпало — сохранять нечего; разошлось — это чужая правка, буфер не трогаем.
      if (normalize(file.text) === existing.value) existing.markSaved(file.mtimeMs);
      return existing;
    }

    const target = existing ?? this.deps.documents.open(path, file.text, { readOnly: file.readOnly });
    target.setText(file.text, 'disk');
    // Перечитали — содержимое снова совпадает с диском, и мы знаем время файла.
    // Без `markSaved` документ считался бы правленым: следующее внешнее изменение
    // молча пропустилось бы как «грязный», а в редакторе висела бы пометка правок.
    target.markSaved(file.mtimeMs);
    return target;
  }

  /**
   * Вернуть документ к версии файла на диске, правки в буфере — отбросить.
   *
   * Отличие от `reloadFromDisk`: та буфер бережёт (несохранённые правки человека —
   * его работа), а эта им распоряжается и потому зовётся только по явной просьбе.
   * Жить без неё нельзя: там, где буфер разошёлся с диском и правки в нём уже не
   * нужны (файл переписал другой инструмент, правки легли мимо), документ
   * оставался «не сохранён» до самого закрытия вкладки — и каждый раз при закрытии
   * окна человек видел вопрос о файле, который и так равен диску.
   */
  async revertToDisk(path: string): Promise<TextDocument> {
    // Та же причина, что у `reloadFromDisk`: у картинки и документа Office нет текстовой версии.
    if (isImagePath(path) || isOfficePath(path)) return this.binaryDocument(path);

    const file = await this.deps.rpc.request('workspace.readFile', { path });
    const existing = this.deps.documents.get(path);
    const target = existing ?? this.deps.documents.open(path, file.text, { readOnly: file.readOnly });
    // Замена идёт через документ: правку на экран доведёт подписка редактора на смену
    // буфера, а undo получит свой шаг — возврат к версии с диска тоже можно отменить.
    target.setText(file.text, 'disk');
    target.markSaved(file.mtimeMs);
    return target;
  }

  /**
   * Документ-заглушка файла без текста (картинка, docx, xlsx): TextDocument
   * нужен вкладке, дереву и статусбару, а текста в нём нет и быть не должно. Уже открытый документ
   * очищаем: в него мог попасть бинарь раньше — например, перечитыванием файла
   * до этой правки, — и такой буфер не должен ни показываться, ни сохраняться.
   */
  binaryDocument(path: string): TextDocument {
    const existing = this.deps.documents.get(path);
    if (!existing) return this.deps.documents.open(path, '', { readOnly: true });
    if (existing.value !== '') {
      existing.setText('', 'programmatic');
      existing.markSaved();
    }
    return existing;
  }
}

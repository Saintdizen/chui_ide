import type { TextDocument } from './document';
import type { CheckoutPlan } from './file-actions';
import { planCheckout, planCommitSave } from './file-actions';
import type { ToastKind, ToastOptions } from '../ui/toast';
import { decideSaveAs } from '../../shared/save-as';
import { applySaveEdits } from '../../shared/save-edits';
import type { WorkspaceRoot } from '../../shared/workspace-roots';

/**
 * Запись буфера на диск: Ctrl+S, «Сохранить как», сохранение перед git и при закрытии окна.
 *
 * Вынесено из `app.ts`, потому что это одна работа со многими входами и одним вопросом:
 * можно ли сейчас писать. Все входы отвечают на него одинаково — сначала спросить, если
 * файл изменился снаружи, и только потом писать.
 */

/** Что делать с текстом при записи: подрезка хвостов, перевод строки, формат. */
export interface SavePolicy {
  trimTrailingWhitespace: boolean;
  insertFinalNewline: boolean;
  formatOnSave: boolean;
}

/** Что делать с выбранным путём «Сохранить как» — решает `shared/save-as.ts`. */
export type { SaveAsDecision } from '../../shared/save-as';

/** Вопрос человеку с кнопкой подтверждения. */
export interface ConfirmAsk {
  title: string;
  message: string;
  detail?: string;
  confirmLabel: string;
}

export interface FileWritePorts {
  documents: {
    get(path: string): TextDocument | undefined;
    dirty(): TextDocument[];
  };
  /** Запись буфера с проверкой расхождения с диском (в `edits.ts`). */
  edits: { saveDocument(document: TextDocument, options?: { force?: boolean }): Promise<'saved' | 'conflict'> };
  /** Системный диалог «Сохранить как» живёт в main: renderer файлы не выбирает. */
  rpc: {
    request(
      method: 'dialog.saveFile',
      params: { title: string; defaultPath: string },
    ): Promise<{ path: string | null }>;
    request(method: 'workspace.writeFile', params: { path: string; text: string }): Promise<{ mtimeMs: number }>;
    request(
      method: 'dialog.confirmClose',
      params: { files: string[] },
    ): Promise<{ choice: 'save' | 'discard' | 'cancel' }>;
    request(method: 'app.closeProject'): Promise<void>;
    request(method: 'window.close'): Promise<void>;
    request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  };
  /** Вкладки: закрыть прежнюю при «Сохранить как». */
  openEditors: { close(path: string): void };
  /** Что делать с текстом при записи — те же правила, что у автосохранения. */
  save: {
    policy(): SavePolicy;
    format(document: TextDocument): Promise<unknown>;
  };
  git: {
    saveBeforeCommit(): boolean | undefined;
    saveBeforeCheckout(): boolean | undefined;
    refresh(): Promise<unknown>;
  };
  roots(): readonly WorkspaceRoot[];
  openPath(path: string): Promise<void>;
  refreshTree(): void;
  confirm(message: ConfirmAsk): Promise<boolean>;
  showToast(message: string, kind?: ToastKind, options?: ToastOptions): void;
  basename(path: string): string;
}

export interface FileWrite {
  saveDocument(document: TextDocument): Promise<boolean>;
  saveDocumentAs(document: TextDocument): Promise<boolean>;
  saveDirtyForGit(): Promise<boolean>;
  prepareCheckout(): Promise<boolean>;
  closeWindowSafely(toLauncher?: boolean): Promise<void>;
  /** Флаг «окно уже закрывается» — второй вопрос человеку не нужен. */
  isClosing(): boolean;
}

export function createFileWrite(ports: FileWritePorts): FileWrite {
  const { documents, showToast, basename } = ports;

  // Закрытие со своим флагом: свой `window.close` не должен спрашивать второй раз.
  let closing = false;

  /**
   * Сохранить документ на диск. Если файл изменился снаружи после нашего чтения, молча
   * писать нельзя — перетрём чужую правку (ассистента, из терминала). Спрашиваем и
   * перезаписываем только с согласия. `false` — человек отменил.
   */
  const saveDocument = async (document: TextDocument): Promise<boolean> => {
    // Файл только для чтения (большой) сохранять нечего: правок в нём быть не может.
    if (document.readOnly) {
      showToast('Файл открыт только для чтения — сохранять нечего', 'error');
      return false;
    }
    const policy = ports.save.policy();
    // Правки текста при сохранении: подрезать хвосты и поставить перевод строки.
    // Проводим через документ — тогда и на экране, и на диске одно и то же.
    const prepared = applySaveEdits(document.value, policy);
    if (prepared !== document.value) document.setText(prepared, 'programmatic');
    // Форматирование при сохранении: правку проводит документ, поэтому на экране и на
    // диске оказывается одно и то же.
    if (policy.formatOnSave) await ports.save.format(document);
    const result = await ports.edits.saveDocument(document);
    if (result === 'conflict') {
      const confirmed = await ports.confirm({
        title: 'Файл изменён на диске',
        message: `Файл «${basename(document.path)}» изменён после того, как его открыли.`,
        detail:
          'На диске уже другая версия — вероятно, её записал ассистент или другой инструмент. ' +
          'Если сохранить сейчас, правки из редактора заменят то, что там записано. Продолжить?',
        confirmLabel: 'Перезаписать',
      });
      if (!confirmed) return false;
      await ports.edits.saveDocument(document, { force: true });
    }
    showToast(`Сохранено: ${basename(document.path)}`);
    return true;
  };

  /**
   * Сохранить несохранённые буферы перед операцией, которая читает рабочее дерево.
   *
   * Коммит (и исправление коммита) работает с файлами на диске, а не с экраном: без этого
   * правки из буфера в коммит не попадали, зато вкладка оставалась с пометкой «не
   * сохранён» — и работа человека терялась из виду.
   *
   * `false` — сохранить не удалось: человек отказался перезаписывать файл, который
   * изменили снаружи, или файл открыт только для чтения. Тогда операцию не начинаем:
   * иначе она прошла бы по устаревшему содержимому.
   */
  const saveDirtyForGit = async (): Promise<boolean> => {
    // План решает `core/file-actions.ts`: что сохранять и что нельзя (только чтение).
    const plan = planCommitSave(documents.dirty(), ports.git.saveBeforeCommit() ?? true);
    if (plan.blocked.length > 0) {
      // Файлы только для чтения сохранить нельзя, а git смотрит диск: коммит ушёл бы по
      // устаревшему содержимому. Отказываем и называем виновников.
      showToast(`Не сохранить (только чтение): ${plan.blocked.length}`, 'error');
      return false;
    }
    for (const path of plan.save) {
      const document = documents.get(path);
      if (document && !(await saveDocument(document))) return false;
    }
    // Файлы на диске только что изменились, а снимок статуса git у нас ещё прежний: без
    // пересчёта коммит решил бы, что правок нет (его модель помнит старый ответ).
    await ports.git.refresh().catch(() => undefined);
    return true;
  };

  /**
   * Сторож для действий, меняющих рабочее дерево под ногами (checkout).
   *
   * Отличия от `saveDirtyForGit`: у checkout своя настройка (иначе человек, разрешивший
   * сохранять перед коммитом, не ждал бы того же перед ветвью), и отказ здесь не «не
   * сохранил», а «я сохранил, а ты всё равно потеряешь».
   *
   * `false` — переключаться нельзя.
   */
  const prepareCheckout = async (): Promise<boolean> => {
    const plan: CheckoutPlan = planCheckout(documents.dirty(), ports.git.saveBeforeCheckout() ?? true);
    if (plan.blocked.length > 0) {
      // Сохранить нечего — файл только для чтения. git смотрит диск, а на экране текст,
      // которого на диске нет: переключение молча выкинет его.
      showToast(`Не сохранить (только чтение): ${plan.blocked.length}`, 'error');
      return false;
    }
    if (plan.ask) {
      // Сохранять запрещено настройкой: решает человек, а не догадка.
      const confirmed = await ports.confirm({
        title: 'Есть несохранённые файлы',
        message: 'Переключение ветки идёт по диску — несохранённое в ней не участвует. Сохранить и переключиться?',
        confirmLabel: 'Сохранить и переключиться',
      });
      if (!confirmed) return false;
      for (const document of documents.dirty().filter((file) => !file.readOnly)) {
        if (!(await saveDocument(document))) return false;
      }
    }
    for (const path of plan.save) {
      const document = documents.get(path);
      if (document && !(await saveDocument(document))) return false;
    }
    if (plan.save.length > 0 || plan.ask) await ports.git.refresh().catch(() => undefined);
    return true;
  };

  /**
   * Сохранить документ ПОД ДРУГИМ ИМЕНЕМ (Save As). Путь выбирает человек системным
   * диалогом, поэтому, в отличие от Ctrl+S, запись идёт не по пути документа, а по
   * выбранному. Прежний файл на диске остаётся как был — это копия, и терять его правкой
   * «сохранить как» неправильно.
   *
   * Вкладка переезжает на новый файл: несохранённые правки уезжают вместе с ней, поэтому
   * закрытие прежней вкладки ничего не теряет. Правки при сохранении (хвосты, перевод
   * строки, формат) — те же, что у Ctrl+S: иначе текст на диске зависел бы от того, каким
   * путём его сохранили.
   */
  const saveDocumentAs = async (document: TextDocument): Promise<boolean> => {
    if (document.readOnly) {
      showToast('Файл открыт только для чтения — сохранить как нельзя', 'error');
      return false;
    }
    const asked = await ports.rpc
      .request('dialog.saveFile', { title: 'Сохранить как', defaultPath: document.path })
      .catch(() => ({ path: null }));
    const picked = asked.path;

    // Что делать с выбранным путём — решает чистая функция: отмена, тот же путь (обычное
    // сохранение) или путь вне рабочей области. Здесь остаётся запись.
    const decision = decideSaveAs(document.path, picked, ports.roots());
    if (decision.kind === 'cancel') return false;
    if (decision.kind === 'same-path') return saveDocument(document);
    if (decision.kind === 'outside') {
      showToast(decision.message, 'error');
      return false;
    }
    const target = decision.target;

    const policy = ports.save.policy();
    const prepared = applySaveEdits(document.value, policy);
    if (prepared !== document.value) document.setText(prepared, 'programmatic');
    if (policy.formatOnSave) await ports.save.format(document);

    try {
      await ports.rpc.request('workspace.writeFile', { path: target, text: document.value });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      showToast(`Не удалось сохранить как ${basename(target)}: ${reason}`, 'error');
      return false;
    }

    // Вкладка переходит на новый файл. Прежнюю закрываем: два документа с одним текстом на
    // экране только путают, а правки уже записаны в новый файл.
    ports.openEditors.close(document.path);
    await ports.openPath(target);
    ports.refreshTree();
    showToast(`Сохранено как ${basename(target)}`);
    return true;
  };

  /**
   * Закрытие окна с несохранёнными файлами. Сессию пишем всегда — это последний шанс
   * сохранить рабочее место. А правки терять нельзя, поэтому закрытие отменяем и
   * спрашиваем системным диалогом; окно при этом остаётся живым: Electron по умолчанию не
   * игнорирует отмену из `beforeunload`.
   *
   * `toLauncher` — куда уходит закрытое окно: «Закрыть проект» возвращает человека к списку
   * проектов (его поднимает main), обычное закрытие — просто выход. Стартовое окно просим
   * ПЕРЕД своим закрытием: отправить ответ в уничтоженное окно невозможно, и вызов остался
   * бы без результата.
   */
  const closeWindowSafely = async (toLauncher = false): Promise<void> => {
    closing = true;
    try {
      const files = documents.dirty();
      if (files.length > 0) {
        const { choice } = await ports.rpc.request('dialog.confirmClose', { files: files.map((file) => file.path) });
        if (choice === 'cancel') return;
        if (choice === 'save') {
          for (const file of files) {
            // Отмена перезаписи — окно оставляем: правки ещё в редакторе.
            if (!(await saveDocument(file))) return;
          }
        }
      }
      if (toLauncher) await ports.rpc.request('app.closeProject');
      // «Сохранить» и «Выйти без сохранения» ведут сюда: этот `window.close` проходит без
      // повторного вопроса — флаг `closing` уже поднят.
      await ports.rpc.request('window.close');
    } catch (error) {
      // Сохранение не прошло — окно оставляем, иначе правки пропадут молча.
      showToast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      closing = false;
    }
  };

  return {
    saveDocument,
    saveDocumentAs,
    saveDirtyForGit,
    prepareCheckout,
    closeWindowSafely,
    isClosing: () => closing,
  };
}

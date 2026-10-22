import { hunkAtLine } from '../../shared/hunk-lines';
import type { GitModel } from './git-model';
import type { ChangeGutterController } from './change-gutter';
import type { DebugController } from './debug';
import type { WorkspaceModel } from './workspace-model';
import type { ExplorerView } from '../ui/explorer';
import type { PromptModalView } from '../ui/prompt-modal';
import type { EditorWorkspace } from '../editor/host/editor-workspace';
import type { DocumentStore } from './document-store';
import type { TextDocument } from './document';
import { showPopupMenu, type PopupMenuItem } from '../ui/popup-menu';
import { showToast } from '../ui/toast';

/**
 * Меню жёлоба: точка останова (клик по полю номеров строк) и блок изменений
 * (правый клик по полоске). Оба ставятся по месту последнего нажатия — у самого
 * события контекстного меню координат окна нет, поэтому модуль держит их сам.
 *
 * Что делать с точкой, решает `debug` (у него набор точек и условия), что делать
 * с блоком — `git` и `changeGutter`: меню только собирает пункты и спрашивает
 * подтверждение там, где действие теряет правки.
 */
export interface GutterMenusDeps {
  git: GitModel;
  debug: DebugController;
  workspace: WorkspaceModel;
  explorer: ExplorerView;
  editors: EditorWorkspace;
  documents: DocumentStore;
  changeGutter: ChangeGutterController;
  /** Поле ввода под условие точки останова — общее окно приложения. */
  conditionInput: PromptModalView;
  /** Сохранить правку перед действием, которое её потеряет. */
  saveDocument(document: TextDocument): Promise<boolean>;
  /** Перечитать файл в открытом редакторе, если он там есть. */
  reloadIfOpen(path: string): Promise<void> | void;
  /** Общий диалог подтверждения (`dialog.confirm`). */
  confirm(options: {
    title: string;
    message: string;
    detail?: string;
    confirmLabel?: string;
  }): Promise<{ confirmed: boolean }>;
}

export function createGutterMenus(deps: GutterMenusDeps) {
  const { git, debug, workspace, explorer, editors, documents } = deps;
  const { changeGutter, conditionInput, saveDocument, reloadIfOpen, confirm } = deps;

  /** Меню точки останова по правому клику на поле номеров строк. */
  const openBreakpointMenu = ({ path, line }: { path: string; line: number }): void => {
    const breakpoint = debug.breakpointsOf(path).find((item) => item.line === line);
    const at = breakpoint ?? { line };

    /** Задать настройку точки и перерисовать значки. */
    const apply = (options: { condition?: string; hitCondition?: string; logMessage?: string }): void => {
      void debug.setBreakpointOptions(path, line, options).then((list) => editors.setBreakpoints(path, list));
    };

    showPopupMenu(
      [
        {
          label: at.condition ? 'Изменить условие…' : 'Условие останова…',
          onSelect: () => {
            conditionInput.open({
              title: 'Условие останова',
              label: `Строка ${line}`,
              value: at.condition ?? '',
              placeholder: 'например n > 100',
              confirmLabel: 'Задать',
              onAccept: (value) => apply({ ...at, condition: value }),
            });
          },
        },
        {
          label: at.hitCondition ? 'Изменить счётчик попаданий…' : 'Счётчик попаданий…',
          onSelect: () => {
            conditionInput.open({
              title: 'Счётчик попаданий',
              label: 'Сколько раз пройти мимо, прежде чем остановиться',
              value: at.hitCondition ?? '',
              placeholder: 'например 5 или >3',
              confirmLabel: 'Задать',
              onAccept: (value) => apply({ ...at, hitCondition: value }),
            });
          },
        },
        {
          label: at.logMessage ? 'Изменить сообщение журнала…' : 'Точка в журнал…',
          onSelect: () => {
            conditionInput.open({
              title: 'Точка в журнал',
              label: 'Сообщение; {выражение} подставит значение',
              value: at.logMessage ?? '',
              placeholder: 'например n = {n}',
              confirmLabel: 'Задать',
              onAccept: (value) => apply({ ...at, logMessage: value }),
            });
          },
        },
        {
          label: breakpoint ? 'Убрать точку останова' : 'Поставить точку останова',
          onSelect: () => void debug.toggleBreakpoint(path, line).then((list) => editors.setBreakpoints(path, list)),
        },
      ],
      lastPointer.x,
      lastPointer.y,
    );
  };

  // Правый клик на жёлобе: координаты берём из последнего события мыши — у самого
  // события контекстного меню нет координат окна, а меню ставится по месту нажатия.
  const lastPointer = { x: 0, y: 0 };

  /**
   * Правый клик по полоске изменения: меню одного БЛОКА правок.
   *
   * Работаем по строке, а строки у полосок и у diff согласуются только с рабочим
   * деревом: полоски считаются по тексту редактора, а git про буфер не знает. Чтобы
   * они не разъехались, сперва сохраняем файл — иначе `git apply` приложил бы блок
   * к другой версии файла. Не сохранилось (отказ от перезаписи) — меню не показываем.
   *
   * Блоков два набора: неиндексированные (`unstaged`) можно проиндексировать или
   * откатить, проиндексированные (`staged`) — убрать из индекса. Что под строкой,
   * решает `hunkAtLine` (общая граница блоков с `git-hunks`).
   */
  const openChangeStripMenu = async ({ path, line }: { path: string; line: number }): Promise<void> => {
    const document = documents.get(path) ?? null;
    if (document?.dirty) {
      if (!(await saveDocument(document))) return;
    }

    const hunks = await git.fileHunks(path).catch(() => ({ unstaged: [], staged: [] }));
    const unstagedIndex = hunkAtLine(hunks.unstaged, line);
    const stagedIndex = hunkAtLine(hunks.staged, line);

    if (unstagedIndex === null && stagedIndex === null) {
      showToast('Правок в этой строке нет', 'info');
      return;
    }

    /** После правки блока: полоски пересчитать, файл (если менялся на диске) перечитать. */
    const after = (reload: boolean): void => {
      changeGutter.refreshContent();
      if (reload) void reloadIfOpen(path);
      explorer.scheduleRefresh();
    };

    const items: PopupMenuItem[] = [];
    if (unstagedIndex !== null) {
      items.push({
        label: 'Проиндексировать это изменение',
        onSelect: () => void git.stageHunk(path, unstagedIndex).then(() => after(false)),
      });
    }
    if (stagedIndex !== null) {
      items.push({
        label: 'Убрать это изменение из индекса',
        onSelect: () => void git.unstageHunk(path, stagedIndex).then(() => after(false)),
      });
    }
    if (unstagedIndex !== null) {
      // Откат теряет правки безвозвратно — спрашиваем системным диалогом, как и у отката файла.
      items.push({ separator: true });
      items.push({
        label: 'Откатить это изменение',
        danger: true,
        onSelect: () => {
          void (async () => {
            const { confirmed } = await confirm({
              title: 'Откатить изменение',
              message: `Вернуть строку к состоянию индекса?`,
              detail: `${workspace.relative(path)} — блок изменений у строки ${line}. Правки в этом блоке будут потеряны.`,
              confirmLabel: 'Откатить',
            });
            if (!confirmed) return;
            await git.discardHunk(path, unstagedIndex);
            after(true);
          })();
        },
      });
    }

    showPopupMenu(items, lastPointer.x, lastPointer.y);
  };
  /** Запомнить место нажатия: у события контекстного меню координат окна нет. */
  const trackPointer = (x: number, y: number): void => {
    lastPointer.x = x;
    lastPointer.y = y;
  };

  return { openBreakpointMenu, openChangeStripMenu, trackPointer };
}

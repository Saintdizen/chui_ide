import { formatDuration, highlightedLines, hottestLines, profileSummary } from '../../shared/line-profile';
import type { DefineCommand } from './command-args';
import type { TextDocument } from './document';
import type { RpcClient } from './rpc';

/** Редактор глазами команд Python: текущий файл и подсветка строк профиля. */
export interface PythonEditorHost {
  readonly currentPath: string | null;
  setLineProfile(files: Iterable<[string, ReturnType<typeof highlightedLines>]>): void;
}

/**
 * Команды Python: окружения, профиль строк, зависимости.
 *
 * Профилировщик и установщик пакетов живут вне модуля (`core/line-profile.ts` и
 * `core/install-actions.ts`): здесь только меню, проверки и то, что человек увидит.
 */
export interface PythonCommandDeps {
  editors: PythonEditorHost;
  documents: { dirty(): readonly TextDocument[] };
  saveDocument(document: TextDocument): Promise<unknown>;
  venvModal: { open(): void };
  installRequirements(): Promise<void>;
  rpc: RpcClient;
  showToast(message: string, kind?: 'error'): void;
  basename(path: string): string;
}

export function registerPythonCommands(define: DefineCommand, deps: PythonCommandDeps): void {
  const { editors, documents, saveDocument, venvModal, installRequirements, rpc, showToast, basename } = deps;

  define(
    {
      id: 'python.environments',
      title: 'Python: виртуальные окружения',
      category: 'Python',
      // «venv» — как это называют на деле: без слова поиск в палитре не находит.
      keywords: ['venv', 'virtualenv', 'окружение', 'интерпретатор'],
    },
    () => void venvModal.open(),
  );

  // Профиль строк: свой профилировщик исполняет файл и говорит, где прошло время.
  // Перед запуском сохраняем правленое: профилировщик исполняет файл С ДИСКА, и без
  // сохранения профиль был бы про старую версию — то есть про не то, что на экране.
  define(
    {
      id: 'python.profileLines',
      title: 'Python: профиль строк',
      category: 'Python',
      keywords: ['профилировщик', 'profile', 'производительность', 'горячие строки', 'узкое место'],
    },
    async () => {
      const path = editors.currentPath;
      if (!path) {
        showToast('Нет открытого файла', 'error');
        return;
      }
      if (!path.toLowerCase().endsWith('.py')) {
        showToast('Профилировать можно файл Python (.py)', 'error');
        return;
      }
      for (const document of documents.dirty()) await saveDocument(document);
      showToast('Профилирую: файл исполняется медленно, это нормально');
      const result = await rpc.request('python.profileLines', { path }).catch(() => null);
      if (!result) {
        showToast('Профилирование не запустилось', 'error');
        return;
      }
      if (result.failed) {
        showToast(result.message ?? 'Профилирование не удалось', 'error');
        return;
      }
      const { profile } = result;
      editors.setLineProfile(profile.files.map((file) => [file.path, highlightedLines(file)] as const));
      if (profile.error) {
        // Строки профиля всё же показываем: до падения программа что-то успела сделать.
        showToast(`Программа упала: ${profile.error.trim().split('\n').at(-1) ?? 'см. вывод'}`, 'error');
        return;
      }
      const top = hottestLines(profile, 1)[0];
      const hot = top
        ? ` · горячее всего: ${basename(top.path)}:${top.line.line} (${formatDuration(top.line.timeNs)})`
        : '';
      showToast(`${profileSummary(profile)}${hot}`);
    },
  );

  define({ id: 'python.clearProfileLines', title: 'Python: убрать подсветку профиля', category: 'Python' }, () => {
    editors.setLineProfile([]);
  });

  define(
    {
      id: 'python.installRequirements',
      title: 'Python: установить зависимости',
      category: 'Python',
      keywords: ['pip', 'install', 'requirements', 'пакеты'],
    },
    () => installRequirements(),
  );
}

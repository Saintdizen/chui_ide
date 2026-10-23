import type { LspStatus } from '../../shared/lsp-status';
import { joinPath } from '../../shared/paths';
import { isEmptyTest, suggestTestPath, truncateTestCode } from '../../shared/test-generation';
import type { DefineCommand } from './command-args';

/**
 * Команды языка и тестов: панель тестов, перезапуск языковых серверов и
 * генерация теста к коду. Генерация — единственная из них, что пишет файл,
 * и она это делает намеренно: тест ложится в НОВЫЙ файл, чтобы человек его
 * прочитал и поправил, как обычный код.
 */

/** Что команде генерации нужно знать о документе и области. */
export interface CodeSource {
  readonly currentPath: string | null;
  selectedText(): string;
  activeLanguage(): string | null;
}

/** Область и корни: где лежит проект и какой корень владеет файлом. */
export interface WorkspacePort {
  readonly root: string | null;
  relative(path: string): string;
  ownerOf(path: string): { root: string } | null;
}

export interface LanguageDeps {
  dock: { show(view: 'tests'): void };
  rpc: {
    request(method: 'lsp.restart'): Promise<LspStatus>;
    request(method: 'ai.generateTest', payload: unknown): Promise<{ code: string }>;
    request(method: 'workspace.createFile', payload: { path: string; contents: string }): Promise<unknown>;
  };
  applyLspStatus(status: LspStatus): void;
  refreshLspStatus(): void;
  showToast(message: string, kind?: 'info' | 'error'): void;
  editors: CodeSource;
  documents: { get(path: string): { value: string } | undefined };
  workspace: WorkspacePort;
  aiEnabled(): boolean;
  warnAiDisabled(): void;
  explorer: { scheduleRefresh(): void };
  openPath(path: string): Promise<unknown>;
  /** Задержка перед перепроверкой после перезапуска — вынесена ради теста. */
  schedule(delayMs: number, run: () => void): void;
}

export function registerLanguageCommands(define: DefineCommand, deps: LanguageDeps): void {
  const { rpc, editors, workspace, showToast } = deps;

  define({ id: 'tests.open', title: 'Тесты: панель', category: 'Запуск', keywords: ['pytest', 'тесты', 'test'] }, () =>
    deps.dock.show('tests'),
  );

  define({ id: 'lsp.restart', title: 'Языковые серверы: перезапустить', category: 'Языки' }, async () => {
    const result = await rpc.request('lsp.restart');
    // Состояние после перезапуска — оно же и сняло «не поднялось»: показываем чип сразу.
    deps.applyLspStatus(result);
    showToast(
      result.running.length > 0
        ? `Серверы: ${result.servers.map((server) => server.label).join(', ')}`
        : 'Языковые серверы остановлены',
    );
    // Серверы поднимаются лениво, при открытии файлов: перепроверим, когда поднимутся.
    deps.schedule(1500, () => deps.refreshLspStatus());
  });

  /**
   * Тест к коду: берём выделение, а если его нет — активный файл целиком; тест
   * получаем кодом и кладём в НОВЫЙ файл по предложенному пути — чтобы человек его
   * посмотрел и поправил, как обычный код.
   */
  define(
    { id: 'ai.generateTest', title: 'Сгенерировать тест к коду', category: 'AI', keywords: ['тест', 'test'] },
    async () => {
      if (!deps.aiEnabled()) {
        deps.warnAiDisabled();
        return;
      }
      const path = editors.currentPath;
      if (!path) {
        showToast('Откройте файл', 'error');
        return;
      }
      const document = deps.documents.get(path);
      const code = editors.selectedText().trim() || document?.value.trim() || '';
      if (!code) {
        showToast('Нечего тестировать: пустой файл', 'info');
        return;
      }

      const relative = workspace.relative(path);
      const testRelative = suggestTestPath(relative);
      if (!testRelative) {
        showToast('Это уже тест: файл теста к тесту не создаём', 'info');
        return;
      }
      const root = workspace.ownerOf(path)?.root ?? workspace.root;
      if (!root) {
        showToast('Сначала откройте проект', 'error');
        return;
      }

      const truncated = truncateTestCode(code);
      showToast('Пишу тест…', 'info');
      let result: { code: string };
      try {
        result = await rpc.request('ai.generateTest', {
          language: editors.activeLanguage(),
          relativePath: relative,
          code: truncated.text,
          testPath: testRelative,
        });
      } catch (error) {
        showToast(error instanceof Error ? error.message : String(error), 'error');
        return;
      }
      if (isEmptyTest(result.code)) {
        showToast('Модель не предложила тест', 'info');
        return;
      }

      const target = joinPath(root, testRelative);
      try {
        await rpc.request('workspace.createFile', { path: target, contents: `${result.code}\n` });
      } catch (error) {
        // Файл уже есть — не перетираем чужой тест, а честно об этом говорим.
        showToast(error instanceof Error ? error.message : String(error), 'error');
        return;
      }

      deps.explorer.scheduleRefresh();
      await deps.openPath(target);
      showToast(`Тест создан: ${testRelative}`);
    },
  );
}

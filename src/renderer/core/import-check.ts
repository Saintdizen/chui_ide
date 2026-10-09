import type { LspDiagnostic } from '../../shared/api';
import { missingImports, parsePythonImports, parseScriptImports, topLevelModules, type ImportRef } from '../../shared/imports';
import type { DocumentStore } from './document-store';
import type { EditorService } from './editor-service';
import type { RpcClient } from './rpc';

/**
 * Подчёркивание импортов, чьи библиотеки не установлены.
 *
 * Идея простая: разобрали текст файла — узнали, какие модули он подключает,
 * спросили main, каких из них не видит проект (интерпретатор у Python, каталоги
 * `node_modules` у JS/TS), и подчеркнули только их. Всё, что можно решить в
 * renderer, решается здесь; вопрос «что установлено» уезжает в main.
 *
 * Пометки кладём под своим `owner`, поэтому они живут рядом с пометками LSP и
 * не затирают друг друга.
 *
 * Проверка идёт с задержкой и не на каждое нажатие: разбор текста дешёвый, а вот
 * запуск интерпретатора и обход `node_modules` — нет.
 */

const OWNER = 'imports';
/** Пауза после правки: пока человек печатает, спрашивать бессмысленно. */
const DELAY = 600;

export class ImportChecker {
  /** Таймеры отложенной проверки по каждому файлу. */
  private readonly timers = new Map<string, number>();
  /** Что уже проверено: одни и те же импорты не гоняем по кругу. */
  private readonly checked = new Map<string, string>();
  /**
   * Недостающие импорты по файлам. Нужны быстрой правке «поставить пакет»:
   * маркер Monaco не помнит имя модуля, а по позиции его не восстановить.
   */
  private readonly lastMissing = new Map<string, ImportRef[]>();

  constructor(
    private readonly rpc: RpcClient,
    private readonly documents: DocumentStore,
    private readonly editors: EditorService,
  ) {}

  attach(): void {
    for (const document of this.documents.all()) this.schedule(document.path);
    // Открыли файл заново — проверяем заново: библиотеку могли поставить, пока его не было.
    this.documents.onDidOpen((document) => {
      this.checked.delete(document.path);
      this.schedule(document.path);
    });
    this.documents.onDidChange(({ document }) => this.schedule(document.path));
    this.documents.onDidClose((document) => {
      this.cancel(document.path);
      this.editors.setExternalMarkers(document.path, OWNER, []);
    });
  }

  /**
   * Перепроверить всё открытое. Нужно, когда меняется окружение: поставили
   * библиотеку, создали venv, сменили путь к интерпретатору в настройках.
   */
  refresh(): void {
    this.checked.clear();
    for (const document of this.documents.all()) this.schedule(document.path);
  }

  private cancel(path: string): void {
    const timer = this.timers.get(path);
    if (timer !== undefined) window.clearTimeout(timer);
    this.timers.delete(path);
    this.checked.delete(path);
    this.lastMissing.delete(path);
  }

  private schedule(path: string): void {
    const timer = this.timers.get(path);
    if (timer !== undefined) window.clearTimeout(timer);
    this.timers.set(
      path,
      window.setTimeout(() => void this.check(path), DELAY),
    );
  }

  private async check(path: string): Promise<void> {
    this.timers.delete(path);

    const document = this.documents.get(path);
    if (!document) return;

    const rule = ruleFor(document.languageId);
    if (!rule) {
      this.lastMissing.delete(path);
      this.editors.setExternalMarkers(path, OWNER, []);
      return;
    }

    const imports = rule.parse(document.value);
    const modules = topLevelModules(imports);
    if (modules.length === 0) {
      this.checked.delete(path);
      this.lastMissing.delete(path);
      this.editors.setExternalMarkers(path, OWNER, []);
      return;
    }

    // Набор импортов не изменился — прошлый ответ всё ещё верен.
    const signature = modules.join(',');
    if (this.checked.get(path) === signature) return;

    let missing: string[];
    try {
      ({ missing } = await this.rpc.request('imports.missing', {
        language: document.languageId,
        modules,
      }));
    } catch {
      return; // без ответа подчёркивать нечего: молчание безопаснее ложной пометки
    }

    // Пока ходили в main, текст мог измениться — тогда пометки ставить рано.
    const current = this.documents.get(path);
    if (!current || current.value !== document.value) return;
    this.checked.set(path, signature);

    const names = new Set(missing);
    const refs = missingImports(imports, names);
    // Быстрая правка берёт отсюда имя модуля: у маркера Monaco его нет.
    this.lastMissing.set(path, refs);

    const diagnostics: LspDiagnostic[] = refs.map((item) => ({
      severity: 'warning',
      line: item.line,
      column: item.startColumn,
      endLine: item.line,
      endColumn: item.endColumn,
      message: rule.message(item),
      source: 'chui',
    }));

    this.editors.setExternalMarkers(path, OWNER, diagnostics);
  }

  /** Недостающие импорты файла: по ним быстрая правка предлагает поставить пакет. */
  missingFor(path: string): readonly ImportRef[] {
    return this.lastMissing.get(path) ?? [];
  }
}

/** Как разбирать и как называть проблему — у каждого языка своё. */
interface LanguageRule {
  parse(text: string): ImportRef[];
  message(item: ImportRef): string;
}

function ruleFor(languageId: string): LanguageRule | null {
  if (languageId === 'python') {
    return {
      parse: parsePythonImports,
      message: (item) => `Модуль «${item.top}» не установлен в окружении проекта`,
    };
  }
  if (languageId === 'javascript' || languageId === 'typescript') {
    return {
      parse: parseScriptImports,
      message: (item) => `Пакет «${item.top}» не установлен в node_modules`,
    };
  }
  return null;
}

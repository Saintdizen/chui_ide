/**
 * Проверка проекта на старте — источник пометок, которые не зависят от открытых файлов.
 *
 * Зачем: языковой сервер и проверка импортов говорят только про открытые документы.
 * Пока первый файл не открыт, «Проблемы» пусты, а счётчики в статус-баре молчат —
 * и это читается как «всё чисто», хотя не проверено ничего. Здесь один фонный
 * проход по всему корню (линтер + зависимости) кладёт пометки под своим владельцем.
 *
 * Чужие пометки не трогаем: место хранения держит их по владельцу (`project`
 * против `lsp` и `imports`), поэтому проверка проекта не затирает ответ сервера,
 * а сервер не затирает её.
 *
 * Правила:
 *   • два прохода одновременно не идут — второй видит `running` и ждёт ума;
 *   • смена проекта отменяет результат в полёте (`token`) и снимает старые пометки;
 *   • отказ связи — фаза `failed` с человеческой причиной, а не тишина.
 */
import type { LspDiagnostic } from '../../shared/api';
import type { ProjectAnalysis, ProjectProblem } from '../../shared/project-analysis';

/** Владелец пометок проекта. Отличие от `lsp`/`imports` — их никто не чистит вместе. */
export const PROJECT_CHECK_OWNER = 'project';

/** Что видно снаружи: чем кончилась проверка и в каком она состоянии. */
export interface ProjectCheckState {
  phase: 'idle' | 'running' | 'done' | 'failed';
  /** Чем проверяли код; `null` — проверять нечем. */
  tool: string | null;
  /** Сколько файлов получило пометки. */
  files: number;
  problems: number;
  /** Причина отказа или что не удалось проверить. */
  note: string | null;
}

/** Что сервису нужно от окружения: `root` — чтобы отбросить устаревший ответ. */
export interface ProjectCheckPorts {
  root: () => string | null;
  analyze: () => Promise<ProjectAnalysis>;
  /** Положить пометки файла под владельцем (чужие владельцы не трогаются). */
  setMarkers: (path: string, owner: string, diagnostics: readonly LspDiagnostic[]) => void;
  onState?: (state: ProjectCheckState) => void;
}

/** Пометка проекта в форме, которую понимает редактор. */
export function toDiagnostics(problem: ProjectProblem): LspDiagnostic {
  return {
    severity: problem.severity === 'info' ? 'info' : problem.severity,
    line: problem.line,
    column: problem.column,
    // Конец не знаем: линтер даёт точку, а не диапазон. Подсветка одного символа
    // лучше пустой полоски в ноль длины — её не видно.
    endLine: problem.line,
    endColumn: problem.column + 1,
    message: problem.message,
    source: problem.source,
    ...(problem.code ? { code: problem.code } : {}),
  };
}

/** Разложить пометки по файлам — по одной пачке на путь. */
export function groupByPath(problems: readonly ProjectProblem[]): Map<string, LspDiagnostic[]> {
  const grouped = new Map<string, LspDiagnostic[]>();
  for (const problem of problems) {
    const list = grouped.get(problem.path);
    if (list) list.push(toDiagnostics(problem));
    else grouped.set(problem.path, [toDiagnostics(problem)]);
  }
  return grouped;
}

export class ProjectCheck {
  private current: ProjectCheckState = { phase: 'idle', tool: null, files: 0, problems: 0, note: null };
  /** Пути, куда мы положили пометки: их же и снимаем перед следующим проходом. */
  private touched: string[] = [];
  /** Номер прохода: ответ из прошлого проекта не должен попасть в новый. */
  private token = 0;
  private busy = false;

  constructor(private readonly ports: ProjectCheckPorts) {}

  state(): ProjectCheckState {
    return { ...this.current };
  }

  /** Идёт ли проход прямо сейчас: по нему статус-бар пишет «проверяю…». */
  checking(): boolean {
    return this.current.phase === 'running';
  }

  /** Сменить проект: снять свои пометки — у нового корня они про чужой код. */
  reset(): void {
    this.token += 1;
    this.dropMarkers();
    this.emit({ phase: 'idle', tool: null, files: 0, problems: 0, note: null });
  }

  /** Один проход. Повторный вызов во время прохода — no-op: второй ответ ничего не уточнит. */
  async run(): Promise<void> {
    const root = this.ports.root();
    if (!root || this.busy) return;
    this.busy = true;
    const token = ++this.token;
    this.dropMarkers();
    this.emit({ phase: 'running', tool: null, files: 0, problems: 0, note: null });

    try {
      const analysis = await this.ports.analyze();
      // Ответ мог прийти уже после смены проекта — тогда он про чужой корень.
      if (token !== this.token) return;
      const grouped = groupByPath(analysis.problems);
      for (const [filePath, diagnostics] of grouped) {
        this.ports.setMarkers(filePath, PROJECT_CHECK_OWNER, diagnostics);
      }
      this.touched = [...grouped.keys()];
      this.emit({
        phase: 'done',
        tool: analysis.tool,
        files: grouped.size,
        problems: analysis.problems.length,
        note: analysis.note,
      });
    } catch (error) {
      if (token !== this.token) return;
      const reason = (error as { message?: unknown } | null)?.message;
      this.emit({
        phase: 'failed',
        tool: null,
        files: 0,
        problems: 0,
        note:
          typeof reason === 'string' && reason
            ? `Проверка проекта не удалась: ${reason}`
            : 'Проверка проекта не удалась',
      });
    } finally {
      this.busy = false;
    }
  }

  private dropMarkers(): void {
    for (const filePath of this.touched) this.ports.setMarkers(filePath, PROJECT_CHECK_OWNER, []);
    this.touched = [];
  }

  private emit(next: ProjectCheckState): void {
    this.current = next;
    this.ports.onState?.(this.state());
  }
}

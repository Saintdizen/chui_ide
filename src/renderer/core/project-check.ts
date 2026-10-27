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
import {
  PROJECT_STAGES,
  type ProjectAnalysis,
  type ProjectProblem,
  type ProjectStage,
  type ProjectStageEvent,
} from '../../shared/project-analysis';

/** Владелец пометок проекта. Отличие от `lsp`/`imports` — их никто не чистит вместе. */
export const PROJECT_CHECK_OWNER = 'project';
/** Пометки проверки типов — свой владелец: линтер и tsc друг друга не стирают. */
export const PROJECT_TYPES_OWNER = 'project-types';

/** Что видно снаружи: чем кончилась проверка и в каком она состоянии. */
export interface ProjectCheckState {
  phase: 'idle' | 'running' | 'done' | 'failed';
  /** Чем проверяли код; `null` — проверять нечем. */
  tool: string | null;
  /** Сколько файлов получило пометки. */
  files: number;
  problems: number;
  /** Проход не уложился во время: список может быть неполным. */
  timedOut: boolean;
  /** Причина отказа или что не удалось проверить. */
  note: string | null;
  /**
   * Ход прохода для полосы в строке состояния; `null` — показывать нечего.
   * Числа здесь только одни — сколько шагов сделано: середину шага не знает никто.
   */
  progress: ProjectCheckProgress | null;
}

/** Что знает полоса прогресса: готовые шаги и те, что ещё идут. */
export interface ProjectCheckProgress {
  done: number;
  total: number;
  running: ProjectStage[];
}

/**
 * Что сервису нужно от окружения: `root` — чтобы отбросить устаревший ответ.
 * `owner` разводит независимые проходы (линтер и типы): пометки у каждого свои
 * и закрытие одного не стирает пометки другого.
 */
export interface ProjectCheckPorts {
  root: () => string | null;
  /**
   * Проход целиком. `onStage` зовут события хода — они есть у линтера
   * (`project.analyze`) и нет у tsc: там одна неделимая команда.
   */
  analyze: (onStage: (event: ProjectStageEvent) => void) => Promise<ProjectAnalysis>;
  /** Положить пометки файла под владельцем (чужие владельцы не трогаются). */
  setMarkers: (path: string, owner: string, diagnostics: readonly LspDiagnostic[]) => void;
  /** Владелец пометок; по умолчанию `project`. */
  owner?: string;
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
  private current: ProjectCheckState = {
    phase: 'idle',
    tool: null,
    files: 0,
    problems: 0,
    timedOut: false,
    note: null,
    progress: null,
  };
  /** Пути, куда мы положили пометки: их же и снимаем перед следующим проходом. */
  private touched: string[] = [];
  /** Номер прохода: ответ из прошлого проекта не должен попасть в новый. */
  private token = 0;
  private busy = false;

  constructor(
    private readonly ports: ProjectCheckPorts,
    /** План прохода: его длина и есть «сколько всего» для полосы. Пусто — проход неделим. */
    private readonly stages: readonly ProjectStage[] = PROJECT_STAGES,
  ) {}

  /** Ход прохода для строки состояния; `null` — говорить нечего. */
  progress(): ProjectCheckProgress | null {
    return this.current.phase === 'running' ? this.current.progress : null;
  }

  /** Владелец пометок: у линтера `project`, у типов — свой (см. `owner` в портах). */
  private get owner(): string {
    return this.ports.owner ?? PROJECT_CHECK_OWNER;
  }

  state(): ProjectCheckState {
    return { ...this.current };
  }

  /** Идёт ли проход прямо сейчас: по нему статус-бар пишет «проверяю…». */
  checking(): boolean {
    return this.current.phase === 'running';
  }

  /**
   * Почему нолям верить нельзя, или `null`, если проверка работу сделала.
   * Пустой список без линтера и проваленный проход — это не «всё чисто»:
   * без этой строки виджет молчит, и молчание читается как чистота.
   */
  unchecked(): string | null {
    if (this.current.phase === 'failed') return this.current.note ?? 'Проверка проекта не удалась';
    if (this.current.phase === 'done' && this.current.tool === null) {
      return this.current.note ?? 'Проверять код нечем: в проекте нет линтера';
    }
    // Холодный старт: прохода ещё не было. Без проекта это не проблема — молчим.
    if (this.current.phase === 'idle' && this.ports.root()) return 'Проект ещё не проверялся';
    return null;
  }

  /** Проход был, но не уложился во время: найденное верно, а список — не весь. */
  partial(): boolean {
    return this.current.phase === 'done' && this.current.timedOut;
  }

  /** Сменить проект: снять свои пометки — у нового корня они про чужой код. */
  reset(): void {
    this.token += 1;
    this.dropMarkers();
    this.emit({ phase: 'idle', tool: null, files: 0, problems: 0, timedOut: false, note: null, progress: null });
  }

  /** Один проход. Повторный вызов во время прохода — no-op: второй ответ ничего не уточнит. */
  async run(): Promise<void> {
    const root = this.ports.root();
    if (!root || this.busy) return;
    this.busy = true;
    const token = ++this.token;
    this.dropMarkers();
    // До первого события все шаги считаются незакончёнными: полоса появляется сразу,
    // а не через секунду, когда придёт первый ответ. У неделимого прохода (tsc)
    // их ноль — значит, полоса будет бежать без чисел, и это правда.
    const done = new Set<ProjectStage>();
    this.emit({
      phase: 'running',
      tool: null,
      files: 0,
      problems: 0,
      timedOut: false,
      note: null,
      progress: { done: 0, total: this.stages.length, running: [...this.stages] },
    });
    const onStage = (event: ProjectStageEvent): void => {
      if (token !== this.token) return;
      if (event.phase === 'done') done.add(event.stage);
      this.emit({
        ...this.current,
        progress: {
          done: done.size,
          total: this.stages.length,
          running: this.stages.filter((stage) => !done.has(stage)),
        },
      });
    };

    try {
      const analysis = await this.ports.analyze(onStage);
      // Ответ мог прийти уже после смены проекта — тогда он про чужой корень.
      if (token !== this.token) return;
      const grouped = groupByPath(analysis.problems);
      for (const [filePath, diagnostics] of grouped) {
        this.ports.setMarkers(filePath, this.owner, diagnostics);
      }
      this.touched = [...grouped.keys()];
      this.emit({
        phase: 'done',
        tool: analysis.tool,
        files: grouped.size,
        problems: analysis.problems.length,
        timedOut: analysis.timedOut,
        note: analysis.note,
        progress: null,
      });
    } catch (error) {
      if (token !== this.token) return;
      const reason = (error as { message?: unknown } | null)?.message;
      this.emit({
        phase: 'failed',
        tool: null,
        files: 0,
        problems: 0,
        timedOut: false,
        note:
          typeof reason === 'string' && reason
            ? `Проверка проекта не удалась: ${reason}`
            : 'Проверка проекта не удалась',
        progress: null,
      });
    } finally {
      this.busy = false;
    }
  }

  private dropMarkers(): void {
    for (const filePath of this.touched) this.ports.setMarkers(filePath, this.owner, []);
    this.touched = [];
  }

  private emit(next: ProjectCheckState): void {
    this.current = next;
    this.ports.onState?.(this.state());
  }
}

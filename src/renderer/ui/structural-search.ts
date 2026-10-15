import {
  type StructuralMatch,
  type StructuralProjectMatches,
  type StructuralProjectOptions,
  type StructuralTemplate,
  hashCommentsForPath,
  literalTemplate,
  parseTemplate,
  structuralFind,
  structuralReplaceEdit,
} from '../../shared/structural-search';
import { clear, h } from './dom';
import { createModal } from './modal';
import { showToast } from './toast';

/** Результат замены по проекту: изменённые пути и число замен. */
export interface StructuralProjectResult {
  files: string[];
  replaced: number;
}

export interface StructuralSearchDeps {
  /** Текст активного файла (в редакторе — с несохранёнными правками). `null` — файла нет. */
  activeText(): string | null;
  /**
   * Путь активного файла: по расширению решается, считать ли `#` комментарием
   * (`#` в CSS или markdown — не комментарий). `null` — файла нет.
   */
  activePath(): string | null;
  /** Выделение редактора: из него берётся образец, если нажать «Из выделения». */
  selectionText(): string;
  /**
   * Применить замену одним шагом истории. `start`/`end` — смещения в тексте файла,
   * `inserted` — чем заменить участок. `false` — применить не удалось.
   */
  apply(edit: { start: number; end: number; inserted: string }): Promise<boolean> | boolean;
  /** Поиск по структуре по всему проекту — предпросмотр, без правок. */
  searchProject(options: StructuralProjectOptions): Promise<StructuralProjectMatches>;
  /** Замена по структуре по всему проекту: изменённые пути и число замен. */
  replaceProject(options: StructuralProjectOptions): Promise<StructuralProjectResult>;
  /** Перечитать открытый файл после замены на диске. */
  reloadFile(path: string): void | Promise<void>;
  /** Открыть файл из списка найденного (клик по имени файла). */
  openFile(path: string): Promise<void> | void;
}

export interface StructuralSearchView {
  element: HTMLElement;
  open(): void;
  close(): void;
}

/** Пауза перед пересчётом: на каждое нажатие искать по проекту не нужно. */
const DEBOUNCE = 150;

/** Сколько совпадений показывать списком: остальные — только числом. */
const MAX_SHOWN = 100;

/** Где искать: в активном файле или по всему проекту. */
type Scope = 'file' | 'project';

/**
 * Поиск и замена по структуре кода — окно поверх редактора.
 *
 * Поля простые: образец и замена. Образец пишется как код, только вместо «чего угодно»
 * ставят `$имя` (один кусок) или `$имя...` (последовательность). Поэтому `foo($x, $y)`
 * находит вызов `foo` с двумя доводами, как бы те ни были записаны в исходнике.
 *
 * Область переключается тут же: «В файле» — как раньше, «В проекте» — тем же образцом
 * по всем файлам проекта (предпросмотр списком, а потом замена). Это одно правило с
 * разным охватом, поэтому и одно окно, а не две команды.
 *
 * Почему окно, а не панель: этим пользуются редко и точечно — привести один вид записи
 * к другому. Держать такое постоянно на виду незачем, а кнопка «Из выделения» делает
 * образец из того, что человек уже выделил.
 */
export function createStructuralSearch(deps: StructuralSearchDeps): StructuralSearchView {
  let timer: number | null = null;
  let scope: Scope = 'file';
  // Ответ поиска по проекту приходит асинхронно и может опоздать: счётчик отбрасывает
  // устаревшие, чтобы на экран не попал результат от прежнего образца.
  let projectToken = 0;

  const patternInput = h('input', {
    class: 'field-input structural-pattern',
    type: 'text',
    spellcheck: 'false',
    placeholder: 'образец: foo($x, $y)',
  });
  const replacementInput = h('input', {
    class: 'field-input structural-replacement',
    type: 'text',
    spellcheck: 'false',
    placeholder: 'замена: bar($y, $x)',
  });
  const fromSelectionButton = h(
    'button',
    { class: 'btn btn-small', type: 'button', title: 'Взять образец из выделения редактора' },
    'Из выделения',
  );

  // Область поиска: в файле или по всему проекту. Правило одно, охват разный — потому
  // переключатель, а не отдельная команда: человек видит, что именно он собирается править.
  const fileScopeButton = h('button', { class: 'seg-btn is-active', type: 'button' }, 'В файле');
  const projectScopeButton = h('button', { class: 'seg-btn', type: 'button' }, 'В проекте');
  const scopeBar = h('div', { class: 'segmented structural-scope' }, fileScopeButton, projectScopeButton);

  const status = h('div', { class: 'structural-status' });
  const matchesBox = h('div', { class: 'structural-matches' });
  const applyButton = h('button', { class: 'btn btn-primary', type: 'button', disabled: true }, 'Заменить всё в файле');

  const modal = createModal({
    className: 'structural-modal',
    title: 'Замена по структуре кода',
    footer: h('footer', { class: 'modal-footer' }, applyButton),
  });
  modal.body.classList.add('structural-body');
  modal.body.append(
    h(
      'div',
      { class: 'structural-form' },
      h('div', { class: 'field-label' }, 'Область'),
      scopeBar,
      h('div', { class: 'field-label' }, 'Образец'),
      patternInput,
      h('div', { class: 'field-label' }, 'Замена'),
      h('div', { class: 'structural-replace-row' }, replacementInput, fromSelectionButton),
      h(
        'p',
        { class: 'field-hint' },
        'В образце: $имя — любой один кусок, $имя... — любая последовательность, $$ — знак доллара. ' +
          'В замене те же $имя подставляются на место пойманного.',
      ),
    ),
    h('div', { class: 'structural-output' }, status, matchesBox),
  );

  const report = (text: string, error = false): void => {
    status.textContent = text;
    status.classList.toggle('is-error', error);
  };

  const setApplyEnabled = (enabled: boolean): void => {
    applyButton.disabled = !enabled;
  };

  /** Параметры поиска по проекту: образец, замена и охват файлов. */
  const projectOptions = (): StructuralProjectOptions => ({
    pattern: patternInput.value,
    replacement: replacementInput.value,
  });

  /** Как читать активный файл: считать ли `#` комментарием (в CSS и markdown — нет). */
  const fileOptions = (): { hashComments: boolean } => {
    const path = deps.activePath();
    return { hashComments: path ? hashCommentsForPath(path) : true };
  };

  function renderMatches(matches: readonly StructuralMatch[]): void {
    clear(matchesBox);
    for (const match of matches.slice(0, MAX_SHOWN)) matchesBox.appendChild(matchRow(match, false));
    if (matches.length > MAX_SHOWN) {
      matchesBox.appendChild(h('div', { class: 'structural-more' }, `…и ещё ${matches.length - MAX_SHOWN}`));
    }
  }

  function matchRow(match: StructuralMatch, nested: boolean): HTMLElement {
    const captured = Object.entries(match.captures)
      .map(([name, value]) => `$${name} = ${flatten(value)}`)
      .join('   ');
    return h(
      'div',
      { class: `structural-match${nested ? ' is-nested' : ''}` },
      h('code', { class: 'structural-match-text' }, flatten(match.text)),
      captured ? h('span', { class: 'structural-match-captures' }, captured) : null,
    );
  }

  /** Найденное по проекту: файл строкой, под ним несколько мест — как в списке проблем. */
  function renderProjectMatches(result: StructuralProjectMatches): void {
    clear(matchesBox);
    for (const file of result.files) {
      matchesBox.appendChild(
        h(
          'div',
          { class: 'structural-file' },
          h(
            'button',
            {
              class: 'structural-file-name',
              type: 'button',
              title: file.path,
              onClick: () => void deps.openFile(file.path),
            },
            shortPath(file.path),
          ),
          h('span', { class: 'structural-file-count' }, String(file.count)),
        ),
      );
      for (const match of file.matches) matchesBox.appendChild(matchRow(match, true));
      if (file.count > file.matches.length) {
        matchesBox.appendChild(
          h('div', { class: 'structural-more is-nested' }, `…и ещё ${file.count - file.matches.length} в этом файле`),
        );
      }
    }
  }

  function compute(): void {
    const template = parseTemplate(patternInput.value);
    if (template.error) {
      report(template.error);
      clear(matchesBox);
      setApplyEnabled(false);
      return;
    }
    if (scope === 'project') {
      void computeProject();
      return;
    }
    computeFile(template);
  }

  function computeFile(template: StructuralTemplate): void {
    const text = deps.activeText();
    if (text === null) {
      report('Файл не открыт: заменять нечего.');
      clear(matchesBox);
      setApplyEnabled(false);
      return;
    }
    const matches = structuralFind(text, template, fileOptions());
    if (matches.length === 0) {
      report('Совпадений нет.');
      clear(matchesBox);
      setApplyEnabled(false);
      return;
    }
    report(`Совпадений: ${matches.length}`);
    renderMatches(matches);
    setApplyEnabled(true);
  }

  async function computeProject(): Promise<void> {
    const token = ++projectToken;
    report('Ищу по проекту…');
    clear(matchesBox);
    setApplyEnabled(false);
    let result: StructuralProjectMatches;
    try {
      result = await deps.searchProject(projectOptions());
    } catch (error) {
      if (token !== projectToken) return;
      report(error instanceof Error ? error.message : String(error), true);
      return;
    }
    // Пока ходили за ответом, образец могли поменять — прежний результат уже не нужен.
    if (token !== projectToken) return;
    if (result.total === 0) {
      report(`Совпадений нет (файлов прочитано: ${result.scanned}).`);
      return;
    }
    report(`Совпадений: ${result.total}, файлов: ${result.files.length}`);
    renderProjectMatches(result);
    setApplyEnabled(true);
  }

  function schedule(): void {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      compute();
    }, DEBOUNCE);
  }

  async function apply(): Promise<void> {
    const template = parseTemplate(patternInput.value);
    if (template.error) return;
    if (scope === 'project') await applyProject();
    else await applyFile(template);
  }

  async function applyFile(template: StructuralTemplate): Promise<void> {
    const text = deps.activeText();
    if (text === null) return;
    const edit = structuralReplaceEdit(text, template, replacementInput.value, fileOptions());
    if (!edit) {
      report('Совпадений нет.');
      return;
    }
    setApplyEnabled(false);
    const ok = await deps.apply({ start: edit.start, end: edit.end, inserted: edit.inserted });
    if (ok) showToast(`Заменено по структуре: ${edit.count}`, 'success');
    else showToast('Замена не применена', 'error');
    compute();
  }

  async function applyProject(): Promise<void> {
    const template = parseTemplate(patternInput.value);
    if (template.error) return;
    setApplyEnabled(false);
    try {
      const result = await deps.replaceProject(projectOptions());
      // Замена писала файлы на диске: открытые вкладки перечитываем сразу, иначе
      // редактор показывал бы прежний текст — версию файла до замены.
      for (const path of result.files) await deps.reloadFile(path);
      if (result.replaced === 0) showToast('Совпадений нет', 'info');
      else showToast(`Заменено по структуре: ${result.replaced}, файлов: ${result.files.length}`, 'success');
    } catch (error) {
      showToast(error instanceof Error ? error.message : String(error), 'error');
    }
    compute();
  }

  function setScope(next: Scope): void {
    if (scope === next) return;
    scope = next;
    fileScopeButton.classList.toggle('is-active', next === 'file');
    projectScopeButton.classList.toggle('is-active', next === 'project');
    applyButton.textContent = next === 'project' ? 'Заменить всё в проекте' : 'Заменить всё в файле';
    compute();
  }

  fileScopeButton.addEventListener('click', () => setScope('file'));
  projectScopeButton.addEventListener('click', () => setScope('project'));
  patternInput.addEventListener('input', schedule);
  replacementInput.addEventListener('input', schedule);
  applyButton.addEventListener('click', () => void apply());
  fromSelectionButton.addEventListener('click', () => {
    const selection = deps.selectionText().trim();
    if (selection === '') {
      showToast('В редакторе ничего не выделено', 'info');
      return;
    }
    patternInput.value = literalTemplate(selection);
    compute();
  });

  function close(): void {
    modal.close();
  }

  return {
    element: modal.element,
    close,
    open() {
      compute();
      modal.open(patternInput);
      patternInput.select();
    },
  };
}

/** Однострочный вид куска: длинные и многострочные совпадения в списке не помещаются. */
function flatten(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? `${flat.slice(0, 77)}…` : flat;
}

/** Короткий вид пути: последние две части — полный путь уходит в подсказку. */
function shortPath(target: string): string {
  const parts = target.split(/[\\/]/);
  return parts.length <= 2 ? target : parts.slice(-2).join('/');
}

import type { ForgeInfo, ForgePipeline, PipelineState } from '../../shared/git-platform';
import { activePipelineCount, failedPipelineCount, platformLabel } from '../../shared/git-platform';
import type { GitModel } from '../core/git-model';
import { clear, h, svgIcon } from './dom';
import { createModal } from './modal';

export interface PipelinesModalDeps {
  git: GitModel;
  notify(message: string, kind?: 'info' | 'error'): void;
  /** Спросить подтверждение (перезапуск прогона — действие на площадке). */
  confirm(options: { title: string; message: string; detail?: string; confirmLabel?: string }): Promise<boolean>;
}

export interface PipelinesModalView {
  element: HTMLElement;
  open(): Promise<void>;
  close(): void;
}

/** Состояние прогона — словом и классом для значка (классы те же, что у запросов). */
const STATE_LABEL: Record<PipelineState, string> = {
  running: 'идёт',
  success: 'успех',
  failed: 'провал',
  pending: 'в очереди',
  canceled: 'отменён',
  skipped: 'пропущен',
  unknown: 'неизвестно',
};

/**
 * Экран прогонов CI площадки — Actions на GitHub, Pipelines на GitLab.
 *
 * Тот же приём, что у запросов и задач: разговор с площадкой ведёт консольный клиент
 * (`gh`/`glab`), а IDE показывает, что он вернул. Прямого API тут нет намеренно —
 * токены и вход остаются за клиентом (см. `ui/forge-modal.ts`).
 */
export function createPipelinesModal(deps: PipelinesModalDeps): PipelinesModalView {
  let info: ForgeInfo | null = null;
  let pipelines: ForgePipeline[] = [];
  let busy = false;

  const headline = h('div', { class: 'forge-headline' });
  const statusLine = h('div', { class: 'forge-status' });
  const list = h('div', { class: 'forge-list' });

  const refreshButton = h(
    'button',
    { class: 'icon-btn', type: 'button', title: 'Обновить список', onClick: () => void reload() },
    svgIcon('refresh', 14),
  );
  const modal = createModal({
    className: 'forge-modal',
    title: 'Прогоны CI',
    headerActions: [refreshButton],
  });
  modal.body.append(headline, statusLine, h('div', { class: 'settings-divider' }), list);

  const close = (): void => modal.close();

  const run = async (operation: () => Promise<void>): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      await operation();
    } catch (error) {
      deps.notify(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      busy = false;
    }
  };

  const renderHeadline = (): void => {
    clear(headline);
    if (!info?.repo) {
      headline.append(h('span', { class: 'forge-repo' }, 'Площадка не определена'));
      return;
    }
    headline.append(
      h('span', { class: 'forge-platform' }, platformLabel(info.repo.platform)),
      h('code', { class: 'forge-repo-name' }, `${info.repo.owner}/${info.repo.repo}`),
      h('span', { class: 'forge-remote' }, info.remote ? `удалённый: ${info.remote}` : ''),
    );
  };

  const renderStatus = (): void => {
    clear(statusLine);
    if (!info) return;
    if (info.cli) statusLine.append(h('p', { class: 'forge-line' }, `клиент ${info.cli}`));
    if (pipelines.length > 0) {
      const parts: string[] = [`всего: ${pipelines.length}`];
      const active = activePipelineCount(pipelines);
      const failed = failedPipelineCount(pipelines);
      if (active > 0) parts.push(`идёт: ${active}`);
      if (failed > 0) parts.push(`провалено: ${failed}`);
      statusLine.append(h('p', { class: 'forge-line' }, parts.join(' · ')));
    }
  };

  /** Одна строка списка: номер с заголовком, ветка, событие, время и действия. */
  const pipelineRow = (pipeline: ForgePipeline): HTMLElement => {
    const state = h('span', { class: `forge-state is-${pipeline.state}` }, STATE_LABEL[pipeline.state]);

    const open = h('button', { class: 'btn btn-small', type: 'button', title: 'Открыть на площадке' }, 'Открыть');
    open.addEventListener('click', () => {
      if (pipeline.url) void deps.git.openExternal(pipeline.url);
    });

    const buttons = h('div', { class: 'forge-row-actions' }, open);
    // Повторять имеет смысл только завершённый непройденный прогон: идущий — уже идёт.
    if (pipeline.state !== 'running' && pipeline.state !== 'pending' && pipeline.state !== 'success') {
      const rerun = h('button', { class: 'btn btn-small', type: 'button', title: 'Перезапустить прогон' }, 'Повторить');
      rerun.addEventListener('click', () => {
        void run(async () => {
          const confirmed = await deps.confirm({
            title: 'Перезапустить прогон',
            message: `Перезапустить прогон №${pipeline.id}?`,
            detail: 'Клиент площадки поставит новый прогон по тому же коммиту и ветке.',
            confirmLabel: 'Перезапустить',
          });
          if (!confirmed) return;
          pipelines = await deps.git.forgePipelineRerun(pipeline.id);
          deps.notify(`Прогон №${pipeline.id} перезапущен`);
          render();
        });
      });
      buttons.append(rerun);
    }

    return h(
      'div',
      { class: 'forge-item' },
      h(
        'div',
        { class: 'forge-row' },
        h(
          'div',
          { class: 'forge-row-info' },
          h(
            'div',
            { class: 'forge-row-title' },
            h('span', { class: 'forge-number' }, `#${pipeline.id}`),
            h('span', { class: 'forge-title' }, pipeline.title || '(без названия)'),
            state,
          ),
          h(
            'div',
            { class: 'forge-row-meta' },
            pipeline.branch ? h('code', { class: 'forge-branches' }, pipeline.branch) : null,
            pipeline.event ? h('span', {}, ` · ${pipeline.event}`) : null,
            pipeline.createdAt ? h('span', { class: 'forge-updated' }, ` · ${pipeline.createdAt}`) : null,
          ),
        ),
        buttons,
      ),
    );
  };

  const render = (): void => {
    renderHeadline();
    renderStatus();
    clear(list);
    if (!info) return;
    if (pipelines.length === 0) {
      list.append(h('p', { class: 'forge-empty' }, 'Прогонов нет — возможно, CI на этой площадке не настроен.'));
      return;
    }
    for (const pipeline of pipelines) list.append(pipelineRow(pipeline));
  };

  async function reload(): Promise<void> {
    try {
      info = await deps.git.forgeInfo();
      pipelines = info.repo && info.cli ? await deps.git.forgePipelines() : [];
    } catch (error) {
      info = null;
      pipelines = [];
      deps.notify(error instanceof Error ? error.message : String(error), 'error');
    }
    render();
  }

  async function open(): Promise<void> {
    modal.open();
    headline.replaceChildren();
    statusLine.replaceChildren(h('p', { class: 'field-hint' }, 'Спрашиваю git и клиента площадки…'));
    list.replaceChildren();
    await reload();
  }

  return { element: modal.element, open, close };
}

import { lspOriginLabel, type LspStatus } from '../../shared/lsp-status';
import type { RpcClient } from '../core/rpc';
import { h, svgIcon } from './dom';

/**
 * Попап языковых серверов в статусбаре.
 *
 * Отвечает на вопрос, который иначе приходится выяснять наугад: «почему тут нет
 * подсказок». Показывает то, что знает main: какой сервер обслуживает язык, откуда
 * он взят (поставка IDE, окружение проекта, PATH) и что поднять не удалось — с
 * причиной. Тут же кнопки «перезапустить» (это же и сброс неудачи) и «настройки».
 *
 * Данные спрашиваются при каждом открытии: попап мог провисеть долго, а серверы
 * поднимаются лениво, при открытии файлов. Пока свежие данные едут, показано
 * прошлое содержимое — тело не пустеет.
 */

export interface LspPopoverDeps {
  rpc: RpcClient;
  /** Перезапустить серверы: команда приложения (там и весточка о результате). */
  onRestart: () => void;
  /** Открыть раздел «Языки (LSP)» в настройках. */
  onOpenSettings: () => void;
}

export interface LspPopoverView {
  element: HTMLElement;
  refresh(): Promise<void>;
}

export function createLspPopover(deps: LspPopoverDeps): LspPopoverView {
  const body = h('div', { class: 'lsp-status-body' });

  const restartButton = h(
    'button',
    { class: 'btn btn-small lsp-status-action', type: 'button', onClick: () => deps.onRestart() },
    svgIcon('refresh', 12),
    h('span', {}, 'Перезапустить'),
  );
  const settingsButton = h(
    'button',
    { class: 'btn btn-small lsp-status-action', type: 'button', onClick: () => deps.onOpenSettings() },
    svgIcon('settings', 12),
    h('span', {}, 'Настройки'),
  );

  const element = h(
    'div',
    { class: 'lsp-status' },
    h('div', { class: 'lsp-status-title' }, 'Языковые серверы'),
    body,
    h('div', { class: 'lsp-status-actions' }, restartButton, settingsButton),
  );

  // Данные приходят асинхронно: без стража устаревший ответ переписал бы тело поверх свежего.
  let generation = 0;

  async function refresh(): Promise<void> {
    const mine = ++generation;
    const nodes: Node[] = [];
    const status = await readLspStatus(deps.rpc);
    if (mine !== generation) return;

    if (!status) {
      body.replaceChildren(h('div', { class: 'lsp-status-empty' }, 'Не удалось узнать состояние серверов.'));
      return;
    }

    if (status.servers.length === 0 && status.failed.length === 0) {
      nodes.push(
        h(
          'div',
          { class: 'lsp-status-empty' },
          'Серверы ещё не поднимались: они запускаются при открытии файла своего языка.',
        ),
      );
    }

    if (status.servers.length > 0) {
      nodes.push(h('div', { class: 'lsp-status-heading' }, 'Запущены'));
      for (const server of status.servers) {
        nodes.push(
          h(
            'div',
            { class: 'lsp-status-row' },
            h('span', { class: 'lsp-status-name' }, server.label),
            h('span', { class: 'lsp-status-lang' }, server.language),
            h('span', { class: 'lsp-status-origin' }, lspOriginLabel(server.origin)),
          ),
        );
      }
    }

    if (status.failed.length > 0) {
      nodes.push(h('div', { class: 'lsp-status-heading' }, 'Не поднялись'));
      for (const failure of status.failed) {
        nodes.push(
          h(
            'div',
            { class: 'lsp-status-row is-failed' },
            h('span', { class: 'lsp-status-name' }, failure.language),
            h('span', { class: 'lsp-status-origin' }, failure.reason),
          ),
        );
      }
      nodes.push(
        h(
          'div',
          { class: 'lsp-status-hint' },
          'Подсказок для этих языков не будет. Поставьте сервер в настройках или перезапустите, ' +
            'если окружение появилось только что.',
        ),
      );
    }

    body.replaceChildren(...nodes);
  }

  return { element, refresh };
}

/** Текущее состояние серверов (для чипа в статусбаре) — одна точка чтения. */
export function readLspStatus(rpc: RpcClient): Promise<LspStatus | null> {
  return rpc.request('lsp.status').catch(() => null);
}

import { performMenuRole } from '../../menu';
import { windowState } from '../../window';
import { senderWindow, type RpcServices } from '../context';
import type { RpcRouter } from '../router';

/**
 * Встроенный терминал и само окно: свернуть, развернуть, закрыть, выполнить роль
 * меню.
 *
 * Окно ищем по ОТПРАВИТЕЛЮ запроса (`ctx.sender`), а не по «текущему»: у
 * приложения бывает несколько окон, и слушаться должно то, из которого пришёл
 * вызов. Это `senderWindow` из `context.ts`: он нужен и диалогам.
 *
 * Перенесено из `register.ts` без правок логики.
 */
export function registerWindowMethods(router: RpcRouter, deps: RpcServices): void {
  router.register('terminal.create', async (params) => deps.terminals.create(params));
  router.register('terminal.write', (params) => {
    deps.terminals.write(params.id, params.data);
  });
  router.register('terminal.resize', (params) => {
    deps.terminals.resize(params.id, params.cols, params.rows);
  });
  router.register('terminal.kill', (params) => {
    deps.terminals.kill(params.id);
  });

  router.register('window.getState', (_params, ctx) => windowState(senderWindow(ctx)));
  router.register('window.minimize', (_params, ctx) => {
    senderWindow(ctx).minimize();
  });
  router.register('window.toggleMaximize', (_params, ctx) => {
    const window = senderWindow(ctx);
    if (window.isMaximized()) window.unmaximize();
    else window.maximize();
    return windowState(window);
  });
  router.register('window.close', (_params, ctx) => {
    senderWindow(ctx).close();
  });
  router.register('menu.role', (params, ctx) => {
    performMenuRole(senderWindow(ctx).webContents, params.role);
  });
}

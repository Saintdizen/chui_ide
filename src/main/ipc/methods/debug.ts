import { RpcErrorCode } from '../../../shared/api';
import type { DebugService } from '../../debug/debug';
import type { RpcServices } from '../context';
import { RpcFailure, type RpcRouter } from '../router';

/**
 * Отладчик (DAP). `requireDebug` живёт здесь же: это не общий вопрос, а
 * свойство домена — без отладчика отказывает ровно он и никто больше.
 *
 * Перенесено из `register.ts` без правок логики.
 */
export function registerDebugMethods(router: RpcRouter, deps: RpcServices): void {
  /* ── Отладчик (DAP) ────────────────────────────────────────────────────── */

  const requireDebug = (): DebugService => {
    if (!deps.debug) throw new RpcFailure(RpcErrorCode.Internal, 'Отладчик недоступен');
    return deps.debug;
  };

  router.register('debug.start', (params) =>
    requireDebug().start(params.program, { cwd: params.cwd, args: params.args, env: params.env }),
  );
  // Подключение к чужому процессу: ни файла, ни окружения — только адрес инспектора.
  router.register('debug.attach', (params) => requireDebug().attach(params));
  router.register('debug.setBreakpoints', (params) => requireDebug().setBreakpoints(params.path, params.breakpoints));
  router.register('debug.setExceptionBreakpoints', (params) => requireDebug().setExceptionBreakpoints(params));

  router.register('debug.continue', () => requireDebug().resume());
  router.register('debug.step', (params) => requireDebug().step(params.kind));
  router.register('debug.pause', () => requireDebug().pause());
  router.register('debug.stop', () => {
    requireDebug().stop();
  });
  router.register('debug.scopes', (params) => requireDebug().scopes(params.frameId));
  router.register('debug.variables', (params) => requireDebug().variables(params.reference));
  router.register('debug.evaluate', (params) => requireDebug().evaluate(params.expression, params.frameId));
  router.register('debug.hover', (params) => requireDebug().hover(params.expression, params.frameId));
  router.register('debug.setVariable', (params) =>
    requireDebug().setVariable(params.reference, params.name, params.value),
  );
  router.register('debug.setExpression', (params) =>
    requireDebug().setExpression(params.expression, params.value, params.frameId),
  );
}

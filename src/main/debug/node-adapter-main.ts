import { NodeAdapter } from './node-adapter';

/**
 * Точка входа отладочного адаптера Node.
 *
 * `DebugService` запускает этот файл отдельным процессом (тем же Node, что и
 * Electron) и говорит с ним по DAP через stdio — ровно как с `debugpy.adapter`.
 * Отдельный файл, а не авто-запуск в `node-adapter.ts`, чтобы тесты могли
 * импортировать класс адаптера и не поднимать лишний процесс.
 */
new NodeAdapter(process.stdin, process.stdout).run();

import path from 'node:path';
import { app } from 'electron';
import { promises as fs } from 'node:fs';
import { RpcErrorCode, type AppInfo, type RecentProject } from '../../../shared/api';
import { isProjectKind, projectNameProblem } from '../../../shared/project-kinds';
import { starterFiles } from '../../project/scaffold';
import { openProjectFolder } from '../register';
import { openWelcomeWindow } from '../../window';
import type { RpcServices } from '../context';
import { RpcFailure, type RpcRouter } from '../router';

/**
 * Приложение и стартовое окно: сведения о сборке, недавние проекты, создание,
 * открытие и закрытие проекта, экспорт темы.
 *
 * Ключевое здесь — ПОРЯДОК закрытия окон: и при переходе в IDE, и при возврате
 * к списку проектов окно закрывает renderer, получив ответ. Закрой мы его в
 * обработчике — ответ не дошёл бы, а `window-all-closed` на Windows и Linux
 * успел бы выйти из приложения.
 *
 * Перенесено из `register.ts` без правок логики.
 */
export function registerAppMethods(router: RpcRouter, deps: RpcServices): void {
  router.register(
    'app.info',
    (): AppInfo => ({
      appVersion: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
      platform: process.platform,
    }),
  );

  /* ── стартовое окно ────────────────────────────────────────────────────── */

  /** Недавние проекты с проверкой, что папка ещё на месте. */
  const recentProjects = async (): Promise<RecentProject[]> => {
    const recent = deps.settings.get().workspace.recent;
    return Promise.all(
      recent.map(async (root) => ({
        path: root,
        name: path.basename(root) || root,
        exists: await fs
          .stat(root)
          .then((stat) => stat.isDirectory())
          .catch(() => false),
      })),
    );
  };

  router.register('app.recentProjects', recentProjects);

  router.register('app.forgetProject', (params) => {
    deps.settings.forgetProject(params.path);
    return recentProjects();
  });

  // Переход из стартового окна в IDE — тот же путь, что у запуска из командной
  // строки. Стартовое окно закрывает сам лаунчер, получив ответ: закрытие здесь
  // уничтожило бы окно раньше отправки ответа, и вызов остался бы без результата.
  router.register('app.openProject', (params) => openProjectFolder(deps, params.path));
  /**
   * Закрытие проекта: человек возвращается к списку проектов. Стартовое окно
   * поднимаем ЗДЕСЬ и раньше закрытия окна IDE: иначе окна кончились бы совсем,
   * и `window-all-closed` успел бы выйти из приложения на Windows и Linux.
   *
   * Само окно IDE закрывает renderer, получив ответ, — так же, как стартовое окно
   * при переходе в IDE: закрытие в обработчике уничтожило бы отправителя раньше,
   * чем до него дошёл бы результат вызова.
   */
  router.register('app.closeProject', () => {
    openWelcomeWindow();
  });

  /**
   * Создание проекта: папка с файлами-заготовками выбранного вида.
   *
   * Имя проверяет общее правило (`projectNameProblem`) — то же, что гасит кнопку
   * «Создать» в стартовом окне. Без этой проверки имя вроде `../..` увело бы папку
   * проекта из выбранного каталога: имя папки и есть имя проекта.
   *
   * Занятую папку не трогаем: как и `git.clone`, отказываемся — молча писать в чужие
   * файлы нельзя. Неудача на середине убирает за собой: недоделанного проекта в чужом
   * каталоге не остаётся.
   */
  router.register('app.createProject', async (params) => {
    const name = params.name.trim();
    const problem = projectNameProblem(name);
    if (problem) throw new RpcFailure(RpcErrorCode.InvalidParams, problem);
    if (!isProjectKind(params.kind)) {
      throw new RpcFailure(RpcErrorCode.InvalidParams, `Неизвестный вид проекта: ${params.kind}`);
    }
    const directory = params.directory.trim();
    if (!directory) throw new RpcFailure(RpcErrorCode.InvalidParams, 'Не выбрана папка для проекта');

    const target = path.resolve(directory, name);
    const existing = await fs.stat(target).catch(() => null);
    if (existing) throw new RpcFailure(RpcErrorCode.InvalidParams, `Папка уже существует: ${target}`);

    await fs.mkdir(target);
    try {
      for (const file of starterFiles(params.kind, name)) {
        // Путь в заготовке записан через «/»: на Windows его надо разложить самому.
        const filePath = path.join(target, ...file.path.split('/'));
        await fs.mkdir(path.dirname(filePath), { recursive: true });
        await fs.writeFile(filePath, file.contents, 'utf8');
      }
    } catch (error) {
      // Неполный проект хуже отсутствующего: человек увидит папку и решит, что всё цело.
      await fs.rm(target, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
    return { path: target };
  });
}

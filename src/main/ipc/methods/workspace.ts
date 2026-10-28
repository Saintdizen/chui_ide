import { projectAliases } from '../../project/local-imports';
import type { RpcServices } from '../context';
import type { RpcRouter } from '../router';

/**
 * Рабочая область: файлы, папки, поиск, замена (в том числе по структуре),
 * несколько корней в одном окне.
 *
 * Общее у этих методов — они двигают или читают СОДЕРЖИМОЕ рабочей папки.
 * Всё, что за её пределы (диалоги, удалённые машины), живёт в `dialog.ts`.
 *
 * Перенесено из `register.ts` без правок логики.
 */
export function registerWorkspaceMethods(router: RpcRouter, deps: RpcServices): void {
  router.register('workspace.readDir', (params) => deps.workspace.readDir(params.path));
  router.register('workspace.readFile', (params) => deps.workspace.readFile(params.path));
  router.register('workspace.readImage', (params) => deps.workspace.readImage(params.path));
  router.register('workspace.readOffice', (params) => deps.workspace.readOffice(params.path));
  router.register('workspace.writeFile', (params) => deps.workspace.writeFile(params.path, params.text));
  router.register('workspace.stat', (params) => deps.workspace.stat(params.path));
  router.register('workspace.search', (params) => deps.workspace.search(params));
  router.register('workspace.listFiles', () => deps.workspace.listFiles());
  // Алиасы `paths` из tsconfig: подсказка после точки разворачивает по ним импорт
  // (`@/core` → `src/core`), иначе класс из такого файла не находится.
  router.register('workspace.importAliases', async () => ({
    aliases: await projectAliases(deps.workspace.rootPath()),
  }));
  router.register('workspace.compareFolders', (params) => deps.workspace.compareFolders(params.left, params.right));
  router.register('workspace.replace', (params) => deps.workspace.replace(params));
  router.register('workspace.structuralSearch', (params) => deps.workspace.findByStructure(params));
  router.register('workspace.structuralReplace', (params) => deps.workspace.replaceByStructure(params));
  router.register('workspace.findExports', (params) => deps.workspace.findExports(params));
  router.register('workspace.findInheritance', (params) => deps.workspace.findInheritance(params));
  router.register('workspace.createFile', async (params) => ({
    path: await deps.workspace.createFile(params.path, params.contents ?? ''),
  }));
  router.register('workspace.createDir', async (params) => ({ path: await deps.workspace.createDir(params.path) }));
  router.register('workspace.rename', async (params) => ({
    path: await deps.workspace.rename(params.from, params.to),
  }));
  router.register('workspace.updateImports', (params) => deps.workspace.updateImports(params.oldPath, params.newPath));
  router.register('workspace.copy', async (params) => ({ path: await deps.workspace.copy(params.from, params.to) }));
  router.register('workspace.trash', (params) => deps.workspace.trash(params.path));

  // Открытие рабочей папки меняет состояние репозитория целиком, поэтому
  // обновляем его сразу и рассылаем — UI не должен ходить за этим сам.
  router.register('workspace.open', async (params) => {
    const info = await deps.workspace.open(params.path);
    // Открытая папка попадает в историю стартового окна.
    deps.settings.rememberProject(info.root);
    await deps.git.refresh();
    // Другой проект — другая карта символов и чужие пометки в строке состояния.
    // Обход заново: он же снимает счёт прошлого проекта (`begin()` в project-diagnostics).
    deps.index?.refresh();
    return info;
  });

  // Ещё один корень в рабочую область (несколько папок в одном окне) и переключение
  // активного: активным отвечают git, поиск и запуск, когда файл не назван явно.
  router.register('workspace.addRoot', async (params) => {
    const info = await deps.workspace.addRoot(params.path);
    deps.settings.rememberProject(info.root);
    await deps.git.refresh();
    deps.index?.refresh();
    return info;
  });
  router.register('workspace.removeRoot', async (params) => {
    const info = await deps.workspace.removeRoot(params.path);
    await deps.git.refresh();
    deps.index?.refresh();
    return info;
  });
  router.register('workspace.setActiveRoot', async (params) => {
    const info = await deps.workspace.setActiveRoot(params.path);
    await deps.git.refresh();
    deps.index?.refresh();
    return info;
  });

  router.register('workspace.current', () => ({
    root: deps.workspace.rootPath(),
    roots: deps.workspace.rootList(),
  }));
}

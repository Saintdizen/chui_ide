import path from 'node:path';
import { app } from 'electron';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { RpcErrorCode } from '../../../shared/api';
import { scanProject } from '../../project/scan';
import { analyzeProject } from '../../project/analyze';
import { findPackages } from '../../project/packages';
import { loadSpellDictionary } from '../../spell/dictionary';
import type { RpcServices } from '../context';
import { RpcFailure, type RpcRouter } from '../router';

/**
 * Проект как единица: карта файлов, настройки уровня проекта
 * (`<root>/.chui_ide/`), зависимости, отчёты покрытия, замечания к коду и
 * локальная история файлов.
 *
 * Настройки проекта берут корень из ПАРАМЕТРОВ, а не из глобальных: они свои
 * у каждого проекта. Покрытие пишется во временный каталог — путь там
 * вычисляется из корня, снаружи произвольный файл не подсунуть.
 *
 * Перенесено из `register.ts` без правок логики.
 */
export function registerProjectMethods(router: RpcRouter, deps: RpcServices): void {
  // Карта проекта: обход имён без чтения содержимого, поэтому можно звать часто.
  router.register('project.scan', async () => scanProject(deps.requireRoot()));

  // Анализ целиком (линтер + зависимости): запускается фоном при открытии
  // проекта. Потолок времени у проверки свой — в `project/analyze.ts`.
  router.register('project.analyze', async () => {
    const root = deps.requireRoot();
    return analyzeProject(root, deps.resolvePython(root));
  });

  // Сессия проекта: renderer собирает состояние и кладёт сюда, а при следующем
  // открытии забирает обратно. Без хранилища (пробники) отвечаем пустой сессией.
  router.register('session.load', (params) => deps.sessions?.load(params.root) ?? { tabs: [], expanded: [] });
  router.register('session.save', (params) => {
    deps.sessions?.save(params.root, params.state);
  });
  // Настройки уровня проекта — в `<root>/.chui_ide/`. Свои для каждого проекта,
  // поэтому корень берём из параметров, а не из глобальных настроек. Макет
  // рабочей области сюда не входит: он общий и живёт в settings.json (userData).
  router.register('project.config', (params) => deps.projectConfig?.load(params.root) ?? {});
  router.register(
    'project.updateSettings',
    (params) => deps.projectConfig?.updateSettings(params.root, params.patch) ?? {},
  );
  router.register('project.packages', () => findPackages(deps.requireRoot()));

  // Отчёты покрытия: пишем во временный каталог, а не в корень проекта. Имя каталога
  // выводим из пути проекта, чтобы прогоны разных папок не затирали друг друга.
  // `path` — файл для pytest (`--cov-report=json:…`), `dir` — каталог, куда раннеры
  // Node (vitest, jest) кладут свой `coverage-final.json`.
  router.register('project.coverageJsonPath', async () => {
    const root = deps.requireRoot();
    const hash = createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 12);
    const dir = path.join(app.getPath('temp'), 'chui-coverage', hash);
    await fs.mkdir(dir, { recursive: true });
    return { path: path.join(dir, 'coverage.json'), dir };
  });

  // Прочитать СВОЙ файл отчёта покрытия. Через `workspace.readFile` его не взять:
  // тот не пускает за пределы рабочей папки, а отчёт лежит во временном каталоге.
  // Путь вычисляем сами, из корня: снаружи сюда не подсунуть произвольный файл.
  router.register('project.readCoverage', async (params) => {
    const root = deps.requireRoot();
    const hash = createHash('sha1').update(path.resolve(root)).digest('hex').slice(0, 12);
    const dir = path.join(app.getPath('temp'), 'chui-coverage', hash);
    const name = params.kind === 'node' ? 'coverage-final.json' : 'coverage.json';
    const text = await fs.readFile(path.join(dir, name), 'utf8').catch(() => null);
    return { text };
  });

  router.register('review.load', () => deps.reviews?.load(deps.requireRoot()) ?? []);
  router.register('review.save', (params) => deps.reviews?.save(deps.requireRoot(), params.threads) ?? params.threads);

  // Локальная история: снимки пишутся при перезаписи файла (см. onBeforeChange в
  // WorkspaceService), а отсюда их читают и убирают.
  router.register('history.list', (params) => deps.history?.list(deps.requireRoot(), params.path) ?? []);
  router.register('history.read', async (params) => {
    const text = await deps.history?.read(deps.requireRoot(), params.path, params.id);
    if (text === null || text === undefined) throw new RpcFailure(RpcErrorCode.NotFound, 'Снимок не найден');
    return { text };
  });
  router.register('history.clear', async (params) => {
    await deps.history?.clear(deps.requireRoot(), params.path);
  });

  /* ── Проверка орфографии ───────────────────────────────────────────────── */

  // Словарь ищем в системе (aspell, hunspell, LibreOffice): renderer в песочнице
  // файлы читать не умеет. Пустой список — словаря нет, проверка промолчит.
  router.register('spell.dictionary', () => loadSpellDictionary());
}

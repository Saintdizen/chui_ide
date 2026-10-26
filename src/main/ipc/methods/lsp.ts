import { NO_LSP_STATUS } from '../../../shared/lsp-status';
import { EMPTY_INDEX_STATUS, type InheritedResult } from '../../../shared/symbol-index';
import { detectLspSources } from '../../lsp/detect';
import { mergeByPriority } from '../../../shared/lsp-bundled';
import type { RpcServices } from '../context';
import type { RpcRouter } from '../router';

/**
 * Языковые серверы и карта символов — одна тема: оба отвечают «что и где
 * объявлено». Домен включает и подсказки (прокси к серверу), и форматирование
 * участка, и разбор того, какие серверы вообще есть у проекта.
 *
 * Перенесено из `register.ts` без правок логики.
 */
export function registerLspMethods(router: RpcRouter, deps: RpcServices): void {
  // Языковые серверы: renderer синхронизирует документ и просит перезапуск.
  router.register('lsp.open', async (params) => {
    await deps.lsp?.open(params.path, params.languageId, params.text);
  });
  router.register('lsp.change', (params) => {
    deps.lsp?.change(params.path, params.text);
  });
  router.register('lsp.close', (params) => {
    deps.lsp?.close(params.path);
  });
  router.register('lsp.restart', () => deps.lsp?.restart() ?? NO_LSP_STATUS);
  router.register('lsp.status', () => deps.lsp?.status() ?? NO_LSP_STATUS);
  // Прогрев: поднять серверы языков проекта, не дожидаясь открытия файлов.
  router.register('lsp.prewarm', async (params) => {
    await deps.lsp?.prewarm(params.languages);
    // Заодно и карта символов: серверы уже подняты, а разбор файлов — та же работа,
    // которую поиск символа ждал бы при первом запросе. В фоне: прогрев не ждёт её.
    deps.index?.refresh();
  });
  // Прокси к серверу: подсказки, наведение, переход к определению. Сервера нет —
  // возвращаем null, и редактор просто не покажет подсказку.
  router.register('lsp.request', (params) => deps.lsp?.request(params.path, params.method, params.params) ?? null);
  // Чем сервер готов открывать подсказки: знаки-триггеры. Renderer открывает попап
  // по ним, а не только по точке: без этого `@` в CSS и `:` в JSON молчали.
  router.register(
    'lsp.capabilities',
    (params) =>
      deps.lsp?.completionTriggers(params.path) ?? {
        triggerCharacters: [],
        allCommitCharacters: [],
        resolveProvider: false,
      },
  );
  // Символы проекта: сервер ищет по всему проекту, а не по открытому файлу.
  router.register('lsp.symbols', (params) => deps.lsp?.projectSymbols(params.query) ?? []);
  // Карта символов: то, что уже разобрано и лежит на диске. Нужна двум вещам —
  // быстрому поиску, пока сервер молчит, и пересборке после правок (её зовёт проба).
  router.register('index.status', () => deps.index?.status() ?? EMPTY_INDEX_STATUS);
  // Поиск только по карте: им дополняются подсказки при наборе. Отдельный вход нужен
  // потому, что `lsp.symbols` спрашивает ещё и серверы, а на каждую паузу в наборе это
  // слишком дорого — карта отвечает мгновенно и без них.
  router.register('index.find', (params) => deps.index?.find(params.query) ?? []);
  router.register('index.rebuild', () => {
    deps.index?.refresh();
    return deps.index?.status() ?? EMPTY_INDEX_STATUS;
  });
  // Что тип умеет и от кого это унаследовано — по карте, без языкового сервера.
  // Сервер отвечает на это только для символа под курсором открытого файла.
  router.register(
    'index.inherited',
    (params): InheritedResult =>
      deps.index?.inherited(params.name) ?? {
        name: params.name,
        declared: null,
        ancestors: [],
        members: [],
        phase: 'idle',
      },
  );
  // Семантическая подсветка: точные роли от сервера. Ответ разобран в main (там легенда),
  // renderer получает готовые участки и накладывает их поверх своей грамматики.
  // Язык — от вызывающего: `open` уходит `void`-запросом, и его приход не гарантирован
  // раньше этого вызова (см. `LspService.semanticTokens`).
  router.register('lsp.semanticTokens', (params) => deps.lsp?.semanticTokens(params.path, params.languageId) ?? []);
  // Форматирование участка: сервер переписывает только выделение или вставленный кусок.
  router.register(
    'lsp.formatRange',
    (params) =>
      deps.lsp?.formatRange(params.path, {
        startLine: params.startLine,
        startColumn: params.startColumn,
        endLine: params.endLine,
        endColumn: params.endColumn,
      }) ?? [],
  );

  // Три источника серверов, и порядок между ними — это и есть приоритет:
  //
  //   1. окружение проекта (venv): pylsp и ruff видят пакеты проекта, а системный
  //      питон — нет, поэтому сервер оттуда и запускать предпочтительнее;
  //   2. поставка IDE: то, что едет вместе с нами (JS/TS, JSON, CSS, HTML, YAML,
  //      Pyright) — работает без единой установки;
  //   3. PATH: что человек поставил сам в систему.
  //
  // В рантайме ключ — язык, поэтому у языка должен остаться один сервер:
  // сведение по приоритету делает `mergeByPriority`.
  router.register('lsp.detect', async () => {
    const sources = await detectLspSources(deps.workspace.rootPath(), process.platform);
    return mergeByPriority(sources);
  });
}

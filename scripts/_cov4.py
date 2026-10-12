p = 'src/renderer/app.ts'
s = open(p, encoding='utf-8').read()

def rep(old, new, tag):
    global s
    assert s.count(old) == 1, (tag, s.count(old))
    s = s.replace(old, new)

rep("""import { ProjectPackagesModel } from './core/project-packages';""",
    """import { ProjectPackagesModel } from './core/project-packages';
import { parseCoverageJson } from '../shared/coverage-json';""", 'import')

rep("""    // Покрытие пока умеет только pytest: у Node своего отчёта нет, и кнопка
    // «С покрытием» в его проектах не показывается вовсе.
    onCoverage: (selector) =>
      void runTarget(pytestCoverageTarget(tools.get(), selector, { report: true, platform: info.platform })),
    canCoverage: () => isPythonProject(),
    // Отчёт покрытия → подсветка непокрытых строк в редакторе. Отчёт даёт пути от
    // корня проекта; редактор ключует файлы абсолютными — собираем их здесь.
    onCoverageReport: (report) => {
      const root = workspace.root;
      if (!root) return;
      const separator = separatorOf(root);
      const entries = report.files
        .filter((file) => file.missingLines.length > 0)
        .map((file) => [joinPath(root, splitPath(file.path).join(separator)), file.missingLines] as const);
      editors.setCoverage(entries);
    },""",
"""    // Покрытие пока умеет только pytest: у Node своего отчёта нет, и кнопка
    // «С покрытием» в его проектах не показывается вовсе. Заодно просим JSON-отчёт:
    // по нему видно не только непокрытые строки, но и наполовину пройденные ветви.
    onCoverage: (selector) => {
      void (async () => {
        coverageJsonPath = await rpc
          .request('project.coverageJsonPath')
          .then((result) => result.path)
          .catch(() => null);
        void runTarget(
          pytestCoverageTarget(tools.get(), selector, {
            report: true,
            platform: info.platform,
            jsonPath: coverageJsonPath ?? undefined,
          }),
        );
      })();
    },
    canCoverage: () => isPythonProject(),
    // Отчёт покрытия → подсветка строк в редакторе. Отчёт даёт пути от корня проекта;
    // редактор ключует файлы абсолютными — собираем их здесь. Сначала берём строки из
    // терминального отчёта (он есть всегда), затем, если прогон оставил JSON, уточняем
    // по нему: там ещё и частично пройденные ветви.
    onCoverageReport: (report) => {
      const root = workspace.root;
      if (!root) return;
      const separator = separatorOf(root);
      const absolute = (filePath: string): string => joinPath(root, splitPath(filePath).join(separator));
      editors.setCoverage(
        report.files
          .filter((file) => file.missingLines.length > 0)
          .map((file) => [absolute(file.path), file.missingLines] as const),
      );
      void applyCoverageJson(absolute);
    },""", 'coverage')

# Объявление переменной и функция-уточнение — перед созданием панели тестов.
rep("""  });
  // Исход прогона — в значок теста в жёлобе: панель знает его по селекторам,
  // редактор превращает их в цвет значка у строки объявления теста.
  testPanel.onDidChangeOutcomes(() => editors.setTestOutcomes(testPanel.outcomes()));""",
"""  });
  // Исход прогона — в значок теста в жёлобе: панель знает его по селекторам,
  // редактор превращает их в цвет значка у строки объявления теста.
  testPanel.onDidChangeOutcomes(() => editors.setTestOutcomes(testPanel.outcomes()));""", 'noop')

open(p, 'w', encoding='utf-8').write(s)
print('ok app coverage')

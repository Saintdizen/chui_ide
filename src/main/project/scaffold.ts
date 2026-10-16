import { projectSlug, type ProjectKind } from '../../shared/project-kinds';

/**
 * Файлы-заготовки нового проекта.
 *
 * Заготовка — не «каркас приложения», а честная отправная точка: точка входа,
 * которую видно в дереве, README с именем проекта и `.gitignore`, чтобы первый же
 * `git add` не затянул `__pycache__` или `node_modules`. Чего здесь НЕТ намеренно:
 * окружений и зависимостей. Их ставят после — venv создаётся из панели Python,
 * пакеты — установкой зависимостей, — и делать это молча, за спиной человека,
 * значит гадать за него.
 */

/** Файл заготовки: путь считается от корня нового проекта и всегда через «/». */
export interface StarterFile {
  path: string;
  contents: string;
}

/** Хвост перевода строки у каждого файла: так их правят и редактор, и git. */
const readme = (name: string): string => `# ${name}\n\nОписание проекта.\n`;

const PYTHON = (name: string): StarterFile[] => [
  {
    path: 'main.py',
    contents: `"""Точка входа: отсюда начинается программа."""


def main() -> None:
    print("Привет!")


if __name__ == "__main__":
    main()
`,
  },
  { path: 'README.md', contents: readme(name) },
  // Окружение проекта рядом с кодом — обычное дело, в репозиторий ему не надо.
  { path: '.gitignore', contents: '__pycache__/\n*.py[cod]\n.venv/\nvenv/\n.env\n' },
];

const NODE = (name: string): StarterFile[] => [
  {
    path: 'package.json',
    contents: `${JSON.stringify(
      {
        name: projectSlug(name),
        version: '0.1.0',
        private: true,
        // ESM по умолчанию: `import` в новом файле работает без оговорок.
        type: 'module',
        main: 'src/index.js',
        scripts: {
          start: 'node src/index.js',
          // `node --test` находит `*.test.js` сам — тестовая панель поймёт эту команду.
          test: 'node --test',
        },
      },
      null,
      2,
    )}\n`,
  },
  { path: 'src/index.js', contents: `console.log('Привет!');\n` },
  { path: 'README.md', contents: readme(name) },
  { path: '.gitignore', contents: 'node_modules/\n.env\n' },
];

const EMPTY = (name: string): StarterFile[] => [
  { path: 'README.md', contents: readme(name) },
  { path: '.gitignore', contents: '' },
];

const TEMPLATES: Record<ProjectKind, (name: string) => StarterFile[]> = {
  python: PYTHON,
  node: NODE,
  empty: EMPTY,
};

/** Файлы для проекта этого вида. Вид проверен у входа (`isProjectKind`). */
export function starterFiles(kind: ProjectKind, name: string): StarterFile[] {
  return TEMPLATES[kind](name);
}

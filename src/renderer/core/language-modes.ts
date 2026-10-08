import * as monaco from 'monaco-editor';
// Настройки TS/JS в этой версии Monaco переехали в отдельный namespace:
// `languages.typescript` оставлен только как заглушка с пометкой об устаревании.
import { typescript } from 'monaco-editor';

/**
 * Правила языков для Monaco, которых у него нет или которые нам нужны точнее.
 *
 * Сам токенизатор (подсветку) Monaco уже знает для всех наших языков — здесь
 * только «поведение»: какие комментарии ставит Ctrl+/, где сворачивать блок,
 * как считать слово под курсором и как вести отступ. От этого зависят вполне
 * рутинные вещи: `Ctrl+/` в Python и в `.env`, автоотступ после `def …:` и
 * переход по словам `Ctrl+←`.
 */

interface ModeRules {
  lineComment?: string;
  blockComment?: readonly [string, string];
  /** Что считается словом: важно для двойного клика и подсветки вхождений. */
  wordPattern?: RegExp;
  /** Строки, после которых отступ растёт (в Python — после двоеточия). */
  increaseIndent?: RegExp;
  /** Строки, которые сами уменьшают отступ. */
  decreaseIndent?: RegExp;
  /** `#` — комментарий, а не открывающая скобка: пар скобок у этих языков нет. */
  bracketsOnly?: boolean;
  offSide?: boolean;
}

const IDENTIFIER = /(-?\d*\.\d\w*)|([^`~!@#%^&*()\-=+[{\]}\\|;:'",.<>/?\s]+)/g;

const MODES: Record<string, ModeRules> = {
  python: {
    lineComment: '#',
    wordPattern: IDENTIFIER,
    increaseIndent: /^\s*(class|def|elif|else|except|finally|for|if|try|while|with|match|case)\b.*:\s*$/,
    decreaseIndent: /^\s*(elif|else|except|finally|case)\b/,
    offSide: true,
  },
  ini: {
    lineComment: '#',
    wordPattern: /[^=\s]+/g,
    bracketsOnly: true,
  },
  dockerfile: {
    lineComment: '#',
    wordPattern: IDENTIFIER,
    increaseIndent: /\\\s*$/,
    bracketsOnly: true,
  },
  makefile: {
    lineComment: '#',
    wordPattern: IDENTIFIER,
    bracketsOnly: true,
  },
  shell: {
    lineComment: '#',
    wordPattern: IDENTIFIER,
    increaseIndent: /(\bdo|\bthen|\belse|\bcase)\s*$/,
    decreaseIndent: /^\s*(done|fi|esac)\b/,
    bracketsOnly: true,
  },
  yaml: {
    lineComment: '#',
    wordPattern: /[^\s:]+/g,
    bracketsOnly: true,
  },
  sql: {
    lineComment: '--',
    blockComment: ['/*', '*/'],
    wordPattern: IDENTIFIER,
  },
  markdown: {
    blockComment: ['<!--', '-->'],
    wordPattern: IDENTIFIER,
    bracketsOnly: true,
  },
};

let registered = false;

/**
 * Регистрируем правила один раз и только для тех языков, что действительно
 * есть в сборке Monaco: `setLanguageConfiguration` на неизвестном имени бросает
 * исключение, и одна опечатка в таблице роняла бы запуск всего приложения.
 */
export function registerLanguageModes(): void {
  if (registered) return;
  registered = true;

  registerMakefile();
  const known = new Set(monaco.languages.getLanguages().map((language) => language.id));

  for (const [id, rules] of Object.entries(MODES)) {
    if (!known.has(id)) {
      console.warn(`[chui] язык ${id} не зарегистрирован в Monaco — правила пропущены`);
      continue;
    }

    const configuration: monaco.languages.LanguageConfiguration = {
      comments: {
        ...(rules.lineComment ? { lineComment: rules.lineComment } : {}),
        ...(rules.blockComment ? { blockComment: [...rules.blockComment] } : {}),
      },
      ...(rules.wordPattern ? { wordPattern: rules.wordPattern } : {}),
      ...(rules.bracketsOnly
        ? {}
        : {
            brackets: [
              ['{', '}'],
              ['[', ']'],
              ['(', ')'],
            ] as [string, string][],
            autoClosingPairs: [
              { open: '{', close: '}' },
              { open: '[', close: ']' },
              { open: '(', close: ')' },
              { open: '"', close: '"', notIn: ['string'] },
              { open: "'", close: "'", notIn: ['string', 'comment'] },
            ],
          }),
      ...(rules.increaseIndent || rules.decreaseIndent
        ? {
            indentationRules: {
              increaseIndentPattern: rules.increaseIndent ?? /$^/,
              decreaseIndentPattern: rules.decreaseIndent ?? /$^/,
            },
          }
        : {}),
      ...(rules.offSide ? { folding: { offSide: true } } : {}),
    };

    monaco.languages.setLanguageConfiguration(id, configuration);
  }
}

/**
 * Makefile в сборке Monaco отсутствует, а подсветка рецептов нужна: без неё
 * `make`-файл читается как обычный текст. Регистрируем язык сами — грамматика
 * короткая, потому что цель, переменная и рецепт — почти всё его содержимое.
 */
function registerMakefile(): void {
  const id = 'makefile';
  if (monaco.languages.getLanguages().some((language) => language.id === id)) return;

  monaco.languages.register({ id, extensions: ['.mk'], filenames: ['Makefile', 'makefile', 'GNUmakefile'] });
  monaco.languages.setMonarchTokensProvider(id, {
    defaultToken: '',
    tokenPostfix: '.makefile',
    tokenizer: {
      root: [
        [/^\s*#.*$/, 'comment'],
        // Строка с табуляции — команда рецепта: она не подсвечивается как цели.
        [/^\t.*$/, 'string'],
        [/\$[(@<^+*?%]|\$\{[^}]*\}/, 'variable'],
        [/\b(?:ifeq|ifneq|ifdef|ifndef|else|endif|include|define|endef|export|unexport|override|vpath)\b/, 'keyword'],
        [/^[A-Za-z_][\w.-]*\s*(?=[:+?]?=)/, 'variable.name'],
        [/^\.?[A-Za-z0-9_./-]+\s*:(?!=)/, 'type'],
        [/[A-Za-z_][\w.]*/, 'identifier'],
        [/"[^"]*"|'[^']*'/, 'string'],
      ],
    },
  });
}

/**
 * Подсказки и проверки для JavaScript и TypeScript.
 *
 * Без этого Monaco считает файлы одиночными скриптами: `import` ругается,
 * `require` не виден, а импорты из проекта не разрешаются. Настройки Node
 * (allowJs, moduleResolution) включают привычную картину, а `noUnused*`
 * подсвечивает неиспользуемые импорты — как в VS Code.
 */
export function applyTypeScriptDefaults(options: { showUnused: boolean }): void {
  const { javascriptDefaults, typescriptDefaults, ModuleResolutionKind, ScriptTarget, JsxEmit } = typescript;

  for (const defaults of [javascriptDefaults, typescriptDefaults]) {
    defaults.setEagerModelSync(true);
    defaults.setDiagnosticsOptions({
      noSemanticValidation: false,
      noSyntaxValidation: false,
      // Проверяем только открытые файлы: иначе диагностика бежит по всему проекту.
      onlyVisible: true,
    });
    defaults.setCompilerOptions({
      allowJs: true,
      allowNonTsExtensions: true,
      target: ScriptTarget.ESNext,
      module: typescript.ModuleKind.ESNext,
      moduleResolution: ModuleResolutionKind.NodeJs,
      jsx: JsxEmit.React,
      esModuleInterop: true,
      skipLibCheck: true,
      noEmit: true,
      noUnusedLocals: options.showUnused,
      noUnusedParameters: options.showUnused,
    });
  }
}

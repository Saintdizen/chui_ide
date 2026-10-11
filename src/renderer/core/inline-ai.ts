import * as monaco from 'monaco-editor';
import { delayOrCancel, inlineContext } from '../../shared/inline-ai';
import { LANGUAGES } from '../../shared/languages';
import { uriToPath } from './document';
import type { RpcClient } from './rpc';

export interface InlineAiDeps {
  rpc: RpcClient;
  /** Включено ли автодополнение сейчас (настройка `ai.inlineCompletion.enabled`). */
  enabled: () => boolean;
  /** Пауза после последнего ввода перед запросом, мс. */
  debounceMs: () => number;
  /** Путь для промпта: относительный от корня проекта — так модели понятнее. */
  relativePath: (path: string) => string;
}

/**
 * Inline-автодополнение: модель дописывает код прямо в месте курсора, а Monaco
 * показывает это «призрачным» текстом. Принимается по Tab — встроенным в Monaco
 * действием `editor.action.inlineSuggest.commit`.
 *
 * Здесь только связка Monaco с main: контекст вокруг курсора, задержка и запрос.
 * Ни нарезка контекста, ни сборка промпта, ни очистка ответа сюда не входят —
 * они в `shared/inline-ai.ts` и в main, поэтому проверяются без редактора.
 *
 * Задержка — не украшение: `provideInlineCompletions` зовётся на каждое нажатие
 * клавиши, и без паузы каждый символ стоил бы отдельного обращения к модели.
 * Токен отмены Monaco прерывает паузу, когда человек печатает дальше.
 */
export function registerInlineAi(deps: InlineAiDeps): monaco.IDisposable {
  const disposables = LANGUAGES.map((language) =>
    monaco.languages.registerInlineCompletionsProvider(language.id, {
      async provideInlineCompletions(model, position, _context, token) {
        if (!deps.enabled()) return { items: [] };
        if (!(await delayOrCancel(deps.debounceMs(), token))) return { items: [] };
        if (token.isCancellationRequested) return { items: [] };

        const { prefix, suffix } = inlineContext(model.getValue(), {
          line: position.lineNumber,
          column: position.column,
        });
        // Пустой контекст — подсказывать нечего, а запрос всё равно стоил бы денег.
        if (!prefix.trim() && !suffix.trim()) return { items: [] };

        const path = uriToPath(model.uri.path);
        try {
          const result = await deps.rpc.request('ai.complete', {
            path: deps.relativePath(path),
            language: model.getLanguageId(),
            prefix,
            suffix,
          });
          // Пока ждали ответ, человек мог уйти на другую строку — старую подсказку не показываем.
          if (token.isCancellationRequested || !result.text) return { items: [] };
          return { items: [{ insertText: result.text }] };
        } catch {
          // Модель недоступна, ключа нет, выключено в настройках — подсказки просто нет.
          return { items: [] };
        }
      },
      disposeInlineCompletions() {
        // Удерживать нечего: подсказка — короткая строка.
      },
    }),
  );

  return {
    dispose: () => {
      for (const disposable of disposables) disposable.dispose();
    },
  };
}

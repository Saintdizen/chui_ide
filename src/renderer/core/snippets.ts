import * as monaco from 'monaco-editor';
import { LANGUAGES } from '../../shared/languages';
import { DEFAULT_SNIPPETS, snippetsForLanguage, type Snippet } from '../../shared/snippets';

export interface SnippetSource {
  /** Свои сниппеты с настройками; к ним редактор добавляет набор по умолчанию. */
  custom: () => readonly Snippet[];
}

/**
 * Сниппеты в подсказке редактора.
 *
 * Регистрируем по провайдеру на язык, как это делает LSP: Monaco зовёт провайдеров
 * подсказки для текущего языка, и сниппеты попадают в тот же список, что и слова
 * языка. Языковой сервер (если он есть) даёт свои сниппеты рядом — это не мешает:
 * подсказки разных провайдеров складываются в один список.
 *
 * Тело вставляется как разметка Monaco (`InsertAsSnippet`): `${1:имя}` становится
 * выделенным местом, а `$0` — точкой, где встанет курсор. Поэтому же фильтруем по
 * языку: `ifmain` не должен предлагаться в `typescript`.
 */
export function registerSnippets(source: SnippetSource): monaco.IDisposable {
  const disposables = LANGUAGES.map((language) =>
    monaco.languages.registerCompletionItemProvider(language.id, {
      provideCompletionItems(model, position) {
        // Слово под курсором — предел замены: набранный префикс заменится телом.
        const word = model.getWordUntilPosition(position);
        const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
        // Свои сниппеты первыми: при совпадении триггера их видно раньше набора по умолчанию.
        const all = [...source.custom(), ...DEFAULT_SNIPPETS];
        const suggestions = snippetsForLanguage(all, model.getLanguageId()).map((snippet) => ({
          label: snippet.prefix,
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: snippet.body,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          detail: 'сниппет',
          documentation: snippet.description,
          range,
        }));
        return { suggestions };
      },
    }),
  );

  return {
    dispose: () => {
      for (const disposable of disposables) disposable.dispose();
    },
  };
}

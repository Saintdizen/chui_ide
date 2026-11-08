// `cspell-lib` объявляет в `exports` только `import`, без ветки `types`, а main
// собирается с `moduleResolution: node16` — типы пакета он в таком виде не находит
// (TS2307). Сами js-файлы грузятся штатно через `await import()`.
//
// Объявляем ровно то, чем пользуемся, и сверяемся с `dist/index.d.ts` пакета:
// выдумать имя метода здесь значило бы поймать ошибку в рантайме вместо компилятора.
declare module 'cspell-lib' {
  export interface CSpellSettingsLike {
    words?: string[];
    [key: string]: unknown;
  }

  export interface SpellIssueLike {
    /** Слово, на котором спотыкнулись. */
    text: string;
    /** Смещение слова в тексте, символы с нуля. */
    offset: number;
    /** Длина слова. */
    length: number;
    /** Готовое сообщение cSpell («Unknown word»). */
    message: string;
    suggestions?: string[];
  }

  export interface TextDocumentLike {
    readonly uri: string;
  }

  export function getDefaultBundledSettingsAsync(): Promise<CSpellSettingsLike>;
  export function createTextDocument(params: {
    uri: string;
    content: string;
    languageId?: string;
    locale?: string;
    version?: number;
  }): TextDocumentLike;
  export function spellCheckDocument(
    document: TextDocumentLike,
    options: Record<string, unknown>,
    settings?: CSpellSettingsLike,
  ): Promise<{ issues?: SpellIssueLike[] }>;
}

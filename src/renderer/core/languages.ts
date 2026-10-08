/**
 * Языки файлов. Вся таблица живёт в `src/shared/languages.ts`, потому что её
 * читают и renderer (подсветка, значки, запуск), и main. Здесь — только привычные
 * имена, чтобы не переписывать импорты в потребителях.
 */
export {
  LANGUAGES,
  PLAIN_LANGUAGE,
  basename as pathBasename,
  fileIconOf,
  languageFromPath,
  languageIndent,
  languageInfo,
  languageInfoForPath,
  languageLabel,
  type FileIconKind,
  type LanguageIndent,
  type LanguageInfo,
  type RunKind,
} from '../../shared/languages';

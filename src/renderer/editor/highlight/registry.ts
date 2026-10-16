/**
 * Реестр грамматик: какому языку какая подсветка.
 *
 * Ключи — идентификаторы языков приложения (`shared/languages.ts`): один реестр
 * на всё, никаких своих имён. Язык без грамматики
 * получает `null`, и текст показывается как простой — это честнее, чем красить
 * наугад чужой грамматикой.
 *
 * Пара исключений, где грамматика берётся «по родству», и это осознанно:
 *
 *   • `jsonc`/`json5` — тот же JSON, только комментарии разрешены (их грамматика
 *     понимает и так);
 *   • `xml` — та же разметка, что HTML;
 *   • `scss`/`less` — тот же CSS (вложенность скобок грамматика и так считает);
 *   • `makefile` и `dockerfile` — разбор оболочки: комментарий решёткой, имя команды
 *     в начале строки, строки в кавычках. Точной грамматики для них нет, но и то,
 *     что есть, читается верно: `RUN apt-get install` — команда с аргументами.
 */

import type { Grammar } from './grammar';
import { codeGrammars } from './languages/code';
import { cssGrammar } from './languages/css';
import { htmlGrammar } from './languages/html';
import { iniGrammar } from './languages/ini';
import { jsonGrammar } from './languages/json';
import { markdownGrammar } from './languages/markdown';
import { pythonGrammar } from './languages/python';
import { shellGrammar } from './languages/shell';
import { sqlGrammar } from './languages/sql';
import { yamlGrammar } from './languages/yaml';

const GRAMMARS: Record<string, Grammar> = {
  ...codeGrammars,
  python: pythonGrammar,
  json: jsonGrammar,
  jsonc: jsonGrammar,
  json5: jsonGrammar,
  shell: shellGrammar,
  yaml: yamlGrammar,
  markdown: markdownGrammar,
  html: htmlGrammar,
  xml: htmlGrammar,
  css: cssGrammar,
  scss: cssGrammar,
  less: cssGrammar,
  ini: iniGrammar,
  sql: sqlGrammar,
  makefile: shellGrammar,
  dockerfile: shellGrammar,
};

/** Грамматика языка или `null`, если подсветки для него нет. */
export function grammarFor(languageId: string): Grammar | null {
  return GRAMMARS[languageId.toLowerCase()] ?? null;
}

/** Идентификаторы языков, для которых подсветка есть — для справки и проверок. */
export function highlightedLanguages(): string[] {
  return Object.keys(GRAMMARS).sort();
}

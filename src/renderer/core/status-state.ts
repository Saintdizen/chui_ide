/**
 * Что показать в полосе состояния — по активному файлу и окружению.
 *
 * Раньше этот отбор жил прямо в `refreshStatus` в `app.ts`, вперемешку с заголовком
 * окна и перезапросом состава серверов. Смешаны были три вещи разной природы:
 * чистое «что показать», побочное «пора спросить состав серверов» (язык сменился)
 * и показ. Здесь — первое и решение о втором, показ делает окно.
 *
 * Почему это стоит проверять тестом: тут копятся правила, каждое из которых уже
 * когда-то было ошибкой. Отступ у Makefile — таб, а не четыре пробела; картинка —
 * формат (PNG), а не язык; виджет окружения говорит на языке проекта (в Node-проекте
 * висел питоновский интерпретатор).
 */

import type { LspChip } from '../../shared/lsp-status';
import type { VimMode } from '../editor/input/vim';
import type { ProjectTools } from './project-tools';
import { envWidgetLabel } from './env-widget';

/** Что известно окну про активный файл. */
export interface ActiveFileFacts {
  path: string | null;
  languageId: string | null;
  readOnly: boolean;
  version: number;
}

export interface StatusInputs {
  active: ActiveFileFacts | null;
  /** Картинка или документ Office: языка у них нет, а формат показать надо. */
  format: 'image' | 'office' | null;
  /** Подпись формата (PNG, SVG, DOCX…). */
  formatLabel: string | null;
  /** Подпись языка для человека. */
  languageLabel: string | null;
  /** Отступ, если язык диктует свой. */
  languageIndent: { tabSize: number; insertSpaces: boolean } | null;
  settings: {
    tabSize: number;
    insertSpaces: boolean;
    lspEnabled: boolean;
  };
  /** Чип языкового сервера — уже собранный, либо null. */
  lspChip: LspChip | null;
  git: { branch: string | null; changeCount: number };
  /** Вид проекта; `none` — не опознан, чип вида не показываем. */
  projectKind: { id: string; source: string } | null;
  problems: { errors: number; warnings: number };
  vim: VimMode | null;
  macro: { steps: number } | null;
  tools: ProjectTools;
  configuredPython: string;
}

/** Часть состояния полосы, которую считает этот модуль. */
export interface StatusPatch {
  readOnly: boolean;
  language: string | null;
  version: number;
  tabSize: number;
  useTabs: boolean;
  branch: string | null;
  changes: number;
  projectKindId: string | null;
  problems: { errors: number; warnings: number };
  env: string | null;
  vim: VimMode | null;
  macro: { steps: number } | null;
  lsp: LspChip | null;
}

/**
 * Язык, который полоса считает активным. У картинки и Office его нет намеренно:
 * иначе в чипе языка висело бы `plaintext` у PNG.
 */
export function activeLanguage(facts: ActiveFileFacts | null, format: 'image' | 'office' | null): string | null {
  if (format !== null) return null;
  return facts?.languageId ?? null;
}

/**
 * Пора ли перечитать состав языковых серверов.
 *
 * Сервер поднимается при первом открытии файла языка, и до этого про него ничего
 * не известно. Спрашиваем только когда язык вправду сменился — иначе каждый
 * пересчёт полосы (а их много: курсор, сохранение, git) дёргал бы RPC.
 */
export function needsLspRefresh(inputs: StatusInputs, shownLanguage: string | null): boolean {
  const language = activeLanguage(inputs.active, inputs.format);
  return inputs.settings.lspEnabled && language !== null && language !== shownLanguage;
}

/** Собрать то, что полоса покажет. Порядок полей — как у `StatusState`. */
export function statusPatch(inputs: StatusInputs): StatusPatch {
  const active = inputs.active;
  const language = activeLanguage(active, inputs.format);
  const indent = inputs.languageIndent;
  return {
    readOnly: active?.readOnly ?? false,
    // Картинка — не язык: в чипе показываем формат (PNG, SVG), а не «plaintext».
    language: inputs.format !== null ? inputs.formatLabel : language !== null ? inputs.languageLabel : null,
    lsp: inputs.settings.lspEnabled ? inputs.lspChip : null,
    version: active?.version ?? 0,
    // Отступ и язык — свойства файла: у Python четыре пробела, у Makefile таб,
    // поэтому в полосе видно ФАКТИЧЕСКОЕ значение, а не общее из настроек.
    tabSize: indent?.tabSize ?? inputs.settings.tabSize,
    useTabs: indent ? !indent.insertSpaces : !inputs.settings.insertSpaces,
    branch: inputs.git.branch,
    changes: inputs.git.changeCount,
    projectKindId: inputs.projectKind && inputs.projectKind.source !== 'none' ? inputs.projectKind.id : null,
    problems: inputs.problems,
    // Виджет окружения говорит на языке проекта: у Node — версия и менеджер,
    // у Python — интерпретатор.
    env: envWidgetLabel(inputs.projectKind?.id ?? null, inputs.tools, inputs.configuredPython),
    vim: inputs.vim,
    macro: inputs.macro,
  };
}

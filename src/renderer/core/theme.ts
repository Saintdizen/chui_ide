import type { ITheme } from '@xterm/xterm';
import type * as monaco from 'monaco-editor';

export type Scheme = 'dark' | 'light';

export const MONACO_THEME_IDS: Record<Scheme, string> = {
  dark: 'chui-dark',
  light: 'chui-light',
};

/**
 * Подсветка кода — цвета VS Code (Dark+ и Light+).
 *
 * Те же значения объявлены в `styles/theme.css` как `--code_token_*`, но Monaco
 * не умеет читать CSS-переменные, поэтому таблица дублируется здесь.
 * При правке палитры правила меняются в обоих местах.
 */
interface TokenRules {
  comment: string;
  string: string;
  number: string;
  keyword: string;
  keywordControl: string;
  identifier: string;
  type: string;
  constant: string;
  tag: string;
  attribute: string;
}

const DARK_TOKENS: TokenRules = {
  comment: '6a9955',
  string: 'ce9178',
  number: 'b5cea8',
  keyword: '569cd6',
  keywordControl: 'c586c0',
  identifier: '9cdcfe',
  type: '4ec9b0',
  constant: '4fc1ff',
  tag: '569cd6',
  attribute: '9cdcfe',
};

const LIGHT_TOKENS: TokenRules = {
  comment: '008000',
  string: 'a31515',
  number: '098658',
  keyword: '0000ff',
  keywordControl: 'af00db',
  identifier: '001080',
  type: '267f99',
  constant: '0070c1',
  tag: '800000',
  attribute: 'e50000',
};

/** Полупрозрачная ступень цвета: `#RRGGBB` плюс альфа в hex (`'40'` ≈ 25 %). */
const fade = (color: string, alpha: string): string => `#${color}${alpha}`;

/** Прозрачный цвет: рамки и тени, которых в нашем оформлении нет. */
const NONE = '#00000000';

/**
 * Оформление редактора и его всплывающих слоёв. Значения повторяют токены
 * `styles/theme.css` — Monaco не читает CSS-переменные, — поэтому у каждого поля
 * назван токен, который оно повторяет: при правке палитры менять нужно в обоих
 * местах. Полотно, гуттер и цвета кода остаются как в VS Code: подсветка кода
 * живёт по правилам VS Code, а обвязка редактора — по нашим.
 */
interface Chrome {
  /* полотно и код — цвета VS Code */
  background: string;
  foreground: string;
  lineNumber: string;
  lineNumberActive: string;
  cursor: string;
  selection: string;
  selectionInactive: string;
  lineHighlight: string;
  indentGuide: string;
  indentGuideActive: string;
  whitespace: string;

  /* всплывающие слои: меню, палитра F1, подсказки, поиск, поля */
  popover: string; // --popup_background
  border: string; // --border_color
  separator: string; // --separator_color
  sunken: string; // --sunken_background
  tint: string; // --element_background
  tintHover: string; // --element_background_hover
  text: string; // --text_color
  textSecondary: string; // --text_color_disabled
  textTertiary: string; // --text_color_tertiary
  placeholder: string; // --placeholder_text_color
  selectionFill: string; // --selection_background
  accent: string; // --blue_prime_background
  accentText: string; // --link_color
  purple: string; // --purple_prime_background
  error: string; // --red_prime_background
  warning: string; // --yellow_prime_background
  highlight: string; // --highlight_background
  highlightStrong: string; // текущее совпадение поиска
  added: string; // --git_added
  modified: string; // --git_modified
  deleted: string; // --git_deleted
  scrollbar: string;
  scrollbarHover: string;
  scrollbarActive: string;
  shadow: string;
}

const DARK_CHROME: Chrome = {
  background: '1e1e1e',
  foreground: 'd4d4d4',
  lineNumber: '858585',
  lineNumberActive: 'c6c6c6',
  cursor: 'aeafad',
  selection: '264f78',
  selectionInactive: '3a3d41',
  lineHighlight: '282828',
  indentGuide: '404040',
  indentGuideActive: '707070',
  whitespace: '3b3b3b',

  // Карточка интерфейса — та же поверхность, что у наших попапов: без прозрачности.
  popover: '1e1e1e',
  border: '3a3a3c',
  separator: '545458a6',
  sunken: '00000033',
  tint: '78788052',
  tintHover: '7878805c',
  text: 'ffffffeb',
  textSecondary: 'ffffffb3',
  textTertiary: 'ffffff73',
  placeholder: 'ffffff66',
  // color-mix(синий 30 %, карточка): та же заливка, что у строки дерева и вкладки.
  selectionFill: '154162',
  accent: '0091ff',
  accentText: '4da6ff',
  purple: 'db34f2',
  error: 'ff4245',
  warning: 'ffd600',
  highlight: 'ffd6003d',
  highlightStrong: 'ffd60073',
  added: '7fc08a',
  modified: 'd9b26a',
  deleted: 'e08a7a',
  scrollbar: '79797966',
  scrollbarHover: '646464b3',
  scrollbarActive: 'bfbfbf66',
  shadow: '00000073',
};

const LIGHT_CHROME: Chrome = {
  background: 'ffffff',
  foreground: '000000',
  lineNumber: '237893',
  lineNumberActive: '0b216f',
  cursor: '000000',
  selection: 'add6ff',
  selectionInactive: 'e5ebf1',
  lineHighlight: 'f5f5f5',
  indentGuide: 'd3d3d3',
  indentGuideActive: '939393',
  whitespace: '33333333',

  // Карточка интерфейса — та же поверхность, что у наших попапов: без прозрачности.
  popover: 'ffffff',
  border: 'c7c7cc',
  separator: '3c3c4349',
  sunken: '0000000d',
  tint: '78788029',
  tintHover: '7878803d',
  text: '000000d9',
  textSecondary: '00000080',
  textTertiary: '00000042',
  placeholder: '00000040',
  // color-mix(синий 14 %, карточка): на белом доля акцента меньше.
  selectionFill: 'dbeeff',
  accent: '0088ff',
  accentText: '0066cc',
  purple: 'cb30e0',
  error: 'ff383c',
  warning: 'ffcc00',
  highlight: 'ffcc0052',
  highlightStrong: 'ffcc0080',
  added: '1f7a34',
  modified: '8a6a1f',
  deleted: 'b03028',
  scrollbar: '64646466',
  scrollbarHover: '646464b3',
  scrollbarActive: '00000099',
  shadow: '00000026',
};

function buildTheme(scheme: Scheme): monaco.editor.IStandaloneThemeData {
  const tokens = scheme === 'dark' ? DARK_TOKENS : LIGHT_TOKENS;
  const chrome = scheme === 'dark' ? DARK_CHROME : LIGHT_CHROME;

  return {
    // Встроенная светлая тема Monaco называется 'vs', а не 'vs-light'.
    base: scheme === 'dark' ? 'vs-dark' : 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: tokens.comment, fontStyle: 'italic' },
      { token: 'string', foreground: tokens.string },
      { token: 'string.escape', foreground: tokens.string },
      { token: 'regexp', foreground: tokens.string },
      { token: 'number', foreground: tokens.number },
      { token: 'keyword', foreground: tokens.keyword },
      // VS Code красит управляющие конструкции отдельно от const/let/class.
      { token: 'keyword.flow', foreground: tokens.keywordControl },
      { token: 'keyword.control', foreground: tokens.keywordControl },
      { token: 'identifier', foreground: tokens.identifier },
      { token: 'type.identifier', foreground: tokens.type },
      { token: 'type', foreground: tokens.type },
      { token: 'constant', foreground: tokens.constant },
      { token: 'tag', foreground: tokens.tag },
      { token: 'attribute.name', foreground: tokens.attribute },
      { token: 'annotation', foreground: tokens.identifier },
      { token: 'delimiter', foreground: chrome.foreground },
      { token: 'operator', foreground: chrome.foreground },
    ],
    colors: {
      /* полотно, гуттер, служебные символы */
      'editor.background': `#${chrome.background}`,
      'editor.foreground': `#${chrome.foreground}`,
      'editorLineNumber.foreground': `#${chrome.lineNumber}`,
      'editorLineNumber.activeForeground': `#${chrome.lineNumberActive}`,
      'editorCursor.foreground': `#${chrome.cursor}`,
      'editorGutter.background': `#${chrome.background}`,
      'editorGutter.foldingControlForeground': `#${chrome.textTertiary}`,
      'editor.lineHighlightBackground': `#${chrome.lineHighlight}`,
      // Строка подсвечивается заливкой без рамки: рамку носят наши блоки, не редактор.
      'editor.lineHighlightBorder': NONE,
      'editorIndentGuide.background1': `#${chrome.indentGuide}`,
      'editorIndentGuide.activeBackground1': `#${chrome.indentGuideActive}`,
      'editorWhitespace.foreground': `#${chrome.whitespace}`,
      'editorBracketMatch.background': fade(chrome.accent, '1f'),
      'editorBracketMatch.border': fade(chrome.accent, '80'),
      'editorBracketHighlight.foreground1': `#${chrome.warning}`,
      'editorBracketHighlight.foreground2': `#${chrome.purple}`,
      'editorBracketHighlight.foreground3': `#${chrome.accent}`,
      'editorLink.activeForeground': `#${chrome.accentText}`,
      'editorCodeLens.foreground': `#${chrome.textTertiary}`,
      'editorGhostText.foreground': `#${chrome.textTertiary}`,
      'editorMultiCursor.primary.foreground': `#${chrome.cursor}`,

      /* выделение, поиск, подсветка вхождений */
      'editor.selectionBackground': `#${chrome.selection}`,
      'editor.inactiveSelectionBackground': `#${chrome.selectionInactive}`,
      'editor.selectionHighlightBackground': fade(chrome.accent, '2e'),
      'editor.wordHighlightBackground': `#${chrome.tint}`,
      'editor.wordHighlightStrongBackground': fade(chrome.accent, '33'),
      'editor.findMatchBackground': `#${chrome.highlightStrong}`,
      'editor.findMatchHighlightBackground': `#${chrome.highlight}`,
      'editor.findRangeHighlightBackground': `#${chrome.tint}`,
      'editorOverviewRuler.border': NONE,
      'minimap.background': `#${chrome.background}`,
      'minimap.selectionHighlight': fade(chrome.accent, '40'),

      /* диагностика — наши акценты, а не палитра VS Code */
      'editorError.foreground': `#${chrome.error}`,
      'editorWarning.foreground': `#${chrome.warning}`,
      'editorInfo.foreground': `#${chrome.accent}`,
      'editorHint.foreground': `#${chrome.textTertiary}`,

      /* всплывающие слои: материал, рамка и одна заливка «это текущее» */
      'widget.shadow': `#${chrome.shadow}`,
      'editorWidget.background': `#${chrome.popover}`,
      'editorWidget.border': `#${chrome.border}`,
      'editorHoverWidget.background': `#${chrome.popover}`,
      'editorHoverWidget.border': `#${chrome.border}`,
      'editorHoverWidget.foreground': `#${chrome.text}`,
      'editorHoverWidget.statusBarBackground': fade(chrome.background, '99'),
      'editorSuggestWidget.background': `#${chrome.popover}`,
      'editorSuggestWidget.border': `#${chrome.border}`,
      'editorSuggestWidget.foreground': `#${chrome.text}`,
      'editorSuggestWidget.selectedBackground': `#${chrome.selectionFill}`,
      'editorSuggestWidget.selectedForeground': `#${chrome.text}`,
      'editorSuggestWidget.highlightForeground': `#${chrome.accent}`,
      'list.hoverBackground': `#${chrome.tintHover}`,
      'list.focusBackground': `#${chrome.selectionFill}`,
      'list.activeSelectionBackground': `#${chrome.selectionFill}`,
      'list.activeSelectionForeground': `#${chrome.text}`,
      'list.inactiveSelectionBackground': `#${chrome.tint}`,
      'list.highlightForeground': `#${chrome.accent}`,
      'input.background': `#${chrome.sunken}`,
      'input.foreground': `#${chrome.text}`,
      'input.border': `#${chrome.border}`,
      'input.placeholderForeground': `#${chrome.placeholder}`,
      'inputOption.activeBorder': `#${chrome.accent}`,
      'menu.background': `#${chrome.popover}`,
      'menu.foreground': `#${chrome.text}`,
      'menu.border': `#${chrome.border}`,
      'menu.selectionBackground': `#${chrome.selectionFill}`,
      'menu.selectionForeground': `#${chrome.text}`,
      'menu.selectionBorder': NONE,
      'menu.separatorBackground': `#${chrome.separator}`,
      'quickInput.background': `#${chrome.popover}`,
      'quickInput.foreground': `#${chrome.text}`,
      'quickInputTitle.background': NONE,
      'quickInputList.focusBackground': `#${chrome.selectionFill}`,
      'quickInputList.focusForeground': `#${chrome.text}`,
      'quickInputList.focusIconForeground': `#${chrome.accent}`,

      /* закреплённые строки и скроллбары */
      'editorStickyScroll.background': `#${chrome.background}`,
      'editorStickyScroll.border': `#${chrome.border}`,
      'editorStickyScroll.shadow': `#${chrome.shadow}`,
      'editorStickyScrollGutter.background': `#${chrome.background}`,
      'scrollbarSlider.background': `#${chrome.scrollbar}`,
      'scrollbarSlider.hoverBackground': `#${chrome.scrollbarHover}`,
      'scrollbarSlider.activeBackground': `#${chrome.scrollbarActive}`,
      'scrollbar.shadow': NONE,

      /* экран сравнения: добавленное и удалённое — в цветах git */
      'diffEditor.border': `#${chrome.border}`,
      'diffEditor.insertedLineBackground': fade(chrome.added, '1f'),
      'diffEditor.removedLineBackground': fade(chrome.deleted, '1f'),
      'diffEditor.insertedTextBackground': fade(chrome.added, '40'),
      'diffEditor.removedTextBackground': fade(chrome.deleted, '40'),
      'diffEditor.diagonalFill': `#${chrome.separator}`,
      'diffEditorOverview.insertedForeground': `#${chrome.added}`,
      'diffEditorOverview.removedForeground': `#${chrome.deleted}`,
      'diffEditorGutter.insertedLineBackground': fade(chrome.added, '33'),
      'diffEditorGutter.removedLineBackground': fade(chrome.deleted, '33'),
    },
  };
}

export const MONACO_THEMES: Record<Scheme, monaco.editor.IStandaloneThemeData> = {
  dark: buildTheme('dark'),
  light: buildTheme('light'),
};

/** Палитра консоли VS Code; фон тот же, что у редактора, поэтому панели не спорят. */
export const TERMINAL_THEMES: Record<Scheme, ITheme> = {
  dark: {
    background: '#1e1e1e',
    foreground: '#d4d4d4',
    cursor: '#d4d4d4',
    cursorAccent: '#1e1e1e',
    selectionBackground: '#264f78',
    black: '#000000',
    red: '#cd3131',
    green: '#0dbc79',
    yellow: '#e5e510',
    blue: '#2472c8',
    magenta: '#bc3fbc',
    cyan: '#11a8cd',
    white: '#e5e5e5',
    brightBlack: '#666666',
    brightRed: '#f14c4c',
    brightGreen: '#23d18b',
    brightYellow: '#f5f543',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29b8db',
    brightWhite: '#e5e5e5',
  },
  light: {
    background: '#ffffff',
    foreground: '#333333',
    cursor: '#333333',
    cursorAccent: '#ffffff',
    selectionBackground: '#add6ff',
    black: '#000000',
    red: '#cd3131',
    green: '#00bc00',
    yellow: '#949800',
    blue: '#0451a5',
    magenta: '#bc05bc',
    cyan: '#0598bc',
    white: '#555555',
    brightBlack: '#666666',
    brightRed: '#cd3131',
    brightGreen: '#14ce14',
    brightYellow: '#b5ba00',
    brightBlue: '#0451a5',
    brightMagenta: '#bc05bc',
    brightCyan: '#0598bc',
    brightWhite: '#a5a5a5',
  },
};

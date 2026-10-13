/**
 * Emmet при вводе: Tab раскрывает сокращение перед кареткой.
 *
 * Это перехватчик клавиш (см. `input/editor-input.ts`): если перед кареткой стоит
 * сокращение Emmet для языка файла, Tab раскрывает его вместо отступа. Иначе клавиша
 * уходит дальше — обычный отступ. Так же ведёт себя Emmet в других редакторах.
 *
 * Сам разбор живёт в `shared/emmet.ts` и ничего не знает ни о буфере, ни о клавишах;
 * здесь только связка: взять слово перед кареткой, спросить разбор, применить правку.
 * Модуль не рисует и не ходит по сети — только реакция на клавишу.
 */

import { abbreviationBefore, emmetSyntaxFor, expandEmmet } from '../../../shared/emmet';
import type { EditorChange, EditorController } from './editor-controller';
import type { KeyInterceptor } from './editor-input';

export interface EmmetOptions {
  controller: EditorController;
  /** Язык открытого файла: по нему выбирается разбор — разметка или стили. */
  language: () => string | null;
  /** Отступ одной ступени: `tabSize` пробелов или табуляция (по настройке). */
  indent: () => string;
  /** Включён ли Emmet (настройка). Выключен — клавишу не трогаем. */
  enabled?: () => boolean;
}

/** Раскрытие сокращений Emmet по Tab. */
export class EmmetExpander implements KeyInterceptor {
  private readonly controller: EditorController;
  private readonly language: () => string | null;
  private readonly indent: () => string;
  private readonly enabled: () => boolean;

  constructor(options: EmmetOptions) {
    this.controller = options.controller;
    this.language = options.language;
    this.indent = options.indent;
    this.enabled = options.enabled ?? (() => true);
  }

  handleKey(event: KeyboardEvent): boolean {
    // Только голый Tab: Shift+Tab снимает отступ, Ctrl/Alt — чужие команды.
    if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
    if (!this.enabled()) return false;

    const syntax = emmetSyntaxFor(this.language());
    if (!syntax) return false;

    const controller = this.controller;
    // Раскрываем только при одной каретке без выделения: при выделении сокращения нет.
    if (controller.selections.length !== 1 || controller.selection.anchor !== controller.selection.active) return false;

    const caret = controller.selection.active;
    const abbreviation = abbreviationBefore(controller.bufferRef.text, caret);
    if (!abbreviation) return false;

    const result = expandEmmet(abbreviation, syntax, { indent: this.indent() });
    if (!result) return false;

    event.preventDefault();
    controller.applyEdit(
      { start: caret - abbreviation.length, removed: abbreviation, inserted: result.text },
      { anchor: caret - abbreviation.length + result.caret, active: caret - abbreviation.length + result.caret },
    );
    return true;
  }

  /** Изменения текста и курсора Emmet не отслеживает: раскрытие — разовое действие. */
  onChange(_change: EditorChange): void {}
}

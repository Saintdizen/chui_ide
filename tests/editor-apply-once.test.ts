import { describe, expect, it } from 'vitest';
import { DocumentStore } from '../src/renderer/core/document-store';
import { EditService } from '../src/renderer/core/edits';
import type { EditorApi } from '../src/renderer/core/editor-api';
import type { TextEdit } from '../src/shared/edits';
import { translateEdits } from '../src/renderer/editor/host/document-edits';
import { DocumentRegistry } from '../src/renderer/editor/host/document-registry';

/**
 * Правка ложится в текст ОДИН раз.
 *
 * Промах, который тут сторожится, — двойное применение. `EditService` сперва правил
 * документ, а следом просил редактор применить те же правки ещё раз; до редактора они
 * доезжали уже применёнными (буфер подтягивается к документу, см. `DocumentRegistry`),
 * и правка ложилась второй раз. Отсечь повтор нечем: `oldText`, совпавший с якорем,
 * как раз и означает, что текст под правкой на месте, — от этого в файлах задваивались
 * строки. Заметно это было на вставке, где `newText` начинается со своего же якоря, —
 * такую форму и берём для проверки.
 *
 * Стенд повторяет путь правки хозяина редактора (`EditorHost.applyEdits`): открытый файл
 * правит буфер (и отдаёт его документу), файл за кадром — сам документ. Живое поведение
 * хозяина проверяет проба (`scripts/own-editor-probe.cjs`), а здесь — договорённость о
 * том, что применяет кто-то один.
 */

const ANCHOR = 'import a;';
const START = `${ANCHOR}\nimport b;\n`;
const AFTER_ONE = `${ANCHOR}\nimport c;\nimport b;\n`;
/** Вставка строки после якоря: `newText` начинается с самого якоря. */
const EDIT: TextEdit = {
  startLine: 1,
  startColumn: 1,
  endLine: 1,
  endColumn: ANCHOR.length + 1,
  newText: `${ANCHOR}\nimport c;`,
  oldText: ANCHOR,
};

/** Хозяин редактора в минимуме: путь правки тот же, DOM не нужен. */
function standIn(documents: DocumentStore, activePath: () => string | null): EditorApi {
  const registry = new DocumentRegistry(documents);
  const editor = {
    applyEdits(document: { path: string }, edits: readonly TextEdit[]) {
      const buffer = registry.resolve(document as never);
      const translated = translateEdits(buffer, edits);
      if (translated.changes.length === 0) return translated;

      if (activePath() === document.path) {
        for (const change of translated.changes) {
          buffer.replace(change.start, change.removed.length, change.inserted);
        }
        registry.push(document.path);
      } else {
        // Файл за кадром: правит документ, буфер подтянет реестр.
        (document as unknown as { applyEdits: (e: readonly TextEdit[], s: string) => number }).applyEdits(
          edits,
          'programmatic',
        );
      }
      return translated;
    },
  };
  return editor as unknown as EditorApi;
}

function service(activePath: () => string | null) {
  const documents = new DocumentStore();
  const editors = standIn(documents, activePath);
  const rpc = { request: () => Promise.reject(new Error('диск в этой проверке не нужен')) };
  const edits = new EditService({ documents, editors, rpc: rpc as never });
  return { documents, edits };
}

const count = (text: string, needle: string) => text.split(needle).length - 1;

describe('правка ложится один раз', () => {
  it('открытый файл: строку не задваивает', async () => {
    const { documents, edits } = service(() => '/p/a.ts');
    const document = documents.open('/p/a.ts', START);

    const result = await edits.applyFileEdits([{ path: '/p/a.ts', edits: [EDIT] }]);

    expect(result.failed).toEqual([]);
    expect(result.reports).toEqual([{ path: '/p/a.ts', applied: 1, version: expect.any(Number) }]);
    expect(document.value).toBe(AFTER_ONE);
    expect(count(document.value, 'import c;')).toBe(1);
  });

  it('файл за кадром: строку не задваивает', async () => {
    const { documents, edits } = service(() => '/p/другой.ts');
    const document = documents.open('/p/a.ts', START);

    const result = await edits.applyFileEdits([{ path: '/p/a.ts', edits: [EDIT] }]);

    expect(result.failed).toEqual([]);
    expect(document.value).toBe(AFTER_ONE);
    expect(count(document.value, 'import c;')).toBe(1);
  });

  it('якорь разошёлся — не применено ничего и сказана причина', async () => {
    const { documents, edits } = service(() => '/p/a.ts');
    const document = documents.open('/p/a.ts', START);

    const result = await edits.applyFileEdits([{ path: '/p/a.ts', edits: [{ ...EDIT, oldText: 'import z;' }] }]);

    expect(result.reports).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.message).toContain('не совпал');
    expect(document.value).toBe(START);
  });
});

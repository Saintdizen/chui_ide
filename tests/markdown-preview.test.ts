import { describe, expect, it } from 'vitest';
import { isMarkdownPath } from '../src/renderer/ui/markdown-preview';

describe('isMarkdownPath: что показывает предпросмотр', () => {
  it('markdown и его родня', () => {
    expect(isMarkdownPath('/p/README.md')).toBe(true);
    expect(isMarkdownPath('/p/doc.markdown')).toBe(true);
    expect(isMarkdownPath('/p/page.mdx')).toBe(true);
    expect(isMarkdownPath('/p/notes.mdown')).toBe(true);
  });

  it('регистр расширения не важен', () => {
    expect(isMarkdownPath('/p/README.MD')).toBe(true);
  });

  it('прочее — не markdown', () => {
    expect(isMarkdownPath('/p/main.ts')).toBe(false);
    expect(isMarkdownPath('/p/style.css')).toBe(false);
    expect(isMarkdownPath('/p/README')).toBe(false);
    // «.md» внутри имени — не расширение.
    expect(isMarkdownPath('/p/readme.md.txt')).toBe(false);
  });
});

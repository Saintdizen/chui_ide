/**
 * Path of symbols for breadcrumbs: which declaration the cursor sits inside.
 *
 * The structure of a file is already known — `textDocument/documentSymbol` gives
 * nested `FileSymbol` with line ranges. Breadcrumbs need only the other half:
 * the chain `App > Chat > render` for a given line.
 *
 * Kept pure and DOM-free so it is testable and shared by the breadcrumbs strip
 * and the outline.
 */
import type { FileSymbol } from './lsp-symbols';

/** One link of the breadcrumb trail. */
export interface SymbolPathLink {
  name: string;
  /** Kind in words: «класс», «метод», «функция» — same vocabulary as the outline. */
  kind: string;
  /** Start line (1-based): clicking a link reveals the declaration. */
  line: number;
}

/**
 * Chain of declarations enclosing `line` (1-based), outermost first.
 *
 * Empty result means the line is outside any declaration, or the file has no
 * structure — the caller hides the strip instead of showing an empty crumb.
 *
 * Nested symbols lie inside the parent range, so the deepest match wins. Siblings
 * that merely touch the line are ignored: the search follows the `children` tree,
 * not the flat list, and only descends into a child whose range actually covers
 * the line.
 */
export function symbolPathAt(symbols: readonly FileSymbol[], line: number): SymbolPathLink[] {
  const path: SymbolPathLink[] = [];
  let level: readonly FileSymbol[] = symbols;

  // A symbol claims the line when the line falls into [line, endLine]. `endLine`
  // of a one-line symbol equals `line`, so a declaration on the cursor line is
  // still its own.
  for (;;) {
    // Tightest winner, not the first: a flat `SymbolInformation` list carries no
    // nesting, so an enclosing class would otherwise swallow its own method and
    // the trail would name the class for a line that is inside `render`.
    let hit: FileSymbol | null = null;
    for (const symbol of level) {
      if (symbol.line > line || line > symbol.endLine) continue;
      if (!hit || symbol.endLine - symbol.line < hit.endLine - hit.line) hit = symbol;
    }
    if (!hit) break;

    path.push({ name: hit.name, kind: hit.kind, line: hit.line });
    level = hit.children;
    // Children of a leaf are empty — the loop ends on the next pass.
  }

  return path;
}

/** Human-readable form for `title` attributes and logs: «App › Chat › render». */
export function symbolPathLabel(path: readonly SymbolPathLink[]): string {
  return path.map((link) => link.name).join(' › ');
}

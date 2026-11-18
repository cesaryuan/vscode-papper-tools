import type { FigureDocument } from "./model";
import type { PanelTree } from "./panelTree";

const counters = new WeakMap<FigureDocument, { e: number; s: number }>();
const legacyId = /^e-[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i;

/** Visits split nodes and panel references in their saved order. */
function visitTree(node: PanelTree | undefined, visit: (node: PanelTree) => void): void {
  if (!node) return;
  visit(node);
  if (node.kind === "split") node.children.forEach(child => visitTree(child, visit));
}

/** Reserves a local ID even when several copies or splits are created before insertion. */
export function newElementId(figure: FigureDocument, prefix: "e" | "s" = "e"): string {
  const used = new Set(figure.elements.map(element => element.id));
  visitTree(figure.layout.tree, node => used.add(node.id));
  const next = counters.get(figure) ?? { e: 0, s: 0 };
  counters.set(figure, next);
  let id: string;
  do { id = prefix + ++next[prefix]; } while (used.has(id));
  return id;
}

/** Rewrites only editor-generated legacy GUIDs, preserving custom IDs and panel references. */
export function shortenLegacyIds(figure: FigureDocument): void {
  const panels = new Map<string, string>();
  for (const element of figure.elements) {
    if (!legacyId.test(element.id)) continue;
    const id = newElementId(figure);
    if (element.kind === "panel") panels.set(element.id, id);
    element.id = id;
  }
  visitTree(figure.layout.tree, node => {
    if (node.kind === "panel") node.id = panels.get(node.id) ?? node.id;
    else if (legacyId.test(node.id)) node.id = newElementId(figure, "s");
  });
}

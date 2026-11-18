/** Manages nested panel splits, physical layout and divider gestures for structured figures. */
import { captionRuns, elementHeight, estimateText, newElementId, reflowFigure, visibleRatio, wrapText,
  type FigureDocument, type MeasureText, type Panel } from "./model";

export type PanelNode = { kind: "panel"; id: string };
export type SplitNode = { kind: "split"; id: string; axis: "x" | "y"; children: PanelTree[]; weights?: number[] };
export type PanelTree = PanelNode | SplitNode;
export type Box = { x: number; y: number; width: number; height: number };
export type TreeDivider = { split: string; index: number; axis: "x" | "y"; position: number; box: Box };
export type TreeDock = { anchor: string; side: "left" | "right" | "top" | "bottom"; scope: "panel" | "figure" };

/** Wraps several nodes in a split while avoiding redundant one-child containers. */
function split(axis: "x" | "y", children: PanelTree[], weights?: number[]): PanelTree {
  return children.length === 1 ? children[0] : { kind: "split", id: newElementId(), axis, children, ...(weights ? { weights } : {}) };
}

/** Converts saved row arrangements into nested splits without discarding explicit width proportions. */
export function treeFromRows(figure: FigureDocument): PanelTree | undefined {
  const panels = figure.elements.filter((element): element is Panel => element.kind === "panel"), rows: PanelTree[] = [];
  for (let index = 0; index < panels.length;) {
    const count = figure.layout.rows[rows.length] || figure.layout.columns, row = panels.slice(index, index + count);
    const weights = figure.layout.weights.slice(index, index + row.length);
    rows.push(split("x", row.map((panel) => ({ kind: "panel", id: panel.id })),
      weights.length ? row.map((panel, offset) => weights[offset] || visibleRatio(panel)) : undefined));
    index += count;
  }
  return rows.length ? split("y", rows) : undefined;
}

/** Applies a common asymmetric three-panel preset, placing any remaining panels in rows below it. */
export function nestedPanelPreset(figure: FigureDocument, leftCount: number): void {
  const panels = figure.elements.filter((element): element is Panel => element.kind === "panel");
  if (panels.length < 3) return;
  const left = split("y", panels.slice(0, leftCount).map((panel) => ({ kind: "panel", id: panel.id })));
  const right = split("y", panels.slice(leftCount, 3).map((panel) => ({ kind: "panel", id: panel.id })));
  const pair = split("x", [left, right]);
  const rest = treeFromRows({ ...figure, layout: { ...figure.layout, rows: [], weights: [] }, elements: panels.slice(3) });
  figure.layout.mode = "panels"; figure.layout.tree = rest ? split("y", [pair, rest]) : pair;
}

/** Prunes removed panels, collapses empty containers and preserves the surviving manual shares. */
function prune(node: PanelTree | undefined, ids: Set<string>): PanelTree | undefined {
  if (!node) return undefined;
  if (node.kind === "panel") return ids.has(node.id) ? node : undefined;
  const items = node.children.map((child, index) => ({ node: prune(child, ids), weight: node.weights?.[index] })).filter((item) => item.node);
  return items.length ? items.length === 1 ? items[0].node
    : { ...node, children: items.map((item) => item.node), weights: node.weights ? items.map((item) => item.weight) : undefined } : undefined;
}

/** Lists panel identities in visual tree order, keeping labels independent of rearrangement. */
export function treePanelIds(node: PanelTree | undefined): string[] {
  return !node ? [] : node.kind === "panel" ? [node.id] : node.children.flatMap(treePanelIds);
}

/** Reconciles additions and deletions with the persisted tree, including legacy row documents. */
export function syncPanelTree(figure: FigureDocument): void {
  const panels = figure.elements.filter((element): element is Panel => element.kind === "panel");
  let tree = figure.layout.tree ? prune(figure.layout.tree, new Set(panels.map((panel) => panel.id))) : treeFromRows(figure);
  const present = new Set(treePanelIds(tree)), added = panels.filter((panel) => !present.has(panel.id));
  if (added.length) tree = split("y", [...(tree ? [tree] : []), ...added.map((panel): PanelTree => ({ kind: "panel", id: panel.id }))]);
  figure.layout.tree = tree;
}

/** Places nested splits using image aspect ratios, physical gaps and measured caption reservations. */
export function arrangePanelTree(figure: FigureDocument, measure: MeasureText = estimateText): void {
  syncPanelTree(figure);
  const tree = figure.layout.tree;
  if (!tree) { reflowFigure(figure, measure); return; }
  const panels = new Map(figure.elements.filter((element): element is Panel => element.kind === "panel").map((panel) => [panel.id, panel]));
  const width = Math.max(1, figure.width - 2 * figure.layout.padding);
  type Plan = { node: PanelTree; width: number; height: number; a: number; b: number; children?: Plan[] };
  /** Estimates the image-only proportions before accounting for fixed-size caption space. */
  const aspect = (node: PanelTree): number => node.kind === "panel" ? visibleRatio(panels.get(node.id))
    : node.axis === "x" ? node.children.reduce((sum, child) => sum + aspect(child), 0)
      : 1 / node.children.reduce((sum, child) => sum + 1 / aspect(child), 0);
  /** Measures actual widths before placing cells, avoiding caption feedback that collapses narrow columns. */
  const plan = (node: PanelTree, availableWidth: number): Plan => {
    if (node.kind === "panel") {
      const panel = panels.get(node.id), lines = wrapText(captionRuns(panel), availableWidth, panel.style, measure);
      const a = 1 / visibleRatio(panel), b = lines.length ? panel.gap + lines.length * panel.style.size * 1.25 : 0;
      return { node, width: availableWidth, height: a * availableWidth + b, a, b };
    }
    const horizontal = node.axis === "x", gap = horizontal ? figure.layout.gap : figure.layout.rowGap;
    if (!horizontal) {
      const children = node.children.map((child) => plan(child, availableWidth));
      return { node, width: availableWidth, height: children.reduce((sum, child) => sum + child.height, gap * (children.length - 1)),
        a: children.reduce((sum, child) => sum + child.a, 0), b: children.reduce((sum, child) => sum + child.b, gap * (children.length - 1)), children };
    }
    const available = Math.max(node.children.length, availableWidth - gap * (node.children.length - 1));
    const ratios = node.weights ?? node.children.map(aspect), total = ratios.reduce((a, b) => a + b, 0);
    let widths = ratios.map((value) => available * value / total);
    const allPanels = node.children.every((child) => child.kind === "panel");
    if (!node.weights && !allPanels) {
      const estimates = node.children.map((child, index) => plan(child, widths[index]));
      const inverse = estimates.reduce((sum, child) => sum + 1 / child.a, 0);
      const height = (available + estimates.reduce((sum, child) => sum + child.b / child.a, 0)) / inverse;
      // Long captions in a stacked column must not progressively squeeze that column to zero width.
      const minimum = Math.min(96, available / node.children.length * .6);
      const shares = estimates.map((child) => Math.max(minimum, (height - child.b) / child.a));
      const extra = shares.reduce((sum, value) => sum + value - minimum, 0), remaining = available - minimum * shares.length;
      widths = shares.map((value) => minimum + (extra ? (value - minimum) / extra : 1 / shares.length) * remaining);
    }
    const children = node.children.map((child, index) => plan(child, widths[index]));
    const height = Math.max(...children.map((child) => child.height));
    const inverse = children.reduce((sum, child) => sum + 1 / child.a, 0), a = 1 / inverse;
    return { node, width: availableWidth, height, a, b: height - a * availableWidth, children };
  };
  const root = plan(tree, width);
  /** Assigns whole cells while preserving captions and matching sibling region boundaries. */
  const place = (item: Plan, x: number, y: number, height: number, captionReserve?: number): void => {
    if (item.node.kind === "panel") {
      const panel = panels.get(item.node.id);
      Object.assign(panel, { x, y, width: item.width, height: Math.max(1, height - (captionReserve ?? item.b)) });
      return;
    }
    const horizontal = item.node.axis === "x", gap = horizontal ? figure.layout.gap : figure.layout.rowGap;
    const reserve = horizontal && item.node.children.every((child) => child.kind === "panel") ? Math.max(...item.children.map((child) => child.b)) : undefined;
    const shares = item.node.weights ?? item.children.map((child) => child.height), total = shares.reduce((a, b) => a + b, 0);
    const available = Math.max(item.children.length, height - gap * (item.children.length - 1));
    let cursor = horizontal ? x : y;
    item.children.forEach((child, index) => {
      const span = horizontal ? height : available * shares[index] / total;
      place(child, horizontal ? cursor : x, horizontal ? y : cursor, span, reserve);
      cursor += (horizontal ? child.width : span) + gap;
    });
  };
  place(root, figure.layout.padding, figure.layout.padding, figure.autoHeight ? root.height : Math.max(1, figure.height - 2 * figure.layout.padding));
  reflowFigure(figure, measure);
}

/** Derives subtree bounds and both orientations of divider from the current physical geometry. */
export function treeGeometry(figure: FigureDocument): { boxes: Map<string, Box>; dividers: TreeDivider[] } {
  const boxes = new Map<string, Box>(), dividers: TreeDivider[] = [];
  const panels = new Map(figure.elements.filter((element): element is Panel => element.kind === "panel").map((panel) => [panel.id, panel]));
  /** Combines descendant bounds without interpreting the tree as a flat row list. */
  const visit = (node: PanelTree): Box => {
    if (node.kind === "panel") {
      const panel = panels.get(node.id), box = { x: panel.x, y: panel.y, width: panel.width, height: elementHeight(panel) };
      boxes.set(node.id, box); return box;
    }
    const children = node.children.map(visit), x = Math.min(...children.map((box) => box.x)), y = Math.min(...children.map((box) => box.y));
    const box = { x, y, width: Math.max(...children.map((item) => item.x + item.width)) - x, height: Math.max(...children.map((item) => item.y + item.height)) - y };
    boxes.set(node.id, box);
    children.slice(0, -1).forEach((left, index) => {
      const right = children[index + 1];
      dividers.push({ split: node.id, index, axis: node.axis, box,
        position: node.axis === "x" ? (left.x + left.width + right.x) / 2 : (left.y + left.height + right.y) / 2 });
    });
    return box;
  };
  if (figure.layout.tree) visit(figure.layout.tree);
  return { boxes, dividers };
}

/** Picks local docking or whole-figure insertion within the visible canvas, in figure-relative points. */
export function findTreeDock(figure: FigureDocument, moving: Set<string>, x: number, y: number, canvas?: Box): TreeDock | undefined {
  const panels = figure.elements.filter((element): element is Panel => element.kind === "panel" && !moving.has(element.id));
  const bounds = canvas ?? { x: -16, y: -16, width: figure.width + 32, height: figure.height + 36 };
  // A4 whitespace belongs to the docking surface, even far below a short combination figure.
  if (!panels.length || x < bounds.x || x > bounds.x + bounds.width || y < bounds.y || y > bounds.y + bounds.height) return undefined;
  // Side whitespace spans the full paper height; its corners must not become top/bottom row targets.
  if (canvas && (x < 0 || x > figure.width)) {
    return { anchor: panels[0].id, side: x < 0 ? "left" : "right", scope: "figure" };
  }
  const panel = panels.reduce((nearest, candidate) => {
    const distance = Math.hypot(Math.max(candidate.x - x, x - candidate.x - candidate.width, 0),
      Math.max(candidate.y - y, y - candidate.y - elementHeight(candidate), 0));
    const old = Math.hypot(Math.max(nearest.x - x, x - nearest.x - nearest.width, 0),
      Math.max(nearest.y - y, y - nearest.y - elementHeight(nearest), 0));
    return distance < old ? candidate : nearest;
  });
  const scope = x < figure.layout.padding || x > figure.width - figure.layout.padding
    || y < figure.layout.padding || y > figure.height - figure.layout.padding ? "figure" : "panel";
  // Outer direction uses the whole figure so nearby narrow panels cannot turn a bottom drop into a column.
  const horizontal = scope === "figure" ? x / figure.width : (x - panel.x) / panel.width;
  const vertical = scope === "figure" ? y / figure.height : (y - panel.y) / elementHeight(panel);
  const sides: Array<{ side: TreeDock["side"]; distance: number }> = [
    { side: "left", distance: horizontal }, { side: "right", distance: 1 - horizontal },
    { side: "top", distance: vertical }, { side: "bottom", distance: 1 - vertical },
  ];
  const side = sides.sort((a, b) => a.distance - b.distance)[0].side;
  return { anchor: panel.id, side, scope };
}

/** Inserts moved panels beside a leaf or the whole figure, preserving all unrelated nested splits. */
export function dockTreePanels(figure: FigureDocument, ids: Set<string>, target: TreeDock, measure?: MeasureText): void {
  syncPanelTree(figure);
  const moving = treePanelIds(figure.layout.tree).filter((id) => ids.has(id));
  if (!moving.length || ids.has(target.anchor)) return;
  const remaining = new Set(treePanelIds(figure.layout.tree).filter((id) => !ids.has(id)));
  let root = prune(figure.layout.tree, remaining);
  if (!root) return;
  const axis = target.side === "left" || target.side === "right" ? "x" : "y";
  const before = target.side === "left" || target.side === "top";
  const inserted = split(axis, moving.map((id) => ({ kind: "panel", id })));
  /** Replaces the local leaf, flattening compatible automatic splits for natural side-by-side rows. */
  const insert = (node: PanelTree): PanelTree => {
    if (node.id === target.anchor) return split(axis, before ? [inserted, node] : [node, inserted]);
    if (node.kind === "panel") return node;
    if (node.axis === axis && !node.weights && node.children.some((child) => child.id === target.anchor)) {
      const index = node.children.findIndex((child) => child.id === target.anchor);
      node.children.splice(index + (before ? 0 : 1), 0, inserted); return node;
    }
    return { ...node, children: node.children.map(insert) };
  };
  root = target.scope === "figure" ? split(axis, before ? [inserted, root] : [root, inserted]) : insert(root);
  figure.layout.mode = "panels"; figure.layout.tree = root;
  const order = treePanelIds(root), byId = new Map(figure.elements.map((element) => [element.id, element]));
  figure.elements = [...order.map((id) => byId.get(id)), ...figure.elements.filter((element) => element.kind === "text")];
  arrangePanelTree(figure, measure);
}

/** Resizes a nested split pair; snapping works on either axis and aligns with parallel dividers. */
export function resizeTreeDivider(figure: FigureDocument, splitId: string, index: number, delta: number, tolerance: number,
  previous?: number, measure?: MeasureText): { axis: "x" | "y"; position: number; label: "fraction" | "aligned" | "equal" | "equal-height"; fraction?: number } | undefined {
  const geometry = treeGeometry(figure), divider = geometry.dividers.find((item) => item.split === splitId && item.index === index);
  if (!divider) return undefined;
  /** Locates the persisted container whose two neighbouring shares are being edited. */
  const find = (node: PanelTree): SplitNode | undefined => node.kind === "panel" ? undefined
    : node.id === splitId ? node : node.children.map(find).find(Boolean);
  const node = find(figure.layout.tree), horizontal = divider.axis === "x", left = geometry.boxes.get(node.children[index].id),
    right = geometry.boxes.get(node.children[index + 1].id);
  const start = horizontal ? left.x : left.y, first = horizontal ? left.width : left.height,
    second = horizontal ? right.width : right.height, combined = first + second;
  const gapHalf = divider.position - start - first, min = Math.min(12, combined * .2);
  const size = horizontal ? figure.width : figure.height, desired = divider.position + delta;
  const targets = [
    ...[.5, 1 / 3, 2 / 3, .25, .75].map((fraction) => ({ axis: divider.axis, position: size * fraction, label: "fraction" as const, fraction })),
    { axis: divider.axis, position: start + combined / 2 + gapHalf, label: "equal" as const },
    ...(horizontal && node.children[index].kind === "panel" && node.children[index + 1].kind === "panel" ? [{
      axis: divider.axis, position: start + combined * visibleRatio(figure.elements.find((element) => element.id === node.children[index].id) as Panel)
        / (visibleRatio(figure.elements.find((element) => element.id === node.children[index].id) as Panel)
          + visibleRatio(figure.elements.find((element) => element.id === node.children[index + 1].id) as Panel)) + gapHalf, label: "equal-height" as const,
    }] : []),
    ...geometry.dividers.filter((item) => item.axis === divider.axis && item !== divider).map((item) =>
      ({ axis: divider.axis, position: item.position, label: "aligned" as const })),
  ].filter((item) => item.position >= start + min + gapHalf && item.position <= start + combined - min + gapHalf);
  const held = tolerance > 0 ? targets.find((item) => item.position === previous && Math.abs(item.position - desired) <= tolerance * 1.5) : undefined;
  const captured = held ?? targets.filter((item) => tolerance > 0 && Math.abs(item.position - desired) <= tolerance)
    .sort((a, b) => Math.abs(a.position - b.position) < .000001 ? 0 : Math.abs(a.position - desired) - Math.abs(b.position - desired))[0];
  const next = Math.max(min, Math.min(combined - min, (captured?.position ?? desired) - start - gapHalf));
  const shares = node.weights ?? node.children.map((child) => {
    const box = geometry.boxes.get(child.id); return horizontal ? box.width : box.height;
  });
  const total = shares[index] + shares[index + 1];
  shares[index] = total * next / combined; shares[index + 1] = total - shares[index];
  node.weights = shares; arrangePanelTree(figure, measure);
  return captured;
}

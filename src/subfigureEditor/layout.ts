import { arrangePanels, elementHeight, visibleRatio, type FigureDocument, type MeasureText, type Panel } from "./model";

export type DockTarget = { kind: "beside" | "row"; anchor: string; side: "before" | "after" };
export type DividerSnap = { x: number; kind: "fraction" | "equal-width" | "equal-height" | "aligned"; fraction?: number };
export type AlignmentGuide = { axis: "x" | "y"; position: number; anchor: number;
  kind: "canvas-edge" | "canvas-center" | "element-edge" | "element-center" };

/** Expands the saved row counts without depending on screen coordinates or current zoom. */
export function panelRows(figure: FigureDocument): Panel[][] {
  const panels = figure.elements.filter((item): item is Panel => item.kind === "panel"), rows: Panel[][] = [];
  let index = 0;
  while (index < panels.length) {
    const count = figure.layout.rows[rows.length] || figure.layout.columns;
    rows.push(panels.slice(index, index + count));
    index += count;
  }
  return rows;
}

/** Finds row-edge or panel-side docking zones, excluding the panels being moved. */
export function findDockTarget(figure: FigureDocument, moving: Set<string>, x: number, y: number): DockTarget | undefined {
  const rows = panelRows(figure).map((row) => row.filter((panel) => !moving.has(panel.id))).filter((row) => row.length);
  if (!rows.length || x < -12 || x > figure.width + 12 || y < -12) return undefined;
  const row = rows.reduce((nearest, candidate) => {
    const top = Math.min(...candidate.map((panel) => panel.y)), bottom = Math.max(...candidate.map((panel) => panel.y + elementHeight(panel)));
    const distance = Math.max(top - y, y - bottom, 0);
    const nearTop = Math.min(...nearest.map((panel) => panel.y)), nearBottom = Math.max(...nearest.map((panel) => panel.y + elementHeight(panel)));
    return distance < Math.max(nearTop - y, y - nearBottom, 0) ? candidate : nearest;
  });
  const top = Math.min(...row.map((panel) => panel.y)), bottom = Math.max(...row.map((panel) => panel.y + elementHeight(panel)));
  const edge = Math.min(22, (bottom - top) * .22);
  if (y < top + edge || y > bottom - edge) return { kind: "row", anchor: row[0].id, side: y < top + edge ? "before" : "after" };
  const panel = row.reduce((nearest, candidate) => Math.abs(candidate.x + candidate.width / 2 - x) < Math.abs(nearest.x + nearest.width / 2 - x) ? candidate : nearest);
  return { kind: "beside", anchor: panel.id, side: x < panel.x + panel.width / 2 ? "before" : "after" };
}

/** Moves complete panels into a row or a new row, preserving labels, captions, crops and other rows' ratios. */
export function dockPanels(figure: FigureDocument, ids: Set<string>, target: DockTarget, measure?: MeasureText): void {
  const original = panelRows(figure), moving = original.flat().filter((panel) => ids.has(panel.id));
  if (!moving.length || ids.has(target.anchor)) return;
  const weights = new Map(original.flat().map((panel, index) => [panel.id, figure.layout.weights[index] || visibleRatio(panel)]));
  const rows = original.map((row) => row.filter((panel) => !ids.has(panel.id))).filter((row) => row.length);
  const rowIndex = rows.findIndex((row) => row.some((panel) => panel.id === target.anchor));
  if (rowIndex < 0) return;
  if (target.kind === "row") rows.splice(rowIndex + (target.side === "after" ? 1 : 0), 0, moving);
  else {
    const row = rows[rowIndex], index = row.findIndex((panel) => panel.id === target.anchor);
    row.splice(index + (target.side === "after" ? 1 : 0), 0, ...moving);
    // Rebuild the destination row with equal image heights, including cropped images.
    for (const panel of row) weights.set(panel.id, visibleRatio(panel));
  }
  if (target.kind === "row") for (const panel of moving) weights.set(panel.id, visibleRatio(panel));
  figure.elements = [...rows.flat(), ...figure.elements.filter((item) => item.kind === "text")];
  figure.layout.mode = "rows";
  figure.layout.rows = rows.map((row) => row.length);
  figure.layout.weights = rows.flat().map((panel) => weights.get(panel.id));
  arrangePanels(figure, measure);
}

/** Snaps the gap centre to useful divisions, preserving minimum widths and resisting edge jitter. */
export function snapRowDivider(figure: FigureDocument, leftId: string, rightId: string, delta: number, tolerance: number,
  previousX?: number): { delta: number; snap?: DividerSnap } {
  const rows = panelRows(figure), row = rows.find((items) => items.some((panel, index) => panel.id === leftId && items[index + 1]?.id === rightId));
  if (!row || tolerance <= 0) return { delta };
  const left = row.find((panel) => panel.id === leftId), right = row.find((panel) => panel.id === rightId);
  const combined = left.width + right.width, gapHalf = (right.x - left.x - left.width) / 2;
  const origin = left.x + left.width + gapHalf, position = origin + delta, min = Math.min(12, combined * .2);
  const candidates = ([
    ...[.5, 1 / 3, 2 / 3, .25, .75].map((fraction): DividerSnap => ({ x: figure.width * fraction, kind: "fraction", fraction })),
    { x: left.x + combined / 2 + gapHalf, kind: "equal-width" },
    { x: left.x + combined * visibleRatio(left) / (visibleRatio(left) + visibleRatio(right)) + gapHalf, kind: "equal-height" },
    ...rows.filter((items) => items !== row).flatMap((items) => items.slice(0, -1).map((panel, index): DividerSnap =>
      ({ x: (panel.x + panel.width + items[index + 1].x) / 2, kind: "aligned" }))),
  ] satisfies DividerSnap[]).filter((target) => target.x >= left.x + min + gapHalf && target.x <= left.x + combined - min + gapHalf);
  // A slightly wider release distance keeps the captured guide stable under small hand movements.
  const held = candidates.find((target) => target.x === previousX && Math.abs(target.x - position) <= tolerance * 1.5);
  // Equivalent guides can differ by floating-point rounding; keep canvas fractions first in that case.
  const nearest = held ?? candidates.filter((target) => Math.abs(target.x - position) <= tolerance)
    .sort((a, b) => Math.abs(a.x - b.x) < .000001 ? 0 : Math.abs(a.x - position) - Math.abs(b.x - position))[0];
  return nearest ? { delta: nearest.x - origin, snap: nearest } : { delta };
}

/** Aligns a moving selection's edges or centres, reporting the exact guides used for its final position. */
export function snapSelection(figure: FigureDocument, ids: Set<string>, dx: number, dy: number, tolerance: number,
  previous: AlignmentGuide[] = []): { dx: number; dy: number; guides: AlignmentGuide[] } {
  const moving = figure.elements.filter((element) => ids.has(element.id)), others = figure.elements.filter((element) => !ids.has(element.id));
  if (!moving.length) return { dx, dy, guides: [] };
  const guides: AlignmentGuide[] = [];
  /** Captures one axis independently so horizontal and vertical alignment can occur together. */
  const align = (axis: "x" | "y", delta: number): number => {
    const start = Math.min(...moving.map((element) => element[axis]));
    if (tolerance <= 0) return Math.max(-start, delta);
    const end = Math.max(...moving.map((element) => element[axis] + (axis === "x" ? element.width : elementHeight(element))));
    const size = axis === "x" ? figure.width : figure.height;
    const targets: Array<Pick<AlignmentGuide, "position" | "kind">> = [
      { position: size / 2, kind: "canvas-center" }, { position: 0, kind: "canvas-edge" }, { position: size, kind: "canvas-edge" },
      ...others.flatMap((element): Array<Pick<AlignmentGuide, "position" | "kind">> => {
        const length = axis === "x" ? element.width : elementHeight(element);
        return [{ position: element[axis] + length / 2, kind: "element-center" },
          { position: element[axis], kind: "element-edge" }, { position: element[axis] + length, kind: "element-edge" }];
      }),
    ];
    const candidates = targets.flatMap((target) => [start, (start + end) / 2, end].map((anchor) => ({ ...target, axis, anchor })))
      .filter((guide) => start + guide.position - guide.anchor >= 0);
    const held = candidates.find((guide) => previous.some((item) => item.axis === axis && item.position === guide.position && item.anchor === guide.anchor)
      && Math.abs(guide.position - guide.anchor - delta) <= tolerance * 1.5);
    const captured = held ?? candidates.filter((guide) => Math.abs(guide.position - guide.anchor - delta) <= tolerance)
      .sort((a, b) => Math.abs(a.position - a.anchor - delta) - Math.abs(b.position - b.anchor - delta))[0];
    if (captured && tolerance > 0) { guides.push(captured); return captured.position - captured.anchor; }
    return Math.max(-start, delta);
  };
  return { dx: align("x", dx), dy: align("y", dy), guides };
}

/** Resizes adjacent panels with a divider, keeping their combined width and all other shares unchanged. */
export function resizeRowPair(figure: FigureDocument, leftId: string, rightId: string, delta: number, measure?: MeasureText): void {
  const rows = panelRows(figure), panels = rows.flat();
  const leftIndex = panels.findIndex((panel) => panel.id === leftId), rightIndex = panels.findIndex((panel) => panel.id === rightId);
  if (!rows.some((row) => row.some((panel, index) => panel.id === leftId && row[index + 1]?.id === rightId))) return;
  const left = panels[leftIndex], right = panels[rightIndex], width = left.width + right.width;
  const min = Math.min(12, width * .2), next = Math.max(min, Math.min(width - min, left.width + delta));
  const weights = panels.map((panel, index) => figure.layout.weights[index] || visibleRatio(panel)), total = weights[leftIndex] + weights[rightIndex];
  weights[leftIndex] = total * next / width;
  weights[rightIndex] = total - weights[leftIndex];
  figure.layout.rows = rows.map((row) => row.length);
  figure.layout.weights = weights;
  arrangePanels(figure, measure);
}

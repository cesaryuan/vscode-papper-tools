/** Shared physical layout model for the SVG editor, saved figures and PNG exports. */
export const PT_PER_MM = 72 / 25.4;
export const A4 = { width: 210 * PT_PER_MM, height: 297 * PT_PER_MM };
export type RichRun = { text: string; bold?: boolean; italic?: boolean; script?: "super" | "sub" };
export type TextStyle = { family: string; size: number; color: string; align: "left" | "center" | "right" };
export type TextLine = { runs: RichRun[]; width: number };
export type Crop = { left: number; top: number; right: number; bottom: number };
export type Panel = {
  kind: "panel"; id: string; source: string; linkedSource?: string; name: string; ratio: number;
  x: number; y: number; width: number; height: number;
  label: string; labelPosition: "below" | "top-left" | "top-right" | "none";
  caption: RichRun[]; style: TextStyle; lines?: TextLine[]; crop: Crop; gap: number;
};
export type SharedText = {
  kind: "text"; id: string; x: number; y: number; width: number;
  runs: RichRun[]; style: TextStyle; lines?: TextLine[];
};
export type FigureElement = Panel | SharedText;
export type FigureDocument = {
  format: "papper-subfigure"; version: 1; width: number; height: number; autoHeight: boolean; embedded: boolean;
  background: "white" | "transparent"; font: TextStyle;
  layout: { columns: number; rows: number[]; weights: number[]; gap: number; rowGap: number; padding: number };
  elements: FigureElement[];
};
export type MeasureText = (run: RichRun, style: TextStyle) => number;

/** Makes a new editable figure in physical points, independent of screen zoom or DPI. */
export function createFigure(): FigureDocument {
  return { format: "papper-subfigure", version: 1, width: 160 * PT_PER_MM, height: 85 * PT_PER_MM,
    autoHeight: true, embedded: false, background: "white", font: { family: "Times New Roman", size: 10, color: "#000000", align: "center" },
    layout: { columns: 2, rows: [], weights: [], gap: 10, rowGap: 16, padding: 8 }, elements: [] };
}

/** Generates stable element identities without encoding the current visual order. */
export function newElementId(): string {
  return `e-${globalThis.crypto.randomUUID()}`;
}

/** Builds one intact source image with editable crop and attached caption. */
export function createPanel(figure: FigureDocument, source: string, name: string, ratio = 1.5): Panel {
  const index = figure.elements.filter((element) => element.kind === "panel").length;
  return { kind: "panel", id: newElementId(), source, name, ratio, x: 8, y: 8, width: 180, height: 120,
    label: panelLetter(index), labelPosition: "below", caption: [], style: { ...figure.font },
    crop: { left: 0, right: 0, top: 0, bottom: 0 }, gap: 5 };
}

/** Continues alphabetic labels past z without silently duplicating existing labels. */
export function panelLetter(index: number): string {
  let label = "";
  for (let value = index + 1; value > 0; value = Math.floor((value - 1) / 26)) label = String.fromCharCode(97 + (value - 1) % 26) + label;
  return label;
}

/** Returns an image's visible aspect ratio after non-destructive cropping. */
export function visibleRatio(panel: Panel): number {
  return panel.ratio * (100 - panel.crop.left - panel.crop.right) / (100 - panel.crop.top - panel.crop.bottom);
}

/** Produces the attached caption, with a visual letter only when its position is below. */
export function captionRuns(panel: Panel): RichRun[] {
  const prefix = panel.labelPosition === "below" && panel.label ? [{ text: `(${panel.label})${panel.caption.length ? " " : ""}` }] : [];
  return [...prefix, ...panel.caption];
}

/** Measures fallback layouts before a browser has supplied actual selected-font metrics. */
export function estimateText(run: RichRun, style: TextStyle): number {
  return Array.from(run.text).reduce((sum, character) => sum + (/[^\u0000-\u02ff]/.test(character) ? 1 : /\s/.test(character) ? .25 : .49), 0)
    * style.size * (run.script ? .7 : 1);
}

/** Wraps formatted text using actual font measurements, preserving line breaks and run styles. */
export function wrapText(runs: RichRun[], width: number, style: TextStyle, measure: MeasureText = estimateText): TextLine[] {
  const lines: TextLine[] = [];
  let current: TextLine = { runs: [], width: 0 };
  /** Appends a measured text fragment while merging adjacent fragments with identical formatting. */
  const append = (run: RichRun): void => {
    const previous = current.runs.at(-1);
    if (previous && previous.bold === run.bold && previous.italic === run.italic && previous.script === run.script) previous.text += run.text;
    else current.runs.push({ ...run });
    current.width += measure(run, style);
  };
  /** Publishes a line, including explicit blank lines. */
  const flush = (): void => { lines.push(current); current = { runs: [], width: 0 }; };
  for (const run of runs) {
    for (const token of run.text.split(/(\n|[ \t]+|[^\u0000-\u02ff])/).filter(Boolean)) {
      if (token === "\n") { flush(); continue; }
      const fragment = { ...run, text: token };
      if (current.width > 0 && current.width + measure(fragment, style) > width && !/^\s+$/.test(token)) flush();
      // A long word must not overflow narrow captions even when it has no whitespace.
      if (measure(fragment, style) > width && !/^\s+$/.test(token)) {
        for (const character of token) {
          const part = { ...run, text: character };
          if (current.width > 0 && current.width + measure(part, style) > width) flush();
          append(part);
        }
      } else if (current.width > 0 || !/^\s+$/.test(token)) append(fragment);
    }
  }
  if (current.runs.length || !lines.length && runs.some((run) => run.text.length)) flush();
  return lines;
}

/** Recomputes caption geometry without changing any manually placed picture coordinates. */
export function reflowFigure(figure: FigureDocument, measure: MeasureText = estimateText): void {
  for (const element of figure.elements) {
    element.lines = wrapText(element.kind === "panel" ? captionRuns(element) : element.runs, element.width, element.style, measure);
  }
  if (figure.autoHeight && figure.elements.length) {
    figure.height = Math.max(30, ...figure.elements.map((element) => element.y + elementHeight(element))) + figure.layout.padding;
  }
}

/** Includes attached text when aligning panels, finding overlaps or fitting the canvas. */
export function elementHeight(element: FigureElement): number {
  const textHeight = (element.lines?.length ?? 0) * element.style.size * 1.25;
  return element.kind === "panel" ? element.height + (textHeight ? element.gap + textHeight : 0) : Math.max(element.style.size * 1.25, textHeight);
}

/** Arranges panels by explicit rows or column count, with optional per-panel width weights. */
export function arrangePanels(figure: FigureDocument, measure: MeasureText = estimateText): void {
  const panels = figure.elements.filter((element): element is Panel => element.kind === "panel");
  const { padding, gap, rowGap, columns, rows, weights } = figure.layout;
  let index = 0, rowIndex = 0, y = padding;
  while (index < panels.length) {
    const count = Math.max(1, Math.min(panels.length - index, rows[rowIndex] || columns));
    const row = panels.slice(index, index + count);
    const factors = row.map((_, offset) => Math.max(.05, weights[index + offset] || 1));
    const available = Math.max(count, figure.width - 2 * padding - gap * (count - 1));
    const total = factors.reduce((a, b) => a + b, 0);
    const rowHeight = Math.max(...row.map((panel, offset) => available * factors[offset] / total / visibleRatio(panel)));
    let x = padding;
    for (let offset = 0; offset < row.length; offset++) {
      Object.assign(row[offset], { x, y, width: available * factors[offset] / total, height: rowHeight });
      row[offset].lines = wrapText(captionRuns(row[offset]), row[offset].width, row[offset].style, measure);
      x += row[offset].width + gap;
    }
    y += Math.max(...row.map(elementHeight)) + rowGap;
    index += count; rowIndex++;
  }
  reflowFigure(figure, measure);
}

/** Changes physical width while preserving manual positions and physical type sizes. */
export function resizeFigure(figure: FigureDocument, width: number, measure: MeasureText = estimateText): void {
  const scale = width / figure.width;
  for (const element of figure.elements) {
    element.x *= scale; element.y *= scale; element.width *= scale;
    if (element.kind === "panel") element.height *= scale;
  }
  if (!figure.autoHeight) figure.height *= scale;
  figure.width = width;
  reflowFigure(figure, measure);
}

/** Renumbers only when explicitly requested, leaving normal dragging semantically stable. */
export function renumberPanels(figure: FigureDocument): void {
  figure.elements.filter((element): element is Panel => element.kind === "panel")
    .sort((a, b) => Math.abs(a.y - b.y) < 4 ? a.x - b.x : a.y - b.y)
    .forEach((panel, index) => { panel.label = panelLetter(index); });
}

/** Aligns or distributes selected elements in physical coordinates, including attached captions. */
export function alignElements(elements: FigureElement[], mode: string): void {
  if (elements.length < 2) return;
  const left = Math.min(...elements.map((item) => item.x)), right = Math.max(...elements.map((item) => item.x + item.width));
  const top = Math.min(...elements.map((item) => item.y)), bottom = Math.max(...elements.map((item) => item.y + elementHeight(item)));
  if (mode === "horizontal" || mode === "vertical") {
    const horizontal = mode === "horizontal";
    const sorted = [...elements].sort((a, b) => horizontal ? a.x - b.x : a.y - b.y);
    const span = horizontal ? right - left : bottom - top;
    const occupied = sorted.reduce((sum, item) => sum + (horizontal ? item.width : elementHeight(item)), 0);
    const gap = (span - occupied) / (sorted.length - 1);
    let cursor = horizontal ? left : top;
    for (const item of sorted) {
      if (horizontal) item.x = cursor; else item.y = cursor;
      cursor += (horizontal ? item.width : elementHeight(item)) + gap;
    }
    return;
  }
  for (const item of elements) {
    if (mode === "left") item.x = left;
    if (mode === "center") item.x = (left + right - item.width) / 2;
    if (mode === "right") item.x = right - item.width;
    if (mode === "top") item.y = top;
    if (mode === "middle") item.y = (top + bottom - elementHeight(item)) / 2;
    if (mode === "bottom") item.y = bottom - elementHeight(item);
  }
}

/** Rejects malformed editable metadata before it can overwrite an existing document. */
export function validateFigure(value: unknown): asserts value is FigureDocument {
  const figure = value as FigureDocument;
  if (figure?.format !== "papper-subfigure" || figure.version !== 1 || !Array.isArray(figure.elements)) throw new Error("Unsupported combination figure format");
  /** Validates physical sizes entered through numeric controls. */
  const positive = (number: number): boolean => Number.isFinite(number) && number > 0;
  if (!positive(figure.width) || !positive(figure.height)) throw new Error("Figure dimensions must be positive");
  if (!positive(figure.font?.size) || !Number.isInteger(figure.layout?.columns) || figure.layout.columns < 1
    || figure.layout.rows.some((number) => !Number.isInteger(number) || number < 1)
    || figure.layout.weights.some((number) => !positive(number))
    || [figure.layout.gap, figure.layout.rowGap, figure.layout.padding].some((number) => !Number.isFinite(number) || number < 0)) throw new Error("Invalid layout settings");
  const ids = new Set<string>();
  for (const element of figure.elements) {
    if (!element.id || ids.has(element.id) || !["panel", "text"].includes(element.kind)) throw new Error("Invalid figure element");
    ids.add(element.id);
    if (![element.x, element.y].every(Number.isFinite) || !positive(element.width) || !positive(element.style?.size)) throw new Error("Invalid element dimensions");
    if (element.kind === "panel" && (!positive(element.height) || !positive(element.ratio) || !element.source
      || Object.values(element.crop).some((number) => !Number.isFinite(number) || number < 0)
      || element.crop.left + element.crop.right >= 100 || element.crop.top + element.crop.bottom >= 100)) throw new Error("Invalid image crop or size");
  }
}

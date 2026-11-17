/**
 * Runs the combination figure editor inside a VS Code Webview.
 *
 * Coordinates and typography stay in physical points; screen zoom and the A4
 * reference affect only the view. User gestures commit through the host so
 * VS Code can manage native undo, dirty state, Save As and draft recovery.
 */
import { A4, PT_PER_MM, createFigure, reflowFigure, resizeFigure, arrangePanels, alignElements,
  elementHeight, visibleRatio, renumberPanels, newElementId, validateFigure,
  type FigureDocument, type FigureElement, type RichRun, type TextStyle, type Panel } from "./model";
import { serializeFigure, renderElement, escapeXml, decimal } from "./svg";
import type { EditorMessage, HostMessage } from "./protocol";
import { panelRows, findDockTarget, dockPanels, resizeRowPair, snapRowDivider, snapSelection,
  type DockTarget, type DividerSnap, type AlignmentGuide } from "./layout";
import { BUTTON_HELP, FORMAT_HELP } from "./help";

declare function acquireVsCodeApi(): { postMessage(message: EditorMessage): void; getState(): unknown; setState(value: unknown): void };
const vscode = acquireVsCodeApi();
const localization = JSON.parse(document.getElementById("localization").textContent) as { messages: Record<string, string | { message: string }> };
/** Translates complete UI messages with the existing extension bundle. */
function t(message: string, ...args: Array<string | number>): string {
  const value = localization.messages[message];
  return (typeof value === "string" ? value : value?.message ?? message).replace(/\{(\d+)\}/g, (match, index: string) => String(args[Number(index)] ?? match));
}
/** Finds a required editor shell element. */
function node<T extends HTMLElement = HTMLElement>(id: string): T { return document.getElementById(id) as T; }
const board = document.getElementById("board") as unknown as SVGSVGElement;
const viewport = node("viewport");
const measure = document.createElement("canvas").getContext("2d");
let figure = createFigure(), revision = -1, sources: Record<string, string> = {};
let lastValidFigure = structuredClone(figure);
let selected = new Set<string>(), zoom = .9, a4 = true, unit = "mm", copied: FigureElement[] = [];
let pointer: { start: DOMPoint; original: FigureDocument; mode: "move" | "resize" | "dock" | "divider"; id: string; moved: boolean;
  ids: Set<string>; right?: string; target?: DockTarget; snap?: DividerSnap; guides?: AlignmentGuide[] } | undefined;
let draggedId: string | undefined, editingText = false, textTimer: ReturnType<typeof setTimeout> | undefined;
let dockPreview: FigureDocument | undefined;
let dragGhost: SVGGElement | undefined, previewKey: string | undefined;
let moveFrame = 0, pendingMove: PointerEvent | undefined;

/** Treats older SVGs without a mode as free layouts, preserving their manually authored geometry. */
function rowsMode(): boolean { return figure.layout.mode === "rows"; }

/** Measures selected-font glyph advances in the same physical coordinates used by the SVG. */
function measureRun(run: RichRun, style: TextStyle): number {
  measure.font = `${run.italic ? "italic " : ""}${run.bold ? "bold " : ""}${style.size * (run.script ? .7 : 1)}px "${style.family.replace(/"/g, "")}"`;
  return measure.measureText(run.text).width;
}

/** Resolves the full-quality source supplied by the host, without modifying saved link paths. */
function imageSource(source: string): string {
  return sources[source] ?? (source.startsWith("data:") ? source : "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Crect width='100' height='100' fill='%23ddd'/%3E%3C/svg%3E");
}

/** Shows errors in the editor without discarding the current layout. */
function notice(message = ""): void { node("notice").textContent = message; }

/** Returns selected model objects in source order. */
function selection(): FigureElement[] { return figure.elements.filter((element) => selected.has(element.id)); }

/** Updates physical text wrapping and sends one undoable operation to the host. */
function commit(label: string, renderAll = true): void {
  try {
    validateFigure(figure); reflowFigure(figure, measureRun);
    if (JSON.stringify(figure) === JSON.stringify(lastValidFigure)) { if (renderAll) render(); return; }
    lastValidFigure = structuredClone(figure);
    vscode.postMessage({ type: "change", figure: structuredClone(figure), label: t(label), revision });
    revision++;
    notice();
    if (renderAll) render(); else renderCanvas();
  } catch (error) {
    figure = structuredClone(lastValidFigure);
    render();
    notice(String(error));
  }
}

/** Returns the unit conversion for inspector values while keeping the model in points. */
function unitPoints(): number { return unit === "in" ? 72 : PT_PER_MM; }

/** Updates the canvas, A4 paper boundary, figure boundary and non-exported selection overlays. */
function renderCanvas(): void {
  previewKey = undefined;
  const marginX = a4 ? Math.max(0, (A4.width - figure.width) / 2) : 0;
  const marginY = a4 ? 22 * PT_PER_MM : 0;
  const width = a4 ? Math.max(A4.width, figure.width + 16) : figure.width;
  const height = a4 ? Math.max(A4.height, figure.height + marginY + 16) : figure.height;
  board.setAttribute("viewBox", `0 0 ${width} ${height}`);
  board.style.width = `${width * 96 / 72 * zoom}px`; board.style.height = `${height * 96 / 72 * zoom}px`;
  board.innerHTML = (a4 ? `<rect width="${A4.width}" height="${A4.height}" fill="white"/><text x="12" y="18" fill="#888" font-family="Arial" font-size="8">A4 · 210 × 297 mm</text>` : "")
    + `<g id="figure-group" transform="translate(${marginX} ${marginY})">`
    + `<rect width="${figure.width}" height="${figure.height}" fill="${figure.background === "white" ? "white" : "#f2f2f2"}" stroke="#999" stroke-dasharray="4 3" stroke-width=".6" data-figure-background="true"/>`
    + `<g id="artwork">${figure.elements.map((element) => renderElement(element, imageSource)).join("")}</g>`
    + `<g id="overlays">${canvasOverlays(figure)}</g>`
    + `<g id="snap-overlays">${snapGuides(figure)}</g>`
    + (!figure.elements.length ? `<text class="empty" x="${figure.width / 2}" y="${figure.height / 2}" text-anchor="middle">${escapeXml(t("Drop images here or choose Add images"))}</text>` : "") + "</g>";
  const w = decimal(figure.width / PT_PER_MM), h = decimal(figure.height / PT_PER_MM);
  node("status").textContent = t("{0} × {1} mm · {2} elements", w, h, figure.elements.length);
  node("paper-info").textContent = t("{0} mm wide · {1}% of A4 width", Number((figure.width / PT_PER_MM).toFixed(1)), Number((figure.width / A4.width * 100).toFixed(1)));
}

/** Builds inexpensive selection and docking guides separately from source image nodes. */
function canvasOverlays(display: FigureDocument): string {
  return display.elements.filter((element) => selected.has(element.id)).map((element) => `<g data-selection-id="${escapeXml(element.id)}"><rect class="selection" x="${element.x}" y="${element.y}" width="${element.width}" height="${elementHeight(element)}"/>`
    + (rowsMode() && element.kind === "panel" ? "" : `<rect class="resize" data-resize="${escapeXml(element.id)}" x="${element.x + element.width - 3}" y="${element.y + (element.kind === "panel" ? element.height : elementHeight(element)) - 3}" width="6" height="6"/>`) + "</g>").join("")
    + (rowsMode() ? panelRows(display).flatMap((row) => row.slice(0, -1).map((left, index) => {
      const right = row[index + 1], x = (left.x + left.width + right.x) / 2, hitWidth = Math.max(6 / zoom, figure.layout.gap);
      return `<line class="divider-line" x1="${x}" x2="${x}" y1="${left.y}" y2="${left.y + left.height}"/><rect class="divider" data-divider="${escapeXml(left.id)}" data-right="${escapeXml(right.id)}" x="${x - hitWidth / 2}" y="${left.y}" width="${hitWidth}" height="${left.height}"><title>${escapeXml(t("Drag to resize adjacent panels. Snap to common divisions, equal widths or heights, and other rows. Hold Alt to bypass snapping."))}</title></rect>`;
    })).join("") : "")
    + (dockPreview ? display.elements.filter((element) => pointer?.ids.has(element.id) || element.id === draggedId).map((element) => `<rect class="dock-preview" x="${element.x}" y="${element.y}" width="${element.width}" height="${elementHeight(element)}"/>`).join("") : "");
}

/** Draws temporary PPT-style guides for the coordinates actually captured by snapping. */
function snapGuides(display: FigureDocument): string {
  const divider = pointer?.snap ? `<g class="snap-guide"><line x1="${pointer.snap.x}" x2="${pointer.snap.x}" y1="0" y2="${display.height}"/><text x="${pointer.snap.x + 4}" y="10">${escapeXml(dividerSnapLabel(pointer.snap))}</text></g>` : "";
  return divider + (pointer?.guides ?? []).map((guide) => {
    const label = t({ "canvas-edge": "Canvas edge", "canvas-center": "Canvas centre",
      "element-edge": "Element edge", "element-center": "Element centre" }[guide.kind]);
    return `<g class="snap-guide" data-axis="${guide.axis}">` + (guide.axis === "x"
      ? `<line x1="${guide.position}" x2="${guide.position}" y1="0" y2="${display.height}"/><text x="${guide.position + 4}" y="10">${escapeXml(label)}</text>`
      : `<line x1="0" x2="${display.width}" y1="${guide.position}" y2="${guide.position}"/><text x="4" y="${guide.position - 4}">${escapeXml(label)}</text>`) + "</g>";
  }).join("");
}

/** Names the captured divider guide without adding editor-only annotations to exported figures. */
function dividerSnapLabel(snap: DividerSnap): string {
  return snap.kind === "fraction" ? t("{0}% width", Math.round(snap.fraction * 1000) / 10)
    : t({ "equal-width": "Equal panel widths", "equal-height": "Equal image heights", aligned: "Aligned with another row" }[snap.kind]);
}

/** Patches SVG geometry and text while retaining decoded images throughout a drag. */
function patchSvg(current: Element, next: Element): void {
  for (const attribute of Array.from(current.attributes)) {
    if (current.localName === "image" && attribute.localName === "href") continue;
    if (!next.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  }
  for (const attribute of Array.from(next.attributes)) {
    if (current.localName === "image" && attribute.localName === "href") continue;
    if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
  }
  for (let index = 0; index < next.childNodes.length; index++) {
    const child = current.childNodes[index], replacement = next.childNodes[index];
    if (!child) current.appendChild(replacement.cloneNode(true));
    else if (child.nodeType !== replacement.nodeType || child.nodeName !== replacement.nodeName) current.replaceChild(replacement.cloneNode(true), child);
    else if (child instanceof Element && replacement instanceof Element) patchSvg(child, replacement);
    else if (child.nodeValue !== replacement.nodeValue) child.nodeValue = replacement.nodeValue;
  }
  while (current.childNodes.length > next.childNodes.length) current.lastChild.remove();
}

/** Updates a live layout without rebuilding images or changing the drag coordinate system. */
function patchCanvas(display: FigureDocument): void {
  const artwork = document.getElementById("artwork");
  const existing = new Map(Array.from(artwork.children).map((element) => [element.getAttribute("data-element-id"), element]));
  const template = document.createElementNS("http://www.w3.org/2000/svg", "g");
  for (const element of display.elements) {
    // Source URLs are omitted from patching so large data URIs are never reparsed per frame.
    template.innerHTML = renderElement(element, () => "");
    patchSvg(existing.get(element.id), template.firstElementChild);
  }
  document.getElementById("overlays").innerHTML = canvasOverlays(display);
  document.getElementById("snap-overlays").innerHTML = snapGuides(display);
}

/** Synchronizes input values without moving the caret in the field currently being edited. */
function setValue(id: string, value: string | number | boolean): void {
  const input = node<HTMLInputElement>(id);
  if (document.activeElement === input) return;
  if (typeof value === "boolean") input.checked = value;
  else input.value = String(value);
}

/** Renders the element list and figure inspector after a committed edit or native undo. */
function render(): void {
  renderCanvas();
  node("elements").innerHTML = figure.elements.map((element) => `<button class="item${selected.has(element.id) ? " selected" : ""}" data-select="${escapeXml(element.id)}" draggable="true" title="${escapeXml(t("Select this element. Shift-click to add it to the selection; drag it onto the canvas to arrange it."))}"><span class="badge">${element.kind === "panel" ? escapeXml(element.label ? `(${element.label})` : "▧") : "T"}</span><span class="name">${escapeXml(element.kind === "panel" ? element.name : element.runs.map((run) => run.text).join(""))}</span></button>`).join("");
  setValue("layout-mode", figure.layout.mode ?? "free");
  document.querySelector<HTMLButtonElement>("[data-action=arrange]").disabled = rowsMode();
  node("layout-help").textContent = t(rowsMode()
    ? "Drag to a panel's left or right to share its row. Drop above or below a row to create a new row. Drag a divider to adjust widths."
    : "Drag to move freely; use corner handles to resize. Switch to Panel rows to organise panels by docking.");
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-action^='align:']")) {
    button.disabled = selection().length < 2 || rowsMode() && selection().some((element) => element.kind === "panel");
  }
  setValue("figure-width", Number((figure.width / unitPoints()).toFixed(2)));
  setValue("figure-height", Number((figure.height / unitPoints()).toFixed(2)));
  setValue("auto-height", figure.autoHeight); setValue("transparent", figure.background === "transparent"); setValue("embedded", figure.embedded);
  setValue("columns", figure.layout.columns); setValue("gap", figure.layout.gap); setValue("row-gap", figure.layout.rowGap); setValue("padding", figure.layout.padding);
  setValue("rows", figure.layout.rows.join(", ")); setValue("weights", figure.layout.weights.join(", "));
  setValue("default-family", figure.font.family); setValue("default-size", figure.font.size);
  if (!editingText) renderInspector();
}

/** Creates a safely escaped inspector field for one physical element property. */
function field(label: string, key: string, value: string | number, type = "number"): string {
  const locked = rowsMode() && selection()[0]?.kind === "panel" && ["x", "y", "width", "height"].includes(key);
  return `<label class="field"><span>${escapeXml(t(label))}</span><input data-property="${key}" type="${type}" value="${escapeXml(String(value))}"${type === "number" ? ' step=".5"' : ""}${locked ? ` disabled title="${escapeXml(t("Panel rows controls this geometry. Drag row dividers, or switch to Free positioning for individual sizes."))}"` : ""}></label>`;
}

/** Converts stored rich runs into a controlled editable fragment, never arbitrary SVG markup. */
function richHtml(runs: RichRun[]): string {
  return runs.map((run) => {
    let content = escapeXml(run.text).replace(/\n/g, "<br>");
    if (run.bold) content = `<b>${content}</b>`;
    if (run.italic) content = `<i>${content}</i>`;
    if (run.script) content = `<${run.script === "super" ? "sup" : "sub"}>${content}</${run.script === "super" ? "sup" : "sub"}>`;
    return content;
  }).join("");
}

/** Renders per-element geometry, crop and a compact rich-text editor. */
function renderInspector(): void {
  const elements = selection(), element = elements[0];
  if (elements.length !== 1) {
    node("inspector").innerHTML = `<p class="muted">${escapeXml(elements.length ? t("{0} elements selected", elements.length) : t("Select an image or text to edit its properties"))}</p>`; return;
  }
  const panel = element.kind === "panel" ? element : undefined;
  node("inspector").innerHTML = `<h2>${escapeXml(t(panel ? "Subfigure" : "Shared text"))}</h2><div class="pair">`
    + field("X (pt)", "x", decimal(element.x)) + field("Y (pt)", "y", decimal(element.y)) + field("Width (pt)", "width", decimal(element.width))
    + (panel ? field("Height (pt)", "height", decimal(panel.height)) : "") + "</div>"
    + (panel ? field("Panel label", "label", panel.label, "text") + `<label class="field"><span>${escapeXml(t("Label position"))}</span><select data-property="labelPosition">${["below", "top-left", "top-right", "none"].map((value) => `<option value="${value}"${value === panel.labelPosition ? " selected" : ""}>${escapeXml(t({ below: "Below image", "top-left": "Top left", "top-right": "Top right", none: "Hidden" }[value]))}</option>`).join("")}</select></label>`
      + field("Caption gap (pt)", "gap", panel.gap) : "")
    + field("Font family", "family", element.style.family, "text") + `<div class="pair">` + field("Font size (pt)", "size", element.style.size) + field("Text color", "color", element.style.color, "color") + "</div>"
    + `<label class="field"><span>${escapeXml(t("Text alignment"))}</span><select data-property="align">${["left", "center", "right"].map((value) => `<option${element.style.align === value ? " selected" : ""}>${value}</option>`).join("")}</select></label>`
    + `<h3>${escapeXml(t(panel ? "Subcaption" : "Text"))}</h3><div class="tools">${[["bold", "B"], ["italic", "I"], ["superscript", "x²"], ["subscript", "x₂"], ["removeFormat", "Clear formatting"]].map(([command, label]) => `<button data-format="${command}" title="${escapeXml(t(FORMAT_HELP[command]))}">${escapeXml(t(label))}</button>`).join("")}</div>`
    + `<div id="rich-text" class="rich" contenteditable="true" role="textbox" aria-label="${escapeXml(t(panel ? "Subcaption" : "Text"))}">${richHtml(panel ? panel.caption : (element as Extract<FigureElement, { kind: "text" }>).runs)}</div>`
    + (panel ? `<h3>${escapeXml(t("Crop (%)"))}</h3><div class="pair">${(["left", "top", "right", "bottom"] as const).map((edge) => field({ left: "Left", top: "Top", right: "Right", bottom: "Bottom" }[edge], `crop.${edge}`, panel.crop[edge])).join("")}</div><p class="muted">${escapeXml(t("Cropping changes only the visible area. The source image stays intact."))}</p><button data-action="openSource" title="${escapeXml(t(BUTTON_HELP.openSource))}">${escapeXml(t("Open source image"))}</button>` : "");
}

/** Extracts supported rich text from a contenteditable tree, preserving explicit paragraph breaks. */
function readRichText(root: HTMLElement): RichRun[] {
  const runs: RichRun[] = [];
  /** Visits only supported inline styles; pasted markup cannot introduce executable saved content. */
  const visit = (item: Node, style: Omit<RichRun, "text">): void => {
    if (item.nodeType === Node.TEXT_NODE) { if (item.textContent) runs.push({ ...style, text: item.textContent }); return; }
    if (!(item instanceof HTMLElement)) return;
    if (item.tagName === "BR") { runs.push({ text: "\n" }); return; }
    if (["DIV", "P"].includes(item.tagName) && runs.length && !runs.at(-1).text.endsWith("\n")) runs.push({ text: "\n" });
    const next = { ...style };
    if (["B", "STRONG"].includes(item.tagName) || Number(item.style.fontWeight) >= 600 || item.style.fontWeight === "bold") next.bold = true;
    if (["I", "EM"].includes(item.tagName) || item.style.fontStyle === "italic") next.italic = true;
    if (item.tagName === "SUP") next.script = "super";
    if (item.tagName === "SUB") next.script = "sub";
    item.childNodes.forEach((child) => visit(child, next));
  };
  root.childNodes.forEach((child) => visit(child, {}));
  return runs;
}

/** Commits the visible rich-text buffer before save, selection changes or native undo. */
function flushText(): void {
  if (textTimer) { clearTimeout(textTimer); textTimer = undefined; }
  const editor = node("rich-text"), element = selection()[0];
  if (!editor || !element) return;
  const runs = readRichText(editor);
  const current = element.kind === "panel" ? element.caption : element.runs;
  if (JSON.stringify(runs) === JSON.stringify(current)) return;
  if (element.kind === "panel") element.caption = runs; else element.runs = runs;
  if (rowsMode() && element.kind === "panel") arrangePanels(figure, measureRun);
  commit("Edit text", false);
}

/** Selects an element without renumbering it or altering its source order. */
function select(id?: string, additive = false): void {
  flushText(); editingText = false;
  if (!additive) selected.clear();
  if (id) { if (additive && selected.has(id)) selected.delete(id); else selected.add(id); }
  render();
}

/** Converts screen coordinates through zoom and the A4 reference into figure points. */
function figurePoint(event: { clientX: number; clientY: number }): DOMPoint {
  const group = document.getElementById("figure-group") as unknown as SVGGraphicsElement;
  return new DOMPoint(event.clientX, event.clientY).matrixTransform(group.getScreenCTM().inverse());
}

/** Shows the full resulting arrangement while keeping the committed figure and native history untouched. */
function previewDock(original: FigureDocument, ids: Set<string>, target?: DockTarget): void {
  const key = target ? `${target.kind}:${target.anchor}:${target.side}` : "";
  if (key === previewKey) return;
  previewKey = key;
  dockPreview = target ? structuredClone(original) : undefined;
  if (dockPreview) dockPanels(dockPreview, ids, target, measureRun);
  node("drop-hint").textContent = target ? t(target.kind === "beside" ? "Release to insert into this row with equal image heights." : "Release to create a new row above or below this row.") : "";
  patchCanvas(dockPreview ?? original);
  if (pointer?.mode === "dock") for (const element of document.querySelectorAll<SVGElement>("#artwork > [data-element-id]")) {
    if (ids.has(element.dataset.elementId)) element.style.opacity = ".25";
  }
}

/** Creates one follow-pointer copy, including the attached labels and captions. */
function startDragGhost(): void {
  dragGhost = document.createElementNS("http://www.w3.org/2000/svg", "g");
  dragGhost.classList.add("drag-ghost");
  for (const element of document.querySelectorAll<SVGElement>("#artwork > [data-element-id]")) {
    if (!pointer.ids.has(element.dataset.elementId)) continue;
    const copy = element.cloneNode(true) as SVGElement;
    copy.removeAttribute("data-element-id"); dragGhost.appendChild(copy);
  }
  document.getElementById("figure-group").appendChild(dragGhost);
}

/** Coalesces mouse events to the display refresh rate, using the most recent position. */
function queuePointerMove(event: PointerEvent): void {
  if (!pointer) return;
  pendingMove = event;
  if (!moveFrame) moveFrame = requestAnimationFrame(flushPointerMove);
}

/** Flushes the latest position on release so the final movement cannot be lost. */
function flushPointerMove(): void {
  if (moveFrame) cancelAnimationFrame(moveFrame);
  moveFrame = 0;
  const event = pendingMove; pendingMove = undefined;
  if (event) pointerMove(event);
}

/** Removes transient drag state on release, cancellation and Escape. */
function clearDrag(): void {
  if (moveFrame) cancelAnimationFrame(moveFrame);
  moveFrame = 0; pendingMove = undefined;
  dragGhost?.remove(); dragGhost = undefined; previewKey = undefined; dockPreview = undefined;
  pointer = undefined; board.classList.remove("dragging"); node("drop-hint").textContent = "";
}

/** Restores the pre-drag figure when the pointer is cancelled or Escape is pressed. */
function cancelDrag(): void {
  if (!pointer) return;
  figure = pointer.original; clearDrag(); render();
}

/** Moves all selected elements or resizes one panel while leaving type size unchanged. */
function pointerMove(event: PointerEvent): void {
  if (!pointer) return;
  const point = figurePoint(event), dx = point.x - pointer.start.x, dy = point.y - pointer.start.y;
  const threshold = pointer.mode === "dock" ? 4 / (zoom * 96 / 72) : .3;
  if (Math.hypot(dx, dy) < threshold && !pointer.moved) return;
  if (!pointer.moved) {
    board.classList.add("dragging");
    if (pointer.mode === "dock") startDragGhost();
  }
  pointer.moved = true;
  if (pointer.mode === "dock") {
    dragGhost.setAttribute("transform", `translate(${dx} ${dy})`);
    pointer.target = findDockTarget(pointer.original, pointer.ids, point.x, point.y);
    previewDock(pointer.original, pointer.ids, pointer.target);
    return;
  }
  if (pointer.mode === "divider") {
    figure = structuredClone(pointer.original);
    const adjustment = !event.altKey && node<HTMLInputElement>("snap").checked
      ? snapRowDivider(pointer.original, pointer.id, pointer.right, dx, 6 / (zoom * 96 / 72), pointer.snap?.x) : { delta: dx };
    pointer.snap = "snap" in adjustment ? adjustment.snap : undefined;
    resizeRowPair(figure, pointer.id, pointer.right, adjustment.delta, measureRun); patchCanvas(figure); return;
  }
  const elements = pointer.original.elements.filter((item) => pointer.ids.has(item.id));
  const active = elements.find((item) => item.id === pointer.id);
  if (!active) return;
  if (pointer.mode === "resize") {
    const resized = figure.elements.find((item) => item.id === active.id);
    resized.width = Math.max(12, active.width + dx);
    if (resized.kind === "panel" && active.kind === "panel") resized.height = Math.max(12, active.height + dy);
    reflowFigure(figure, measureRun); patchCanvas(figure);
  } else {
    const adjustment = snapSelection(pointer.original, pointer.ids, dx, dy,
      !event.altKey && node<HTMLInputElement>("snap").checked ? 6 / (zoom * 96 / 72) : 0, pointer.guides);
    pointer.guides = adjustment.guides;
    const moveX = adjustment.dx, moveY = adjustment.dy;
    for (const element of elements) {
      const moved = figure.elements.find((item) => item.id === element.id);
      moved.x = element.x + moveX; moved.y = element.y + moveY;
    }
    for (const element of document.querySelectorAll<SVGElement>("#artwork > [data-element-id], [data-selection-id]")) {
      if (pointer.ids.has(element.dataset.elementId ?? element.dataset.selectionId)) element.setAttribute("transform", `translate(${moveX} ${moveY})`);
    }
    document.getElementById("snap-overlays").innerHTML = snapGuides(figure);
  }
}

/** Commits a complete drag as one native history operation. */
function pointerEnd(event: PointerEvent): void {
  if (!pointer) return;
  pendingMove = event; flushPointerMove();
  const moved = pointer.moved, mode = pointer.mode;
  if (mode === "dock") figure = dockPreview ?? pointer.original;
  clearDrag();
  if (moved) commit(mode === "dock" ? "Reorganise panel rows" : mode === "divider" ? "Resize row panels" : "Move or resize elements");
  else renderCanvas();
}

board.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  const target = event.target as Element, resize = target.closest("[data-resize]")?.getAttribute("data-resize");
  const divider = target.closest<SVGElement>("[data-divider]");
  const id = divider?.dataset.divider ?? resize ?? target.closest("[data-element-id]")?.getAttribute("data-element-id");
  if (!id) { select(); return; }
  if (!selected.has(id) || event.shiftKey) select(id, event.shiftKey);
  if (!selected.has(id)) return;
  event.preventDefault(); board.focus(); board.setPointerCapture(event.pointerId);
  const mode = divider ? "divider" : resize ? "resize" : rowsMode() && selection().every((item) => item.kind === "panel") ? "dock" : "move";
  pointer = { start: figurePoint(event), original: structuredClone(figure), mode, id, moved: false, ids: new Set(selected), right: divider?.dataset.right };
});
board.addEventListener("pointermove", queuePointerMove);
board.addEventListener("pointerup", pointerEnd);
board.addEventListener("pointercancel", cancelDrag);

/** Executes a toolbar operation without hiding the current physical layout. */
function action(name: string): void {
  flushText(); editingText = false;
  // Moving focus off a toolbar button prevents browser text history from intercepting figure undo.
  if (name === "undo" || name === "redo") board.focus();
  if (["save", "saveAs", "undo", "redo", "addImages", "refresh"].includes(name)) { vscode.postMessage({ type: name } as EditorMessage); return; }
  if (name === "fit") { fitCanvas(); return; }
  if (name === "export") {
    const value = Number(node<HTMLInputElement>("dpi").value);
    if (Number.isFinite(value) && value > 0) vscode.postMessage({ type: "exportPng", dpi: value });
    return;
  }
  if (name === "openSource") { if (selection()[0]) vscode.postMessage({ type: "openSource", id: selection()[0].id }); return; }
  if (name.startsWith("preset:")) {
    const counts = name.slice(7).split(",").map(Number);
    figure.layout.mode = "rows"; figure.layout.rows = counts.length > 1 ? counts : [];
    figure.layout.columns = counts.at(-1); figure.layout.weights = []; arrangePanels(figure, measureRun);
  }
  else if (name === "arrange") { if (rowsMode()) return; try { validateFigure(figure); arrangePanels(figure, measureRun); } catch (error) { notice(String(error)); return; } }
  else if (name === "renumber") renumberPanels(figure);
  else if (name === "addText") {
    const item: FigureElement = { kind: "text", id: newElementId(), x: 12, y: 12, width: Math.min(160, figure.width - 24),
      runs: [{ text: t("Shared text") }], style: { ...figure.font } };
    figure.elements.push(item); selected = new Set([item.id]);
  } else if (name === "delete") {
    const rows = panelRows(figure).map((row) => row.filter((panel) => !selected.has(panel.id))).filter((row) => row.length);
    const weights = new Map(panelRows(figure).flat().map((panel, index) => [panel.id, figure.layout.weights[index] || visibleRatio(panel)]));
    figure.elements = figure.elements.filter((item) => !selected.has(item.id)); selected.clear();
    if (rowsMode()) { figure.layout.rows = rows.map((row) => row.length); figure.layout.weights = rows.flat().map((panel) => weights.get(panel.id)); arrangePanels(figure, measureRun); }
  }
  else if (name === "duplicate") {
    const copies = structuredClone(selection());
    for (const item of copies) { item.id = newElementId(); item.x += 10; item.y += 10; }
    figure.elements.push(...copies); selected = new Set(copies.map((item) => item.id));
    if (rowsMode()) arrangePanels(figure, measureRun);
  } else if (name === "applyFont") { for (const item of figure.elements) item.style = { ...figure.font }; }
  else if (name.startsWith("align:")) alignElements(selection(), name.split(":")[1]);
  else return;
  if (rowsMode() && name === "applyFont") arrangePanels(figure, measureRun);
  commit("Edit combination figure");
}

document.addEventListener("click", (event) => {
  const target = event.target as Element;
  const selectedItem = target.closest<HTMLElement>("[data-select]");
  if (selectedItem) { select(selectedItem.dataset.select, (event as MouseEvent).shiftKey); return; }
  const button = target.closest<HTMLElement>("[data-action]");
  if (button) action(button.dataset.action);
});
document.addEventListener("mousedown", (event) => {
  // Keep the figure canvas as the undo target, and retain rich-text selection for format buttons.
  const history = (event.target as Element).closest<HTMLElement>("[data-action=undo],[data-action=redo]");
  if (history) { event.preventDefault(); return; }
  const button = (event.target as Element).closest<HTMLElement>("[data-format]");
  if (!button) return;
  event.preventDefault();
  node("rich-text").focus(); document.execCommand(button.dataset.format); flushText();
});
document.addEventListener("focusin", (event) => { if ((event.target as Element).closest("#rich-text")) editingText = true; });
document.addEventListener("input", (event) => {
  if ((event.target as Element).closest("#rich-text")) {
    if (textTimer) clearTimeout(textTimer);
    textTimer = setTimeout(flushText, 350);
  }
});
document.addEventListener("paste", (event) => {
  if (!(event.target as Element).closest("#rich-text")) return;
  event.preventDefault(); document.execCommand("insertText", false, event.clipboardData.getData("text/plain"));
});

/** Applies a physical geometry or typography change from the property inspector. */
function propertyChange(input: HTMLInputElement | HTMLSelectElement): void {
  const item = selection()[0];
  if (!item) return;
  const key = input.dataset.property, value = input.type === "number" ? Number(input.value) : input.value;
  if (["family", "size", "color", "align"].includes(key)) (item.style as unknown as Record<string, unknown>)[key] = value;
  else if (key.startsWith("crop.") && item.kind === "panel") item.crop[key.split(".")[1] as keyof Panel["crop"]] = Number(value);
  else (item as unknown as Record<string, unknown>)[key] = value;
  if (rowsMode() && item.kind === "panel") arrangePanels(figure, measureRun);
  commit("Change element properties");
}

document.addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement | HTMLSelectElement;
  flushText(); editingText = false;
  if (input.dataset.property) { propertyChange(input); return; }
  const id = input.id;
  if (id === "unit") { unit = input.value; render(); return; }
  if (id === "a4") { a4 = (input as HTMLInputElement).checked; render(); fitCanvas(); return; }
  if (id === "zoom") { setZoom(Number(input.value) / 100); return; }
  if (id === "snap") return;
  if (id === "layout-mode") {
    figure.layout.mode = input.value as "rows" | "free";
    if (rowsMode()) arrangePanels(figure, measureRun);
    commit("Change layout mode"); return;
  }
  if (id === "embedded") { vscode.postMessage({ type: "embed", enabled: (input as HTMLInputElement).checked }); return; }
  if (id === "figure-width") resizeFigure(figure, Number(input.value) * unitPoints(), measureRun);
  else if (id === "figure-height") { figure.height = Number(input.value) * unitPoints(); figure.autoHeight = false; }
  else if (id === "auto-height") figure.autoHeight = (input as HTMLInputElement).checked;
  else if (id === "transparent") figure.background = (input as HTMLInputElement).checked ? "transparent" : "white";
  else if (id === "columns") { figure.layout.columns = Math.max(1, Math.floor(Number(input.value))); figure.layout.rows = []; }
  else if (id === "gap") figure.layout.gap = Number(input.value);
  else if (id === "row-gap") figure.layout.rowGap = Number(input.value);
  else if (id === "padding") figure.layout.padding = Number(input.value);
  else if (id === "rows" || id === "weights") figure.layout[id] = input.value.split(/[,\s]+/).filter(Boolean).map(Number);
  else if (id === "default-family") figure.font.family = input.value;
  else if (id === "default-size") figure.font.size = Number(input.value);
  else return;
  if (rowsMode() && ["columns", "gap", "row-gap", "padding", "rows", "weights"].includes(id)) arrangePanels(figure, measureRun);
  commit("Change figure settings");
});

document.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement, input = target.closest("input,textarea,select,[contenteditable=true]");
  const modifier = event.ctrlKey || event.metaKey;
  if (modifier && ["s", "z", "y"].includes(event.key.toLowerCase()) && (!input || event.key.toLowerCase() === "s")) {
    event.preventDefault(); action(event.key.toLowerCase() === "s" ? event.shiftKey ? "saveAs" : "save" : event.key.toLowerCase() === "y" || event.shiftKey ? "redo" : "undo"); return;
  }
  if (input) return;
  if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); action("delete"); }
  else if (modifier && event.key.toLowerCase() === "a") { event.preventDefault(); selected = new Set(figure.elements.map((item) => item.id)); render(); }
  else if (modifier && event.key.toLowerCase() === "c") { event.preventDefault(); copied = structuredClone(selection()); }
  else if (modifier && event.key.toLowerCase() === "v") {
    event.preventDefault();
    const copies = structuredClone(copied);
    for (const item of copies) { item.id = newElementId(); item.x += 10; item.y += 10; }
    figure.elements.push(...copies); selected = new Set(copies.map((item) => item.id));
    if (rowsMode()) arrangePanels(figure, measureRun);
    commit("Paste elements");
  } else if (event.key === "Escape") {
    if (pointer) cancelDrag();
    else select();
  }
  else if (event.key.startsWith("Arrow") && selected.size) {
    if (rowsMode() && selection().some((element) => element.kind === "panel")) return;
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    for (const item of selection()) { item.x += event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0; item.y += event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0; }
    commit("Nudge elements");
  }
});

node("elements").addEventListener("dragstart", (event) => {
  previewKey = undefined;
  draggedId = (event.target as Element).closest<HTMLElement>("[data-select]")?.dataset.select;
  event.dataTransfer.setData("text/plain", draggedId ?? "");
});
node("elements").addEventListener("dragover", (event) => event.preventDefault());
node("elements").addEventListener("dragend", () => { draggedId = undefined; dockPreview = undefined; node("drop-hint").textContent = ""; renderCanvas(); });
node("elements").addEventListener("drop", (event) => {
  event.preventDefault(); event.stopPropagation();
  const id = (event.target as Element).closest<HTMLElement>("[data-select]")?.dataset.select;
  if (!draggedId || !id || draggedId === id) return;
  if (rowsMode() && figure.elements.find((element) => element.id === draggedId)?.kind === "panel" && figure.elements.find((element) => element.id === id)?.kind === "panel") {
    dockPanels(figure, new Set([draggedId]), { kind: "beside", anchor: id, side: "before" }, measureRun);
    draggedId = undefined; commit("Reorganise panel rows"); return;
  }
  const index = figure.elements.findIndex((item) => item.id === draggedId), target = figure.elements.findIndex((item) => item.id === id);
  const [element] = figure.elements.splice(index, 1); figure.elements.splice(target, 0, element);
  draggedId = undefined; commit("Reorder elements");
});
viewport.addEventListener("dragover", (event) => {
  event.preventDefault(); event.dataTransfer.dropEffect = draggedId ? "move" : "copy";
  if (!draggedId || !rowsMode() || figure.elements.find((element) => element.id === draggedId)?.kind !== "panel") return;
  const point = figurePoint(event), ids = new Set([draggedId]);
  previewDock(figure, ids, findDockTarget(figure, ids, point.x, point.y));
});
viewport.addEventListener("dragleave", (event) => {
  const bounds = viewport.getBoundingClientRect();
  if (event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom) return;
  if (event.relatedTarget instanceof Node && viewport.contains(event.relatedTarget)) return;
  dockPreview = undefined; node("drop-hint").textContent = ""; renderCanvas();
});
viewport.addEventListener("drop", async (event) => {
  event.preventDefault();
  if (draggedId) {
    if (dockPreview) { figure = dockPreview; dockPreview = undefined; node("drop-hint").textContent = ""; commit("Reorganise panel rows"); }
    draggedId = undefined; return;
  }
  const uriList = event.dataTransfer.getData("text/uri-list");
  if (uriList) { vscode.postMessage({ type: "drop", paths: uriList.split(/\r?\n/).filter((line) => line && !line.startsWith("#")) }); return; }
  const files: Array<{ name: string; data: string }> = [];
  for (const file of Array.from(event.dataTransfer.files)) {
    const data = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file);
    });
    files.push({ name: file.name, data });
  }
  vscode.postMessage({ type: "drop", files });
});

/** Changes only the view scale, keeping the board point beneath the cursor stationary. */
function setZoom(value: number, clientX?: number, clientY?: number): void {
  if (!Number.isFinite(value)) return;
  if (pointer) cancelDrag();
  const bounds = viewport.getBoundingClientRect(), boardBounds = board.getBoundingClientRect();
  const x = clientX ?? bounds.left + viewport.clientWidth / 2;
  const y = clientY ?? bounds.top + viewport.clientHeight / 2;
  const pointX = (x - boardBounds.left) / zoom, pointY = (y - boardBounds.top) / zoom;
  zoom = Math.max(.1, Math.min(5, value));
  setValue("zoom", Math.round(zoom * 100)); renderCanvas();
  const next = board.getBoundingClientRect();
  viewport.scrollLeft += next.left + pointX * zoom - x;
  viewport.scrollTop += next.top + pointY * zoom - y;
}

viewport.addEventListener("wheel", (event) => {
  if (!event.ctrlKey && !event.metaKey) return;
  event.preventDefault();
  const delta = event.deltaY * (event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16 : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? viewport.clientHeight : 1);
  setZoom(zoom * Math.exp(-delta * .002), event.clientX, event.clientY);
}, { passive: false });

/** Fits the full A4 reference or figure into the available viewport without changing saved geometry. */
function fitCanvas(): void {
  const width = a4 ? Math.max(A4.width, figure.width) : figure.width;
  const height = a4 ? Math.max(A4.height, figure.height + 22 * PT_PER_MM) : figure.height;
  zoom = Math.max(.1, Math.min(2, (viewport.clientWidth - 56) / (width * 96 / 72), (viewport.clientHeight - 56) / (height * 96 / 72)));
  setValue("zoom", Math.round(zoom * 100)); renderCanvas();
  viewport.scrollTo(0, 0);
}

/** Loads intrinsic aspect ratios before laying out newly imported images. */
async function loadImageRatios(): Promise<boolean> {
  let changed = false;
  await Promise.all(figure.elements.filter((item): item is Panel => item.kind === "panel").map(async (panel) => {
    const data = sources[panel.source];
    if (!data) return;
    const image = new Image(); image.src = data;
    try {
      await image.decode();
      const ratio = image.naturalWidth / image.naturalHeight;
      if (Number.isFinite(ratio) && ratio > 0 && Math.abs(ratio - panel.ratio) > .0001) { panel.ratio = ratio; changed = true; }
    } catch { notice(t("An image could not be decoded: {0}", panel.name)); }
  }));
  return changed;
}

/** Rasterizes the exact saved SVG composition at a physical-size-derived pixel resolution. */
async function exportPng(data: Extract<HostMessage, { type: "export" }>): Promise<void> {
  flushText(); reflowFigure(figure, measureRun);
  const width = Math.round(figure.width / 72 * data.dpi), height = Math.round(figure.height / 72 * data.dpi);
  if (width * height > 160_000_000 || width < 1 || height < 1) throw new Error(t("Choose a lower DPI or a smaller figure"));
  const svg = serializeFigure(figure, (source) => data.sources[source] ?? source, false);
  const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
  try {
    const image = new Image(); image.src = url; await image.decode();
    const canvas = document.createElement("canvas"); canvas.width = width; canvas.height = height;
    canvas.getContext("2d").drawImage(image, 0, 0, width, height);
    vscode.postMessage({ type: "png", data: canvas.toDataURL("image/png") });
  } finally { URL.revokeObjectURL(url); }
}

window.addEventListener("message", async (event: MessageEvent<HostMessage>) => {
  const message = event.data;
  try {
    if (message.type === "error") { notice(message.message); return; }
    if (message.type === "export") { await exportPng(message); return; }
    if (message.type !== "state" || message.revision < revision) return;
    const initial = revision < 0, same = message.revision === revision;
    for (const name of ["undo", "redo"] as const) {
      const available = name === "undo" ? message.canUndo : message.canRedo;
      if (available !== undefined) document.querySelector<HTMLButtonElement>(`[data-action=${name}]`).disabled = !available;
    }
    sources = message.sources;
    // A same-revision acknowledgement may arrive after pointerdown; leave its retained nodes intact.
    if (same && pointer) return;
    if (!same) {
      if (pointer) clearDrag();
      figure = message.figure; lastValidFigure = structuredClone(figure); revision = message.revision;
      selected = new Set([...selected].filter((id) => figure.elements.some((element) => element.id === id)));
    }
    const ratioChanged = await loadImageRatios();
    if (pointer) return;
    if (ratioChanged) { if (initial) arrangePanels(figure, measureRun); commit("Update image dimensions"); }
    else if (!same) {
      reflowFigure(figure, measureRun);
      lastValidFigure = structuredClone(figure);
      vscode.postMessage({ type: "textLayout", lines: Object.fromEntries(figure.elements.map((item) => [item.id, item.lines])), height: figure.height });
      render();
    }
    else renderCanvas();
    if (initial) fitCanvas();
    if (message.failures.length) notice(message.failures.join("\n"));
  } catch (error) { notice(String(error)); }
});
vscode.postMessage({ type: "ready" });

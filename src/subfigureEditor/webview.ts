/**
 * Runs the combination figure editor inside a VS Code Webview.
 *
 * Coordinates and typography stay in physical points; screen zoom and the A4
 * reference affect only the view. User gestures commit through the host so
 * VS Code can manage native undo, dirty state, Save As and draft recovery.
 */
import { A4, PT_PER_MM, createFigure, reflowFigure, resizeFigure, arrangePanels, alignElements,
  elementHeight, visibleRatio, renumberPanels, autoRenumberPanels, validateFigure,
  type FigureDocument, type FigureElement, type RichRun, type TextStyle, type Panel } from "./model";
import { serializeFigure, renderElement, escapeXml, decimal } from "./svg";
import { newElementId } from "./ids";
import type { EditorMessage, HostMessage } from "./protocol";
import { panelRows, resizeRowPair, snapRowDivider, snapSelection, type DividerSnap, type AlignmentGuide } from "./layout";
import { BUTTON_HELP, FORMAT_HELP } from "./help";
import { chineseUnicodeRange, DEFAULT_CHINESE_FONT, fontSegments, quotedFont } from "./fonts";
import { dockTreePanels, prepareTreeDock, resizeTreeDivider, syncPanelTree, treeFromRows, treeGeometry,
  nestedPanelPreset, type Box, type TreeDock, type TreeDivider } from "./panelTree";
import { cropGeometry, cropFromFrame, dragCropFrame, panCropSource, whitespaceCrop } from "./crop";

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
let fitWidth = true;
node("properties-toggle").addEventListener("click", () => {
  const open = node("properties-panel").classList.toggle("open");
  node("properties-toggle").setAttribute("aria-expanded", String(open));
});
const measure = document.createElement("canvas").getContext("2d");
let figure = createFigure(), revision = -1, sources: Record<string, string> = {};
let lastValidFigure = structuredClone(figure);
let selected = new Set<string>(), zoom = .9, a4 = true, unit = "mm", copied: FigureElement[] = [];
type CanvasTextPart = "text" | "caption" | "label";
const canvasText = node("canvas-text");
let inlineEdit: { id: string; part: CanvasTextPart; originalHtml: string } | undefined;
let pointer: { start: DOMPoint; original: FigureDocument; mode: "move" | "resize" | "dock" | "divider"; id: string; moved: boolean;
  textPart?: CanvasTextPart;
  ids: Set<string>; right?: string; target?: TreeDock; snap?: DividerSnap; guides?: AlignmentGuide[];
  split?: string; index?: number; treeSnap?: ReturnType<typeof resizeTreeDivider> } | undefined;
let draggedId: string | undefined, editingText = false, textTimer: ReturnType<typeof setTimeout> | undefined;
let dockSession: { hit: ReturnType<typeof prepareTreeDock>; target?: TreeDock; bounds?: Box } | undefined;
let dragGhost: SVGGElement | undefined;
let moveFrame = 0, pendingMove: PointerEvent | undefined;
let cropping: { id: string; original: FigureDocument; source: Box; frame: Box } | undefined;
let cropPointer: { start: DOMPoint; handle: string; source: Box; frame: Box } | undefined;
let cropAnalysis: object | undefined, cropFeedback = "";

/** Treats older SVGs without a mode as free layouts, preserving their manually authored geometry. */
function rowsMode(): boolean { return figure.layout.mode === "rows" || figure.layout.mode === "panels"; }

/** Measures selected-font glyph advances in the same physical coordinates used by the SVG. */
function measureRun(run: RichRun, style: TextStyle): number {
  const prefix = `${run.italic ? "italic " : ""}${run.bold ? "bold " : ""}${style.size * (run.script ? .7 : 1)}px `;
  return fontSegments(run.text, style).reduce((width, segment) => {
    measure.font = prefix + quotedFont(segment.family);
    return width + measure.measureText(segment.text).width;
  }, 0);
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
    if (figure.layout.tree || figure.layout.mode === "panels") syncPanelTree(figure);
    if (autoRenumberPanels(figure) && rowsMode()) arrangePanels(figure, measureRun);
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

/** Shares the visible board geometry between rendering, fitting and figure-relative docking. */
function canvasGeometry(document: FigureDocument): { marginX: number; marginY: number; width: number; height: number } {
  const marginX = a4 ? Math.max(0, (A4.width - document.width) / 2) : 0;
  const marginY = a4 ? 22 * PT_PER_MM : 0;
  return { marginX, marginY, width: a4 ? Math.max(A4.width, document.width + 16) : document.width,
    height: a4 ? Math.max(A4.height, document.height + marginY + 16) : document.height };
}

/** Includes the full paper whitespace while preserving edge docking when the A4 reference is hidden. */
function beginDock(original: FigureDocument, ids: Set<string>): void {
  const { marginX, marginY, width, height } = canvasGeometry(original);
  dockSession = { hit: prepareTreeDock(original, ids), bounds: a4 ? { x: -marginX, y: -marginY, width, height } : undefined };
}

/** Updates the canvas, A4 paper boundary, figure boundary and non-exported selection overlays. */
function renderCanvas(): void {
  const { marginX, marginY, width, height } = canvasGeometry(figure);
  board.setAttribute("viewBox", `0 0 ${width} ${height}`);
  board.style.width = `${width * 96 / 72 * zoom}px`; board.style.height = `${height * 96 / 72 * zoom}px`;
  board.innerHTML = (a4 ? `<rect width="${A4.width}" height="${A4.height}" fill="white"/><text x="12" y="18" fill="#888" font-family="Arial" font-size="8">A4 · 210 × 297 mm</text>` : "")
    + `<g id="figure-group" transform="translate(${marginX} ${marginY})">`
    + `<rect width="${figure.width}" height="${figure.height}" fill="${figure.background === "white" ? "white" : "#f2f2f2"}" stroke="#999" stroke-dasharray="4 3" stroke-width=".6" data-figure-background="true"/>`
    + `<g id="artwork">${figure.elements.map(canvasElement).join("")}</g>`
    + `<g id="overlays">${canvasOverlays(figure)}</g>`
    + `<g id="snap-overlays">${snapGuides(figure)}</g>`
    + '<g id="crop-overlay"></g><g id="dock-marker" pointer-events="none"></g>'
    + (!figure.elements.length ? `<text class="empty" x="${figure.width / 2}" y="${figure.height / 2}" text-anchor="middle">${escapeXml(t("Drop images here or choose Add images"))}</text>` : "") + "</g>";
  const w = decimal(figure.width / PT_PER_MM), h = decimal(figure.height / PT_PER_MM);
  node("status").textContent = t("{0} × {1} mm · {2} elements", w, h, figure.elements.length);
  node("paper-info").textContent = t("{0} mm wide · {1}% of A4 width", Number((figure.width / PT_PER_MM).toFixed(1)), Number((figure.width / A4.width * 100).toFixed(1)));
  if (cropping) renderCrop();
  if (inlineEdit) positionCanvasText();
  positionPanelTools();
}

/** Gives cleared text a clickable first line on the canvas without writing a placeholder into the SVG. */
function canvasElement(element: FigureElement): string {
  const markup = renderElement(element, imageSource);
  if (element.lines?.length) return markup;
  const y = element.y + (element.kind === "panel" ? element.height + element.gap : 0);
  return markup.slice(0, -4) + `<rect class="empty-text-target" x="${element.x}" y="${y}" width="${element.width}" height="${element.style.size * 1.25}" fill="transparent"/></g>`;
}

/** Builds inexpensive selection and docking guides separately from source image nodes. */
function canvasOverlays(display: FigureDocument): string {
  return display.elements.filter((element) => selected.has(element.id)).map((element) => `<g data-selection-id="${escapeXml(element.id)}"><rect class="selection" x="${element.x}" y="${element.y}" width="${element.width}" height="${elementHeight(element)}"/>`
    + (rowsMode() && element.kind === "panel" ? "" : `<rect class="resize" data-resize="${escapeXml(element.id)}" x="${element.x + element.width - 3}" y="${element.y + (element.kind === "panel" ? element.height : elementHeight(element)) - 3}" width="6" height="6"/>`) + "</g>").join("")
    + (rowsMode() && display.layout.mode === "panels" ? treeGeometry(display).dividers.map(treeDividerSvg).join("") : rowsMode() ? panelRows(display).flatMap((row) => row.slice(0, -1).map((left, index) => {
      const right = row[index + 1], x = (left.x + left.width + right.x) / 2, hitWidth = Math.max(6 / zoom, figure.layout.gap);
      return `<line class="divider-line" x1="${x}" x2="${x}" y1="${left.y}" y2="${left.y + left.height}"/><rect class="divider" data-divider="${escapeXml(left.id)}" data-right="${escapeXml(right.id)}" x="${x - hitWidth / 2}" y="${left.y}" width="${hitWidth}" height="${left.height}"><title>${escapeXml(t("Drag to resize adjacent panels. Snap to common divisions, equal widths or heights, and other rows. Hold Alt to bypass snapping."))}</title></rect>`;
    })).join("") : "");
}

/** Draws a horizontal or vertical hit target for any nested split boundary. */
function treeDividerSvg(divider: TreeDivider): string {
  const { box, position, axis } = divider, hit = 8 / (zoom * 96 / 72);
  return `<line class="divider-line" x1="${axis === "x" ? position : box.x}" x2="${axis === "x" ? position : box.x + box.width}" y1="${axis === "y" ? position : box.y}" y2="${axis === "y" ? position : box.y + box.height}"/>`
    + `<rect class="divider${axis === "y" ? " horizontal" : ""}" data-split="${divider.split}" data-index="${divider.index}" x="${axis === "x" ? position - hit / 2 : box.x}" y="${axis === "y" ? position - hit / 2 : box.y}" width="${axis === "x" ? hit : box.width}" height="${axis === "y" ? hit : box.height}"><title>${escapeXml(t("Drag to resize adjacent regions. Hold Alt to bypass snapping."))}</title></rect>`;
}

/** Draws temporary PPT-style guides for the coordinates actually captured by snapping. */
function snapGuides(display: FigureDocument): string {
  const divider = pointer?.snap ? `<g class="snap-guide"><line x1="${pointer.snap.x}" x2="${pointer.snap.x}" y1="0" y2="${display.height}"/><text x="${pointer.snap.x + 4}" y="10">${escapeXml(dividerSnapLabel(pointer.snap))}</text></g>` : "";
  const tree = pointer?.treeSnap;
  const treeGuide = tree ? `<g class="snap-guide"><line x1="${tree.axis === "x" ? tree.position : 0}" x2="${tree.axis === "x" ? tree.position : display.width}" y1="${tree.axis === "y" ? tree.position : 0}" y2="${tree.axis === "y" ? tree.position : display.height}"/><text x="${tree.axis === "x" ? tree.position + 4 : 4}" y="${tree.axis === "y" ? tree.position - 4 : 10}">${escapeXml(tree.label === "fraction" ? t(tree.axis === "x" ? "{0}% width" : "{0}% height", Math.round(tree.fraction * 1000) / 10) : t(tree.label === "aligned" ? "Aligned with another divider" : tree.label === "equal-height" ? "Equal image heights" : "Equal adjacent regions"))}</text></g>` : "";
  return divider + treeGuide + (pointer?.guides ?? []).map((guide) => {
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

/** Positions a screen-sized crop toolbar above the selected image without including it in SVG output. */
function positionPanelTools(): void {
  const tools = node("panel-tools"), panel = selection()[0];
  if (pointer || inlineEdit || !cropping && (selection().length !== 1 || panel?.kind !== "panel")) { tools.classList.add("hidden"); return; }
  const mode = cropping ? "crop" : "select";
  if (tools.dataset.mode !== mode) {
    tools.dataset.mode = mode;
    const actions = cropping ? [["cropDone", "Done", "check"], ["cropCancel", "Cancel", "close"],
      ["cropAuto", "Trim whitespace", "wand"], ["cropReset", "Reset crop", "discard"]]
      : [["crop", "Crop image", "crop"], ["cropAuto", "Trim whitespace", "wand"]];
    tools.innerHTML = actions.map(([action, label, icon]) => `<button data-action="${action}" title="${escapeXml(t(BUTTON_HELP[action]))}"><span class="codicon codicon-${icon}" aria-hidden="true"></span>${escapeXml(t(label))}</button>`).join("")
      + (cropping ? '<span class="muted crop-feedback" role="status"></span>' : "");
  }
  tools.querySelector<HTMLButtonElement>("[data-action=cropAuto]").disabled = Boolean(cropAnalysis);
  const feedback = tools.querySelector(".crop-feedback");
  if (feedback) { feedback.textContent = cropFeedback; feedback.classList.toggle("hidden", !cropFeedback); }
  tools.classList.remove("hidden");
  const box = cropping?.frame ?? panel, group = document.getElementById("figure-group") as unknown as SVGGraphicsElement;
  const point = new DOMPoint(box.x + box.width / 2, box.y).matrixTransform(group.getScreenCTM()), bounds = viewport.getBoundingClientRect();
  tools.style.maxWidth = `${bounds.width - 12}px`;
  tools.style.left = `${Math.max(bounds.left + 6, Math.min(bounds.right - tools.offsetWidth - 6, point.x - tools.offsetWidth / 2))}px`;
  tools.style.top = `${Math.max(bounds.top + 6, Math.min(bounds.bottom - tools.offsetHeight - 6, point.y - tools.offsetHeight - 8))}px`;
}

/** Starts a crop transaction whose preview remains separate from layout and native history. */
function beginCrop(): void {
  flushText(); editingText = false;
  const panel = selection()[0];
  if (selection().length !== 1 || panel?.kind !== "panel") return;
  const geometry = cropGeometry(panel);
  cropAnalysis = undefined; cropFeedback = "";
  cropping = { id: panel.id, original: structuredClone(figure), source: geometry.source, frame: geometry.frame };
  board.focus(); renderCrop();
}

/** Analyzes a bounded raster preview of the original source and proposes a reversible crop in the current session. */
async function trimWhitespace(): Promise<void> {
  if (!cropping) beginCrop();
  if (!cropping || cropAnalysis) return;
  const session = cropping, request = {}, panel = session.original.elements.find((element) => element.id === session.id) as Panel;
  cropAnalysis = request; cropFeedback = t("Detecting outer whitespace…"); positionPanelTools();
  try {
    const source = sources[panel.source] ?? (panel.source.startsWith("data:") ? panel.source : undefined);
    if (!source) throw new Error(t("The source image is unavailable. Refresh images and try again."));
    const image = new Image(); image.src = source; await image.decode();
    if (cropping !== session || cropAnalysis !== request) return;
    const scale = Math.min(source.startsWith("data:image/svg+xml") ? Infinity : 1, 2048 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale)); canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const crop = whitespaceCrop(context.getImageData(0, 0, canvas.width, canvas.height));
    if (crop) {
      const bounds = session.source;
      session.frame = { x: bounds.x + bounds.width * crop.left / 100, y: bounds.y + bounds.height * crop.top / 100,
        width: bounds.width * (100 - crop.left - crop.right) / 100, height: bounds.height * (100 - crop.top - crop.bottom) / 100 };
      cropFeedback = t("Whitespace crop is ready. Choose Done to apply."); renderCrop();
    } else cropFeedback = t("No outer whitespace detected; crop unchanged.");
  } catch (error) {
    if (cropping === session && cropAnalysis === request) {
      cropFeedback = ""; notice(t("Could not detect whitespace: {0}", error instanceof Error ? error.message : String(error)));
    }
  } finally {
    // Cancel, reset and manual gestures invalidate pending image decoding so stale results cannot replace newer work.
    if (cropAnalysis === request) { cropAnalysis = undefined; positionPanelTools(); }
  }
}

/** Draws the full source once, then updates only its bounds, shading and crop handles during gestures. */
function renderCrop(): void {
  if (!cropping) return;
  const overlay = document.getElementById("crop-overlay"), panel = figure.elements.find((element) => element.id === cropping.id) as Panel;
  if (!overlay.querySelector("#crop-source")) overlay.innerHTML = `<image id="crop-source" href="${escapeXml(imageSource(panel.source))}" preserveAspectRatio="none" pointer-events="none"/><g id="crop-handles"></g>`;
  const image = overlay.querySelector("#crop-source"), source = cropping.source, frame = cropping.frame;
  for (const [name, value] of Object.entries(source)) image.setAttribute(name, String(value));
  document.getElementById("artwork").setAttribute("opacity", ".25");
  document.getElementById("overlays").setAttribute("visibility", "hidden");
  const size = 10 / (zoom * 96 / 72);
  const masks: Box[] = [
    { x: source.x, y: source.y, width: source.width, height: frame.y - source.y },
    { x: source.x, y: frame.y + frame.height, width: source.width, height: source.y + source.height - frame.y - frame.height },
    { x: source.x, y: frame.y, width: frame.x - source.x, height: frame.height },
    { x: frame.x + frame.width, y: frame.y, width: source.x + source.width - frame.x - frame.width, height: frame.height },
  ];
  overlay.querySelector("#crop-handles").innerHTML = masks.map((box) => `<rect x="${box.x}" y="${box.y}" width="${Math.max(0, box.width)}" height="${Math.max(0, box.height)}" fill="#000" opacity=".55" pointer-events="none"/>`).join("")
    + `<rect class="crop-frame" data-crop-handle="pan" x="${frame.x}" y="${frame.y}" width="${frame.width}" height="${frame.height}"/>`
    + [["nw", 0, 0], ["n", .5, 0], ["ne", 1, 0], ["e", 1, .5], ["se", 1, 1], ["s", .5, 1], ["sw", 0, 1], ["w", 0, .5]].map(([handle, xf, yf]) => {
      const x = frame.x + Number(xf) * frame.width, y = frame.y + Number(yf) * frame.height;
      const horizontal = xf === .5, vertical = yf === .5;
      const path = horizontal ? `M${x - size / 2} ${y}h${size}` : vertical ? `M${x} ${y - size / 2}v${size}`
        : `M${x + (xf ? -size : size)} ${y}H${x}V${y + (yf ? -size : size)}`;
      return `<path class="crop-handle" d="${path}"/><rect data-crop-handle="${handle}" x="${x - size}" y="${y - size}" width="${size * 2}" height="${size * 2}" fill="transparent" style="cursor:${handle}-resize"/>`;
    }).join("");
  positionPanelTools();
}

/** Adjusts crop edges or pans the image while retaining its decoded SVG image node. */
function moveCrop(event: PointerEvent): void {
  cropAnalysis = undefined; cropFeedback = "";
  const point = figurePoint(event), dx = point.x - cropPointer.start.x, dy = point.y - cropPointer.start.y;
  if (cropPointer.handle === "pan") cropping.source = panCropSource(cropPointer.source, cropPointer.frame, dx, dy);
  else cropping.frame = dragCropFrame(cropPointer.source, cropPointer.frame, cropPointer.handle, dx, dy, 8 / (zoom * 96 / 72));
  renderCrop();
}

/** Applies a completed crop once, allowing structured layouts to reflow only after confirmation. */
function finishCrop(): void {
  if (!cropping) return;
  if (pendingMove && cropPointer) flushPointerMove();
  const session = cropping, crop = cropFromFrame(session.source, session.frame);
  cropping = undefined; cropPointer = undefined; cropAnalysis = undefined; cropFeedback = "";
  figure = structuredClone(session.original);
  const panel = figure.elements.find((element) => element.id === session.id) as Panel;
  const changed = (Object.keys(crop) as Array<keyof typeof crop>).some((key) => Math.abs(crop[key] - panel.crop[key]) > .000001);
  if (!changed) { render(); return; }
  panel.crop = crop;
  if (rowsMode()) arrangePanels(figure, measureRun);
  else Object.assign(panel, session.frame);
  commit("Crop image");
}

/** Discards the entire crop transaction, including all intermediate edge and pan gestures. */
function cancelCrop(): void {
  if (!cropping) return;
  if (moveFrame) cancelAnimationFrame(moveFrame);
  moveFrame = 0; pendingMove = undefined;
  cropping = undefined; cropPointer = undefined; cropAnalysis = undefined; cropFeedback = ""; render();
}

viewport.addEventListener("scroll", positionPanelTools);
window.addEventListener("resize", positionPanelTools);

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
  positionPanelTools();
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
  setValue("layout-mode", rowsMode() ? "panels" : "free");
  document.querySelector<HTMLButtonElement>("[data-action=arrange]").disabled = rowsMode();
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-action^='nested:']")) {
    button.disabled = figure.elements.filter((element) => element.kind === "panel").length < 3;
  }
  node("layout-help").textContent = t(rowsMode()
    ? "Centre: swap two panels. Edge: place beside a panel. Gap: insert between regions. Paper margin: add a whole row or column."
    : "Drag to move freely; use corner handles to resize. Switch to Panel layout to organise panels by docking.");
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-action^='align:']")) {
    button.disabled = selection().length < 2 || rowsMode() && selection().some((element) => element.kind === "panel");
  }
  setValue("figure-width", Number((figure.width / unitPoints()).toFixed(2)));
  setValue("figure-height", Number((figure.height / unitPoints()).toFixed(2)));
  setValue("auto-height", figure.autoHeight); setValue("transparent", figure.background === "transparent"); setValue("embedded", figure.embedded);
  setValue("auto-renumber", figure.autoRenumber !== false);
  setValue("columns", figure.layout.columns); setValue("gap", figure.layout.gap); setValue("row-gap", figure.layout.rowGap); setValue("padding", figure.layout.padding);
  setValue("rows", figure.layout.rows.join(", ")); setValue("weights", figure.layout.weights.join(", "));
  setValue("default-family", figure.font.family); setValue("default-size", figure.font.size);
  setValue("default-cjk", figure.font.cjkFamily || DEFAULT_CHINESE_FONT);
  if (!editingText) renderInspector();
}

/** Creates a safely escaped inspector field for one physical element property. */
function field(label: string, key: string, value: string | number, type = "number"): string {
  const locked = rowsMode() && selection()[0]?.kind === "panel" && ["x", "y", "width", "height"].includes(key);
  const automatic = key === "label" && figure.autoRenumber !== false;
  const reason = automatic ? "Turn off Auto renumber to edit this label."
    : locked ? "Panel layout controls this geometry. Drag dividers, or switch to Free positioning for individual sizes." : "";
  const list = key === "cjkFamily" ? ' list="chinese-fonts"' : key === "family" ? ' list="fonts"' : "";
  return `<label class="field"><span>${escapeXml(t(label))}</span><input data-property="${key}" type="${type}" value="${escapeXml(String(value))}"${list}${type === "number" ? ' step=".5"' : ""}${reason ? ` disabled title="${escapeXml(t(reason))}"` : ""}></label>`;
}

/** Shares the same five commands and accessible descriptions between the inspector and selection toolbar. */
function formatButtons(): string {
  return [["bold", "<b>B</b>"], ["italic", "<i>I</i>"], ["superscript", "x²"], ["subscript", "x₂"], ["removeFormat", escapeXml(t("Clear formatting"))]]
    .map(([command, label]) => `<button data-format="${command}" title="${escapeXml(t(FORMAT_HELP[command]))}" aria-label="${escapeXml(t(FORMAT_HELP[command]))}">${label}</button>`).join("");
}

const formatBar = node("format-bar");
formatBar.innerHTML = formatButtons();
let composingInline = false;
/** Keeps the mini toolbar next to a visible text selection without intersecting the selected lines. */
function positionFormatBar(): void {
  const selection = window.getSelection();
  if (!inlineEdit || inlineEdit.part === "label" || composingInline || !selection?.rangeCount || selection.isCollapsed
    || !canvasText.contains(selection.anchorNode) || !canvasText.contains(selection.focusNode)) {
    formatBar.classList.add("hidden"); return;
  }
  const range = selection.getRangeAt(0).getBoundingClientRect(), view = viewport.getBoundingClientRect();
  if (!range.height || range.bottom <= view.top || range.top >= view.bottom || range.right <= view.left || range.left >= view.right) {
    formatBar.classList.add("hidden"); return;
  }
  formatBar.classList.remove("hidden");
  const width = formatBar.offsetWidth, height = formatBar.offsetHeight;
  formatBar.style.left = `${Math.max(view.left + 3, Math.min((range.left + range.right - width) / 2, view.right - width - 3))}px`;
  formatBar.style.top = `${range.top - height - 5 >= view.top ? range.top - height - 5 : Math.min(range.bottom + 5, view.bottom - height)}px`;
  for (const button of formatBar.querySelectorAll<HTMLButtonElement>("button:not([data-format=removeFormat])")) {
    button.setAttribute("aria-pressed", String(document.queryCommandState(button.dataset.format)));
  }
}
document.addEventListener("selectionchange", positionFormatBar);
viewport.addEventListener("scroll", positionFormatBar);
window.addEventListener("resize", positionFormatBar);
canvasText.addEventListener("compositionstart", () => { composingInline = true; positionFormatBar(); });
canvasText.addEventListener("compositionend", () => { composingInline = false; positionFormatBar(); });
const fontRule = document.createElement("style");
document.head.appendChild(fontRule);

/** Applies the Chinese family even to newly typed characters without rewriting the editable DOM or disturbing the IME. */
function editorFont(style: TextStyle): string {
  const chinese = quotedFont(style.cjkFamily || DEFAULT_CHINESE_FONT);
  const rule = `@font-face{font-family:PapperCanvasChinese;src:local(${chinese});unicode-range:${chineseUnicodeRange}}`;
  if (fontRule.textContent !== rule) fontRule.textContent = rule;
  return `PapperCanvasChinese, ${quotedFont(style.family)}, ${chinese}`;
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
    + field("Western font", "family", element.style.family, "text") + field("Chinese font", "cjkFamily", element.style.cjkFamily || DEFAULT_CHINESE_FONT, "text") + `<div class="pair">` + field("Font size (pt)", "size", element.style.size) + field("Text color", "color", element.style.color, "color") + "</div>"
    + `<label class="field"><span>${escapeXml(t("Text alignment"))}</span><select data-property="align">${["left", "center", "right"].map((value) => `<option${element.style.align === value ? " selected" : ""}>${value}</option>`).join("")}</select></label>`
    + `<h3>${escapeXml(t(panel ? "Subcaption" : "Text"))}</h3><div class="tools">${formatButtons()}</div>`
    + `<div id="rich-text" class="rich" contenteditable="true" role="textbox" aria-label="${escapeXml(t(panel ? "Subcaption" : "Text"))}">${richHtml(panel ? panel.caption : (element as Extract<FigureElement, { kind: "text" }>).runs)}</div>`
    + `<p class="muted">${escapeXml(t("Click text on the canvas to edit. Enter applies, Shift+Enter adds a line, and Esc cancels."))}</p>`
    + (panel ? `<h3>${escapeXml(t("Crop (%)"))}</h3><div class="pair">${(["left", "top", "right", "bottom"] as const).map((edge) => field({ left: "Left", top: "Top", right: "Right", bottom: "Bottom" }[edge], `crop.${edge}`, panel.crop[edge])).join("")}</div><p class="muted">${escapeXml(t("Cropping changes only the visible area. The source image stays intact."))}</p><button data-action="openSource" title="${escapeXml(t(BUTTON_HELP.openSource))}">${escapeXml(t("Open source image"))}</button>` : "");
  node("rich-text").style.fontFamily = editorFont(element.style);
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

/** Separates editable captions from panel letters, even when both share the same SVG text line. */
function canvasTextPart(target: Element, element: FigureElement, event: PointerEvent): CanvasTextPart | undefined {
  const line = target.closest("text");
  if (!line && !target.closest(".empty-text-target")) return undefined;
  if (element.kind === "text") return "text";
  if (line && element.label && element.labelPosition.startsWith("top-") && line === line.parentElement.querySelector(":scope > text")) {
    return figure.autoRenumber === false ? "label" : undefined;
  }
  if (line && element.label && element.labelPosition === "below" && figure.autoRenumber === false && line === line.parentElement.querySelector(":scope > text")) {
    const index = line.getCharNumAtPosition(figurePoint(event));
    if (index >= 0 && index < element.label.length + 2) return "label";
  }
  return "caption";
}

/** Anchors the HTML editor to physical SVG coordinates through zoom, scroll and A4 margins. */
function positionCanvasText(): void {
  const element = figure.elements.find(item => item.id === inlineEdit.id);
  const group = document.getElementById("figure-group") as unknown as SVGGraphicsElement;
  const matrix = group.getScreenCTM(), bounds = viewport.getBoundingClientRect();
  const panel = element.kind === "panel" ? element : undefined;
  const corner = inlineEdit.part === "label" && panel?.labelPosition.startsWith("top-");
  const width = corner ? Math.min(element.width, Math.max(element.style.size * 4, measureRun({ text: panel.label }, panel.style) + 8)) : element.width;
  const right = corner && panel.labelPosition === "top-right";
  const point = new DOMPoint(element.x + (right ? element.width - width - 4 : corner ? 4 : 0),
    element.y + (corner ? 2 : panel ? panel.height + panel.gap : 0)).matrixTransform(matrix);
  Object.assign(canvasText.style, { left: `${point.x - bounds.left + viewport.scrollLeft}px`, top: `${point.y - bounds.top + viewport.scrollTop}px`,
    width: `${width * matrix.a}px`, minHeight: `${element.style.size * 1.25 * matrix.d}px`, fontSize: `${element.style.size * matrix.d}px`,
    textAlign: corner ? (right ? "right" : "left") : element.style.align, color: element.style.color, fontFamily: editorFont(element.style) });
  const lines = document.querySelectorAll<SVGTextElement>(`#artwork [data-element-id="${CSS.escape(element.id)}"] > text`);
  for (const [index, line] of lines.entries()) {
    const cornerLabel = index === 0 && panel?.label && panel.labelPosition.startsWith("top-");
    if (Boolean(cornerLabel) === Boolean(corner)) line.style.visibility = "hidden";
  }
  positionFormatBar();
}

/** Opens an independent editing buffer and places the caret where the user released the pointer. */
function beginCanvasText(id: string, part: CanvasTextPart, event: PointerEvent): void {
  const element = figure.elements.find(item => item.id === id);
  const panel = element.kind === "panel" ? element : undefined;
  canvasText.innerHTML = part === "label" ? escapeXml(panel.label) : richHtml(element.kind === "text" ? element.runs : element.caption);
  inlineEdit = { id, part, originalHtml: canvasText.innerHTML };
  canvasText.dataset.prefix = part === "caption" && panel.label && panel.labelPosition === "below" ? `(${panel.label}) ` : "";
  canvasText.setAttribute("aria-label", t(part === "label" ? "Panel label" : part === "caption" ? "Subcaption" : "Text"));
  canvasText.classList.remove("hidden"); positionCanvasText(); positionPanelTools();
  canvasText.focus({ preventScroll: true });
  const range = document.caretRangeFromPoint(event.clientX, event.clientY) ?? document.createRange();
  if (!canvasText.contains(range.startContainer)) { range.selectNodeContents(canvasText); range.collapse(false); }
  window.getSelection().removeAllRanges(); window.getSelection().addRange(range);
}

/** Applies one edit on exit, or discards the buffer on Escape or a replacement host revision. */
function finishCanvasText(apply: boolean): void {
  if (!inlineEdit) return;
  const { id, part, originalHtml } = inlineEdit;
  inlineEdit = undefined;
  composingInline = false;
  formatBar.classList.add("hidden");
  canvasText.classList.add("hidden");
  const element = figure.elements.find(item => item.id === id);
  if (apply && element && canvasText.innerHTML !== originalHtml) {
    if (part === "label" && element.kind === "panel") {
      element.label = canvasText.textContent.trim();
      const field = document.querySelector<HTMLInputElement>('[data-property="label"]');
      if (field) field.value = element.label;
    } else {
      // Chromium leaves a placeholder break in a contenteditable when the last character is deleted.
      const runs = canvasText.innerHTML === "<br>" ? [] : readRichText(canvasText);
      if (element.kind === "text") element.runs = runs; else element.caption = runs;
      node("rich-text").innerHTML = richHtml(runs);
    }
    if (rowsMode() && element.kind === "panel") arrangePanels(figure, measureRun);
    commit("Edit text", false);
    // Keep the inspector controls alive: a blur may be caused by clicking one of them.
    const item = document.querySelector<HTMLElement>(`[data-select="${CSS.escape(id)}"]`);
    if (element.kind === "text") item.querySelector(".name").textContent = element.runs.map(run => run.text).join("");
    else item.querySelector(".badge").textContent = element.label ? `(${element.label})` : "▧";
  } else renderCanvas();
}

/** Commits the visible rich-text buffer before save, selection changes or native undo. */
function flushText(): void {
  if (inlineEdit) { finishCanvasText(true); return; }
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
function select(id?: string, additive = false, retainArtwork = false): void {
  if (cropping) finishCrop();
  flushText(); editingText = false;
  if (!additive) selected.clear();
  if (id) { if (additive && selected.has(id)) selected.delete(id); else selected.add(id); }
  if (retainArtwork) {
    document.getElementById("overlays").innerHTML = canvasOverlays(figure);
    for (const item of document.querySelectorAll<HTMLElement>("[data-select]")) item.classList.toggle("selected", selected.has(item.dataset.select));
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-action^='align:']")) {
      button.disabled = selection().length < 2 || rowsMode() && selection().some((element) => element.kind === "panel");
    }
    renderInspector(); positionPanelTools();
  } else render();
}

/** Converts screen coordinates through zoom and the A4 reference into figure points. */
function figurePoint(event: { clientX: number; clientY: number }): DOMPoint {
  const group = document.getElementById("figure-group") as unknown as SVGGraphicsElement;
  return new DOMPoint(event.clientX, event.clientY).matrixTransform(group.getScreenCTM().inverse());
}

/** Marks the chosen region on stationary artwork; reflow happens only when the displayed operation is released. */
function previewDock(point: DOMPoint): TreeDock | undefined {
  const previous = dockSession.target, target = dockSession.hit(point.x, point.y, dockSession.bounds, previous, 4 / (zoom * 96 / 72));
  if (previous?.scope === target?.scope && previous?.anchor === target?.anchor && previous?.side === target?.side
    && (target?.scope !== "gap" || previous?.scope === "gap" && previous.next === target.next)) return previous;
  dockSession.target = target;
  const marker = document.getElementById("dock-marker"), hint = node("drop-hint");
  if (!target) { marker.replaceChildren(); hint.textContent = ""; return; }
  const box = target.marker;
  marker.innerHTML = `<rect class="dock-preview" x="${box.x}" y="${box.y}" width="${box.width}" height="${box.height}"/>`;
  const outerHints = { left: "Release to add a column to the left of the whole layout.",
    right: "Release to add a column to the right of the whole layout.",
    top: "Release to add a row above the whole layout.", bottom: "Release to add a row below the whole layout." };
  const localHints = { center: "Swap positions with {0}.", left: "Place to the left of {0}.", right: "Place to the right of {0}.",
    top: "Place above {0}.", bottom: "Place below {0}." };
  const anchor = figure.elements.find((item) => item.id === target.anchor) as Panel;
  hint.textContent = target.scope === "figure" ? t(outerHints[target.side]) : target.scope === "gap"
    ? t(target.side === "right" ? "Insert between these columns." : "Insert between these rows.") : t(localHints[target.side], anchor.name);
  return target;
}

/** Creates one follow-pointer copy, including the attached labels and captions. */
function startDragGhost(): void {
  dragGhost = document.createElementNS("http://www.w3.org/2000/svg", "g");
  dragGhost.classList.add("drag-ghost");
  for (const element of document.querySelectorAll<SVGElement>("#artwork > [data-element-id]")) {
    if (!pointer.ids.has(element.dataset.elementId)) continue;
    const reference = document.createElementNS("http://www.w3.org/2000/svg", "use");
    element.id ||= `dock-source-${globalThis.crypto.randomUUID()}`;
    reference.setAttribute("href", `#${element.id}`);
    dragGhost.appendChild(reference);
  }
  document.getElementById("figure-group").insertBefore(dragGhost, document.getElementById("dock-marker"));
}

/** Coalesces mouse events to the display refresh rate, using the most recent position. */
function queuePointerMove(event: PointerEvent): void {
  if (!pointer && !cropPointer) return;
  pendingMove = event;
  if (!moveFrame) moveFrame = requestAnimationFrame(flushPointerMove);
}

/** Flushes the latest position on release so the final movement cannot be lost. */
function flushPointerMove(): void {
  if (moveFrame) cancelAnimationFrame(moveFrame);
  moveFrame = 0;
  const event = pendingMove; pendingMove = undefined;
  if (event) { if (cropPointer) moveCrop(event); else pointerMove(event); }
}

/** Removes transient drag state on release, cancellation and Escape. */
function clearDrag(): void {
  if (moveFrame) cancelAnimationFrame(moveFrame);
  moveFrame = 0; pendingMove = undefined;
  dragGhost?.remove(); dragGhost = undefined; dockSession = undefined;
  document.getElementById("dock-marker").replaceChildren();
  pointer = undefined; board.classList.remove("dragging"); node("drop-hint").textContent = "";
}

/** Restores the pre-drag figure when the pointer is cancelled or Escape is pressed. */
function cancelDrag(): void {
  if (!pointer) return;
  const stationary = pointer.mode === "dock";
  figure = pointer.original; clearDrag();
  if (stationary) positionPanelTools(); else render();
}

/** Moves all selected elements or resizes one panel while leaving type size unchanged. */
function pointerMove(event: PointerEvent): void {
  if (!pointer) return;
  const point = figurePoint(event), dx = point.x - pointer.start.x, dy = point.y - pointer.start.y;
  const threshold = pointer.mode === "dock" || pointer.textPart ? 4 / (zoom * 96 / 72) : .3;
  if (Math.hypot(dx, dy) < threshold && !pointer.moved) return;
  if (!pointer.moved) {
    board.classList.add("dragging");
    if (pointer.mode === "dock") { beginDock(pointer.original, pointer.ids); startDragGhost(); }
  }
  pointer.moved = true;
  if (pointer.mode === "dock") {
    dragGhost.setAttribute("transform", `translate(${dx} ${dy})`);
    pointer.target = previewDock(point);
    return;
  }
  if (pointer.mode === "divider") {
    figure = structuredClone(pointer.original);
    if (pointer.split) {
      const divider = treeGeometry(pointer.original).dividers.find((item) => item.split === pointer.split && item.index === pointer.index);
      pointer.treeSnap = resizeTreeDivider(figure, pointer.split, pointer.index, divider.axis === "x" ? dx : dy,
        !event.altKey && node<HTMLInputElement>("snap").checked ? 6 / (zoom * 96 / 72) : 0, pointer.treeSnap?.position, measureRun);
      patchCanvas(figure); return;
    }
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
    positionPanelTools();
  }
}

/** Commits a complete drag as one native history operation. */
function pointerEnd(event: PointerEvent): void {
  if (cropPointer) { pendingMove = event; flushPointerMove(); cropPointer = undefined; return; }
  if (!pointer) return;
  pendingMove = event; flushPointerMove();
  const { moved, mode, textPart, id } = pointer;
  const target = pointer.target;
  if (mode === "dock" && target) dockTreePanels(figure, pointer.ids, target, measureRun);
  clearDrag();
  if (!moved && textPart) beginCanvasText(id, textPart, event);
  else if (moved && (mode !== "dock" || target)) commit(mode === "dock" ? "Reorganise panel rows" : mode === "divider" ? "Resize row panels" : "Move or resize elements");
  else if (mode === "dock") positionPanelTools();
  else renderCanvas();
}

board.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  finishCanvasText(true);
  if (cropping) {
    const handle = (event.target as Element).closest<SVGElement>("[data-crop-handle]")?.dataset.cropHandle;
    if (handle) {
      event.preventDefault(); board.focus(); board.setPointerCapture(event.pointerId);
      cropPointer = { start: figurePoint(event), handle, source: { ...cropping.source }, frame: { ...cropping.frame } };
    } else finishCrop();
    return;
  }
  if (editingText) { flushText(); editingText = false; }
  // Finishing the previous caption can replace SVG nodes and reflow the next row.
  const original = event.target as Element;
  const target = original.isConnected ? original : document.elementFromPoint(event.clientX, event.clientY) ?? board;
  const resize = target.closest("[data-resize]")?.getAttribute("data-resize");
  const divider = target.closest<SVGElement>("[data-divider],[data-split]");
  const id = divider?.dataset.divider ?? (divider?.dataset.split
    ? selection().find((element) => element.kind === "panel")?.id ?? figure.elements.find((element) => element.kind === "panel")?.id : undefined)
    ?? resize ?? target.closest("[data-element-id]")?.getAttribute("data-element-id");
  if (!id) { select(); return; }
  if (!selected.has(id) || event.shiftKey) select(id, event.shiftKey, true);
  if (!selected.has(id)) return;
  event.preventDefault(); board.focus({ preventScroll: true }); board.setPointerCapture(event.pointerId);
  const mode = divider ? "divider" : resize ? "resize" : rowsMode() && selection().every((item) => item.kind === "panel") ? "dock" : "move";
  pointer = { start: figurePoint(event), original: mode === "dock" ? figure : structuredClone(figure), mode, id, moved: false, ids: new Set(selected), right: divider?.dataset.right,
    split: divider?.dataset.split, index: Number(divider?.dataset.index),
    textPart: !event.shiftKey && selected.size === 1 && !resize && !divider ? canvasTextPart(target, selection()[0], event) : undefined };
  node("panel-tools").classList.add("hidden");
});
board.addEventListener("pointermove", queuePointerMove);
board.addEventListener("pointerup", pointerEnd);
board.addEventListener("pointercancel", () => {
  if (cropPointer) { cropping.source = cropPointer.source; cropping.frame = cropPointer.frame; cropPointer = undefined; renderCrop(); }
  else cancelDrag();
});

/** Executes a toolbar operation without hiding the current physical layout. */
function action(name: string): void {
  if (name === "crop") { beginCrop(); return; }
  if (name === "cropAuto") { void trimWhitespace(); return; }
  if (name === "cropDone") { finishCrop(); return; }
  if (name === "cropCancel") { cancelCrop(); return; }
  if (name === "cropReset") { if (cropping) { cropAnalysis = undefined; cropFeedback = ""; cropping.frame = { ...cropping.source }; renderCrop(); } return; }
  if (cropping) finishCrop();
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
  if (name.startsWith("nested:")) { nestedPanelPreset(figure, Number(name.slice(7).split(",")[0])); arrangePanels(figure, measureRun); }
  else if (name.startsWith("preset:")) {
    const counts = name.slice(7).split(",").map(Number);
    figure.layout.mode = "panels"; figure.layout.rows = counts.length > 1 ? counts : [];
    figure.layout.columns = counts.at(-1); figure.layout.weights = [];
    figure.layout.tree = treeFromRows(figure); arrangePanels(figure, measureRun);
  }
  else if (name === "arrange") { if (rowsMode()) return; try { validateFigure(figure); arrangePanels(figure, measureRun); } catch (error) { notice(String(error)); return; } }
  else if (name === "renumber") renumberPanels(figure);
  else if (name === "addText") {
    const item: FigureElement = { kind: "text", id: newElementId(figure), x: 12, y: 12, width: Math.min(160, figure.width - 24),
      runs: [{ text: t("Shared text") }], style: { ...figure.font } };
    figure.elements.push(item); selected = new Set([item.id]);
  } else if (name === "delete") {
    const rows = panelRows(figure).map((row) => row.filter((panel) => !selected.has(panel.id))).filter((row) => row.length);
    const weights = new Map(panelRows(figure).flat().map((panel, index) => [panel.id, figure.layout.weights[index] || visibleRatio(panel)]));
    figure.elements = figure.elements.filter((item) => !selected.has(item.id)); selected.clear();
    if (rowsMode()) { if (figure.layout.mode === "rows") { figure.layout.rows = rows.map((row) => row.length); figure.layout.weights = rows.flat().map((panel) => weights.get(panel.id)); } arrangePanels(figure, measureRun); }
  }
  else if (name === "duplicate") {
    const copies = structuredClone(selection());
    for (const item of copies) { item.id = newElementId(figure); item.x += 10; item.y += 10; }
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
  if (inlineEdit) {
    if (inlineEdit.part !== "label") { canvasText.focus(); document.execCommand(button.dataset.format); positionFormatBar(); }
    return;
  }
  node("rich-text").focus(); document.execCommand(button.dataset.format); flushText();
});
canvasText.addEventListener("blur", () => finishCanvasText(true));
canvasText.addEventListener("keydown", event => {
  // An IME uses Enter/Escape to accept or dismiss candidates before a draft can be finished.
  if (event.isComposing || event.keyCode === 229) { event.stopPropagation(); return; }
  if (event.key === "Escape" || event.key === "Enter" && (!event.shiftKey || inlineEdit?.part === "label")) {
    event.preventDefault(); event.stopPropagation(); finishCanvasText(event.key === "Enter"); board.focus({ preventScroll: true });
  } else if ((event.ctrlKey || event.metaKey) && ["z", "y"].includes(event.key.toLowerCase())) {
    event.stopPropagation(); // Keep undo inside the open draft until it becomes a figure edit.
  }
});
document.addEventListener("focusin", (event) => { if ((event.target as Element).closest("#rich-text")) editingText = true; });
document.addEventListener("input", (event) => {
  if ((event.target as Element).closest("#rich-text")) {
    if (textTimer) clearTimeout(textTimer);
    textTimer = setTimeout(flushText, 350);
  }
});
document.addEventListener("paste", (event) => {
  if (!(event.target as Element).closest("#rich-text,#canvas-text")) return;
  const text = event.clipboardData.getData("text/plain");
  event.preventDefault(); document.execCommand("insertText", false, inlineEdit?.part === "label" ? text.replace(/[\r\n]+/g, " ") : text);
});

/** Applies a physical geometry or typography change from the property inspector. */
function propertyChange(input: HTMLInputElement | HTMLSelectElement): void {
  const item = selection()[0];
  if (!item) return;
  const key = input.dataset.property, value = input.type === "number" ? Number(input.value) : input.value;
  if (key === "cjkFamily") item.style.cjkFamily = input.value.trim() || DEFAULT_CHINESE_FONT;
  else if (["family", "size", "color", "align"].includes(key)) (item.style as unknown as Record<string, unknown>)[key] = value;
  else if (key.startsWith("crop.") && item.kind === "panel") item.crop[key.split(".")[1] as keyof Panel["crop"]] = Number(value);
  else (item as unknown as Record<string, unknown>)[key] = value;
  if (rowsMode() && item.kind === "panel") arrangePanels(figure, measureRun);
  commit("Change element properties");
}

document.addEventListener("change", (event) => {
  const input = event.target as HTMLInputElement | HTMLSelectElement;
  if (cropping && !["zoom", "unit", "a4"].includes(input.id)) finishCrop();
  flushText(); editingText = false;
  if (input.dataset.property) { propertyChange(input); return; }
  const id = input.id;
  if (id === "unit") { unit = input.value; render(); return; }
  if (id === "a4") { a4 = (input as HTMLInputElement).checked; render(); fitCanvas(); return; }
  if (id === "zoom") { setZoom(Number(input.value) / 100); return; }
  if (id === "snap") return;
  if (id === "auto-renumber") { figure.autoRenumber = (input as HTMLInputElement).checked; commit("Change automatic numbering"); return; }
  if (id === "layout-mode") {
    figure.layout.mode = input.value as "panels" | "free";
    if (rowsMode()) arrangePanels(figure, measureRun);
    commit("Change layout mode"); return;
  }
  if (id === "embedded") { vscode.postMessage({ type: "embed", enabled: (input as HTMLInputElement).checked }); return; }
  if (id === "figure-width") { resizeFigure(figure, Number(input.value) * unitPoints(), measureRun); if (figure.layout.mode === "panels") arrangePanels(figure, measureRun); }
  else if (id === "figure-height") { figure.height = Number(input.value) * unitPoints(); figure.autoHeight = false; }
  else if (id === "auto-height") figure.autoHeight = (input as HTMLInputElement).checked;
  else if (id === "transparent") figure.background = (input as HTMLInputElement).checked ? "transparent" : "white";
  else if (id === "columns") { figure.layout.columns = Math.max(1, Math.floor(Number(input.value))); figure.layout.rows = []; }
  else if (id === "gap") figure.layout.gap = Number(input.value);
  else if (id === "row-gap") figure.layout.rowGap = Number(input.value);
  else if (id === "padding") figure.layout.padding = Number(input.value);
  else if (id === "rows" || id === "weights") figure.layout[id] = input.value.split(/[,\s]+/).filter(Boolean).map(Number);
  else if (id === "default-family") figure.font.family = input.value;
  else if (id === "default-cjk") figure.font.cjkFamily = input.value.trim() || DEFAULT_CHINESE_FONT;
  else if (id === "default-size") figure.font.size = Number(input.value);
  else return;
  if (rowsMode() && ["columns", "gap", "row-gap", "padding", "rows", "weights", "auto-height", "figure-height"].includes(id)) {
    if (["columns", "rows", "weights"].includes(id)) figure.layout.tree = treeFromRows(figure);
    arrangePanels(figure, measureRun);
  }
  commit("Change figure settings");
});

document.addEventListener("keydown", (event) => {
  if (cropping && (event.key === "Escape" || event.key === "Enter")) {
    event.preventDefault(); if (event.key === "Escape") cancelCrop(); else finishCrop(); return;
  }
  const target = event.target as HTMLElement, input = target.closest("input,textarea,select,[contenteditable=true]");
  const modifier = event.ctrlKey || event.metaKey;
  if (modifier && ["s", "z", "y"].includes(event.key.toLowerCase()) && (!input || event.key.toLowerCase() === "s")) {
    // The host forwards bubbling Webview keydowns even when defaultPrevented; send each handled command only once.
    event.preventDefault(); event.stopPropagation();
    action(event.key.toLowerCase() === "s" ? event.shiftKey ? "saveAs" : "save" : event.key.toLowerCase() === "y" || event.shiftKey ? "redo" : "undo"); return;
  }
  if (input) return;
  if (event.key === "Delete" || event.key === "Backspace") { event.preventDefault(); action("delete"); }
  else if (modifier && event.key.toLowerCase() === "a") { event.preventDefault(); selected = new Set(figure.elements.map((item) => item.id)); render(); }
  else if (modifier && event.key.toLowerCase() === "c") { event.preventDefault(); copied = structuredClone(selection()); }
  else if (modifier && event.key.toLowerCase() === "v") {
    event.preventDefault();
    const copies = structuredClone(copied);
    for (const item of copies) { item.id = newElementId(figure); item.x += 10; item.y += 10; }
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
  draggedId = (event.target as Element).closest<HTMLElement>("[data-select]")?.dataset.select;
  if (rowsMode() && figure.elements.some((item) => item.id === draggedId && item.kind === "panel")) beginDock(figure, new Set([draggedId]));
  event.dataTransfer.setData("text/plain", draggedId ?? "");
});
node("elements").addEventListener("dragover", (event) => event.preventDefault());
node("elements").addEventListener("dragend", endListDock);
/** Clears native list feedback even when a successful commit has removed the original HTML drag source. */
function endListDock(): void {
  draggedId = undefined; dockSession = undefined; document.getElementById("dock-marker").replaceChildren(); node("drop-hint").textContent = "";
}
node("elements").addEventListener("drop", (event) => {
  event.preventDefault(); event.stopPropagation();
  const id = (event.target as Element).closest<HTMLElement>("[data-select]")?.dataset.select;
  if (!draggedId || !id || draggedId === id) return;
  if (rowsMode() && figure.elements.find((element) => element.id === draggedId)?.kind === "panel" && figure.elements.find((element) => element.id === id)?.kind === "panel") {
    dockTreePanels(figure, new Set([draggedId]), { anchor: id, side: "left", scope: "panel" }, measureRun);
    endListDock(); commit("Reorganise panel rows"); return;
  }
  const index = figure.elements.findIndex((item) => item.id === draggedId), target = figure.elements.findIndex((item) => item.id === id);
  const [element] = figure.elements.splice(index, 1); figure.elements.splice(target, 0, element);
  endListDock(); commit("Reorder elements");
});
viewport.addEventListener("dragover", (event) => {
  event.preventDefault(); event.dataTransfer.dropEffect = draggedId ? "move" : "copy";
  if (draggedId && dockSession) previewDock(figurePoint(event));
});
viewport.addEventListener("dragleave", (event) => {
  const bounds = viewport.getBoundingClientRect();
  if (event.clientX >= bounds.left && event.clientX <= bounds.right && event.clientY >= bounds.top && event.clientY <= bounds.bottom) return;
  if (event.relatedTarget instanceof Node && viewport.contains(event.relatedTarget)) return;
  if (draggedId && dockSession) { dockSession.target = undefined; document.getElementById("dock-marker").replaceChildren(); node("drop-hint").textContent = ""; }
});
viewport.addEventListener("drop", async (event) => {
  event.preventDefault();
  if (draggedId) {
    const target = dockSession && previewDock(figurePoint(event)), ids = new Set([draggedId]);
    endListDock();
    if (target) { dockTreePanels(figure, ids, target, measureRun); commit("Reorganise panel rows"); }
    return;
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
  fitWidth = false;
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

/** Fits the paper width; the lower part of a portrait page remains accessible by scrolling. */
function fitCanvas(): void {
  fitWidth = true;
  const { width } = canvasGeometry(figure), style = getComputedStyle(viewport);
  const available = viewport.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
  if (available <= 0) return;
  zoom = Math.min(5, available / (width * 96 / 72));
  setValue("zoom", Math.round(zoom * 100)); renderCanvas();
  viewport.scrollLeft = 0;
}

// The split can finish resizing after the first host message. Preserve subsequent manual zoom.
new ResizeObserver(() => { if (fitWidth && revision >= 0 && !pointer) fitCanvas(); }).observe(viewport);

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
    if (same && (pointer || draggedId)) return;
    if (same && cropping) return;
    if (!same) {
      finishCanvasText(false);
      if (draggedId) endListDock();
      cropping = undefined; cropPointer = undefined; cropAnalysis = undefined; cropFeedback = "";
      if (pointer) clearDrag();
      figure = message.figure; lastValidFigure = structuredClone(figure); revision = message.revision;
      selected = new Set([...selected].filter((id) => figure.elements.some((element) => element.id === id)));
    }
    const ratioChanged = await loadImageRatios();
    if (pointer || cropping) return;
    if (ratioChanged) { if (initial || rowsMode()) arrangePanels(figure, measureRun); commit("Update image dimensions"); }
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

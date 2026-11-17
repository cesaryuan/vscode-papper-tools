/**
 * Runs the combination figure editor inside a VS Code Webview.
 *
 * Coordinates and typography stay in physical points; screen zoom and the A4
 * reference affect only the view. User gestures commit through the host so
 * VS Code can manage native undo, dirty state, Save As and draft recovery.
 */
import { A4, PT_PER_MM, createFigure, reflowFigure, resizeFigure, arrangePanels, alignElements,
  elementHeight, renumberPanels, newElementId, validateFigure,
  type FigureDocument, type FigureElement, type RichRun, type TextStyle, type Panel } from "./model";
import { serializeFigure, renderElement, escapeXml, decimal } from "./svg";
import type { EditorMessage, HostMessage } from "./protocol";

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
let pointer: { start: DOMPoint; original: FigureDocument; mode: "move" | "resize"; id: string; moved: boolean } | undefined;
let draggedId: string | undefined, editingText = false, textTimer: ReturnType<typeof setTimeout> | undefined;

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
  const marginX = a4 ? Math.max(0, (A4.width - figure.width) / 2) : 0;
  const marginY = a4 ? 22 * PT_PER_MM : 0;
  const width = a4 ? Math.max(A4.width, figure.width + 16) : figure.width;
  const height = a4 ? Math.max(A4.height, figure.height + marginY + 16) : figure.height;
  board.setAttribute("viewBox", `0 0 ${width} ${height}`);
  board.style.width = `${width * 96 / 72 * zoom}px`; board.style.height = `${height * 96 / 72 * zoom}px`;
  board.innerHTML = (a4 ? `<rect width="${A4.width}" height="${A4.height}" fill="white"/><text x="12" y="18" fill="#888" font-family="Arial" font-size="8">A4 · 210 × 297 mm</text>` : "")
    + `<g id="figure-group" transform="translate(${marginX} ${marginY})">`
    + `<rect width="${figure.width}" height="${figure.height}" fill="${figure.background === "white" ? "white" : "#f2f2f2"}" stroke="#999" stroke-dasharray="4 3" stroke-width=".6" data-figure-background="true"/>`
    + figure.elements.map((element) => renderElement(element, imageSource)).join("")
    + [...selection()].map((element) => `<rect class="selection" x="${element.x}" y="${element.y}" width="${element.width}" height="${elementHeight(element)}"/><rect class="resize" data-resize="${escapeXml(element.id)}" x="${element.x + element.width - 3}" y="${element.y + (element.kind === "panel" ? element.height : elementHeight(element)) - 3}" width="6" height="6"/>`).join("")
    + (!figure.elements.length ? `<text class="empty" x="${figure.width / 2}" y="${figure.height / 2}" text-anchor="middle">${escapeXml(t("Drop images here or choose Add images"))}</text>` : "") + "</g>";
  const w = decimal(figure.width / PT_PER_MM), h = decimal(figure.height / PT_PER_MM);
  node("status").textContent = t("{0} × {1} mm · {2} elements", w, h, figure.elements.length);
  node("paper-info").textContent = t("{0} mm wide · {1}% of A4 width", Number((figure.width / PT_PER_MM).toFixed(1)), Number((figure.width / A4.width * 100).toFixed(1)));
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
  node("elements").innerHTML = figure.elements.map((element) => `<button class="item${selected.has(element.id) ? " selected" : ""}" data-select="${escapeXml(element.id)}" draggable="true"><span class="badge">${element.kind === "panel" ? escapeXml(element.label ? `(${element.label})` : "▧") : "T"}</span><span class="name">${escapeXml(element.kind === "panel" ? element.name : element.runs.map((run) => run.text).join(""))}</span></button>`).join("");
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
  return `<label class="field"><span>${escapeXml(t(label))}</span><input data-property="${key}" type="${type}" value="${escapeXml(String(value))}"${type === "number" ? ' step=".5"' : ""}></label>`;
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
    + `<h3>${escapeXml(t(panel ? "Subcaption" : "Text"))}</h3><div class="tools">${[["bold", "B"], ["italic", "I"], ["superscript", "x²"], ["subscript", "x₂"], ["removeFormat", "Clear formatting"]].map(([command, label]) => `<button data-format="${command}" title="${escapeXml(t(label))}">${escapeXml(t(label))}</button>`).join("")}</div>`
    + `<div id="rich-text" class="rich" contenteditable="true" role="textbox" aria-label="${escapeXml(t(panel ? "Subcaption" : "Text"))}">${richHtml(panel ? panel.caption : (element as Extract<FigureElement, { kind: "text" }>).runs)}</div>`
    + (panel ? `<h3>${escapeXml(t("Crop (%)"))}</h3><div class="pair">${(["left", "top", "right", "bottom"] as const).map((edge) => field({ left: "Left", top: "Top", right: "Right", bottom: "Bottom" }[edge], `crop.${edge}`, panel.crop[edge])).join("")}</div><p class="muted">${escapeXml(t("Cropping changes only the visible area. The source image stays intact."))}</p><button data-action="openSource">${escapeXml(t("Open source image"))}</button>` : "");
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
function figurePoint(event: PointerEvent): DOMPoint {
  const group = document.getElementById("figure-group") as unknown as SVGGraphicsElement;
  return new DOMPoint(event.clientX, event.clientY).matrixTransform(group.getScreenCTM().inverse());
}

/** Snaps one coordinate to nearby edges/centres, using screen-independent physical tolerance. */
function snapCoordinate(value: number, candidates: number[]): number {
  if (!node<HTMLInputElement>("snap").checked) return value;
  const nearest = candidates.reduce((best, candidate) => Math.abs(candidate - value) < Math.abs(best - value) ? candidate : best, value + 4);
  return Math.abs(nearest - value) <= 3 ? nearest : value;
}

/** Moves all selected elements or resizes one panel while leaving type size unchanged. */
function pointerMove(event: PointerEvent): void {
  if (!pointer) return;
  const point = figurePoint(event), dx = point.x - pointer.start.x, dy = point.y - pointer.start.y;
  if (Math.abs(dx) + Math.abs(dy) < .3 && !pointer.moved) return;
  pointer.moved = true;
  figure = structuredClone(pointer.original);
  const elements = selection(), active = elements.find((item) => item.id === pointer.id);
  if (!active) return;
  if (pointer.mode === "resize") {
    active.width = Math.max(12, active.width + dx);
    if (active.kind === "panel") active.height = Math.max(12, active.height + dy);
  } else {
    const others = figure.elements.filter((item) => !selected.has(item.id));
    const xs = [0, figure.width / 2, figure.width, ...others.flatMap((item) => [item.x, item.x + item.width / 2, item.x + item.width])];
    const ys = [0, figure.height / 2, figure.height, ...others.flatMap((item) => [item.y, item.y + elementHeight(item) / 2, item.y + elementHeight(item)])];
    const moveX = Math.max(-Math.min(...elements.map((item) => item.x)), event.altKey ? dx : snapCoordinate(active.x + dx, xs) - active.x);
    const moveY = Math.max(-Math.min(...elements.map((item) => item.y)), event.altKey ? dy : snapCoordinate(active.y + dy, ys) - active.y);
    for (const element of elements) { element.x += moveX; element.y += moveY; }
  }
  reflowFigure(figure, measureRun); renderCanvas();
}

/** Commits a complete drag as one native history operation. */
function pointerEnd(): void {
  if (!pointer) return;
  const moved = pointer.moved;
  pointer = undefined;
  if (moved) commit("Move or resize elements");
}

board.addEventListener("pointerdown", (event) => {
  if (event.button !== 0) return;
  const target = event.target as Element, resize = target.closest("[data-resize]")?.getAttribute("data-resize");
  const id = resize ?? target.closest("[data-element-id]")?.getAttribute("data-element-id");
  if (!id) { select(); return; }
  if (!selected.has(id) || event.shiftKey) select(id, event.shiftKey);
  if (!selected.has(id)) return;
  event.preventDefault(); board.focus(); board.setPointerCapture(event.pointerId);
  pointer = { start: figurePoint(event), original: structuredClone(figure), mode: resize ? "resize" : "move", id, moved: false };
});
board.addEventListener("pointermove", pointerMove);
board.addEventListener("pointerup", pointerEnd);
board.addEventListener("pointercancel", () => { if (pointer) { figure = pointer.original; pointer = undefined; render(); } });

/** Executes a toolbar operation without hiding the current physical layout. */
function action(name: string): void {
  flushText(); editingText = false;
  if (["save", "saveAs", "undo", "redo", "addImages", "refresh"].includes(name)) { vscode.postMessage({ type: name } as EditorMessage); return; }
  if (name === "fit") { fitCanvas(); return; }
  if (name === "export") {
    const value = Number(node<HTMLInputElement>("dpi").value);
    if (Number.isFinite(value) && value > 0) vscode.postMessage({ type: "exportPng", dpi: value });
    return;
  }
  if (name === "openSource") { if (selection()[0]) vscode.postMessage({ type: "openSource", id: selection()[0].id }); return; }
  if (name === "arrange") { try { validateFigure(figure); arrangePanels(figure, measureRun); } catch (error) { notice(String(error)); return; } }
  else if (name === "renumber") renumberPanels(figure);
  else if (name === "addText") {
    const item: FigureElement = { kind: "text", id: newElementId(), x: 12, y: 12, width: Math.min(160, figure.width - 24),
      runs: [{ text: t("Shared text") }], style: { ...figure.font } };
    figure.elements.push(item); selected = new Set([item.id]);
  } else if (name === "delete") { figure.elements = figure.elements.filter((item) => !selected.has(item.id)); selected.clear(); }
  else if (name === "duplicate") {
    const copies = structuredClone(selection());
    for (const item of copies) { item.id = newElementId(); item.x += 10; item.y += 10; }
    figure.elements.push(...copies); selected = new Set(copies.map((item) => item.id));
  } else if (name === "applyFont") { for (const item of figure.elements) item.style = { ...figure.font }; }
  else if (name.startsWith("align:")) alignElements(selection(), name.split(":")[1]);
  else return;
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
  if (id === "embedded") { vscode.postMessage({ type: "embed", enabled: (input as HTMLInputElement).checked }); return; }
  if (id === "figure-width") resizeFigure(figure, Number(input.value) * unitPoints(), measureRun);
  else if (id === "figure-height") { figure.height = Number(input.value) * unitPoints(); figure.autoHeight = false; }
  else if (id === "auto-height") figure.autoHeight = (input as HTMLInputElement).checked;
  else if (id === "transparent") figure.background = (input as HTMLInputElement).checked ? "transparent" : "white";
  else if (id === "columns") figure.layout.columns = Math.max(1, Math.floor(Number(input.value)));
  else if (id === "gap") figure.layout.gap = Number(input.value);
  else if (id === "row-gap") figure.layout.rowGap = Number(input.value);
  else if (id === "padding") figure.layout.padding = Number(input.value);
  else if (id === "rows" || id === "weights") figure.layout[id] = input.value.split(/[,\s]+/).filter(Boolean).map(Number);
  else if (id === "default-family") figure.font.family = input.value;
  else if (id === "default-size") figure.font.size = Number(input.value);
  else return;
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
    figure.elements.push(...copies); selected = new Set(copies.map((item) => item.id)); commit("Paste elements");
  } else if (event.key === "Escape") select();
  else if (event.key.startsWith("Arrow") && selected.size) {
    event.preventDefault();
    const step = event.shiftKey ? 10 : 1;
    for (const item of selection()) { item.x += event.key === "ArrowRight" ? step : event.key === "ArrowLeft" ? -step : 0; item.y += event.key === "ArrowDown" ? step : event.key === "ArrowUp" ? -step : 0; }
    commit("Nudge elements");
  }
});

node("elements").addEventListener("dragstart", (event) => {
  draggedId = (event.target as Element).closest<HTMLElement>("[data-select]")?.dataset.select;
  event.dataTransfer.setData("text/plain", draggedId ?? "");
});
node("elements").addEventListener("dragover", (event) => event.preventDefault());
node("elements").addEventListener("drop", (event) => {
  event.preventDefault(); event.stopPropagation();
  const id = (event.target as Element).closest<HTMLElement>("[data-select]")?.dataset.select;
  if (!draggedId || !id || draggedId === id) return;
  const index = figure.elements.findIndex((item) => item.id === draggedId), target = figure.elements.findIndex((item) => item.id === id);
  const [element] = figure.elements.splice(index, 1); figure.elements.splice(target, 0, element);
  draggedId = undefined; commit("Reorder elements");
});
viewport.addEventListener("dragover", (event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; });
viewport.addEventListener("drop", async (event) => {
  event.preventDefault();
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
    sources = message.sources;
    if (!same) { figure = message.figure; lastValidFigure = structuredClone(figure); revision = message.revision; }
    const ratioChanged = await loadImageRatios();
    if (ratioChanged) { if (initial) arrangePanels(figure, measureRun); commit("Update image dimensions"); }
    else if (!same) {
      reflowFigure(figure, measureRun);
      vscode.postMessage({ type: "textLayout", lines: Object.fromEntries(figure.elements.map((item) => [item.id, item.lines])), height: figure.height });
      render();
    }
    else renderCanvas();
    if (initial) fitCanvas();
    if (message.failures.length) notice(message.failures.join("\n"));
  } catch (error) { notice(String(error)); }
});
vscode.postMessage({ type: "ready" });

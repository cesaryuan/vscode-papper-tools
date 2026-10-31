/**
 * DOCX PDF viewer entry point, bundled as dist/docx-preview.mjs.
 * Loads the packaged PDF.js worker through a blob permitted by Webview CSP,
 * prepares replacement documents before swapping the visible one, and draws
 * only a bounded window of pages. Saves zoom and page-relative scroll state
 * through the VS Code Webview API; no manuscript data leaves the Webview.
 */
import { getDocument, PDFWorker, type PDFDocumentLoadingTask, type PDFDocumentProxy, type PDFPageProxy, type RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import { configureLocalization, t } from "../localization.js";
import { normalizePreviewState, type HostMessage, type PreviewPosition, type PreviewState, type ViewerMessage } from "./protocol.js";

declare function acquireVsCodeApi(): { postMessage(message: ViewerMessage): void; getState(): Partial<PreviewState> | undefined; setState(state: PreviewState): void };
type PageSlot = { element: HTMLDivElement; width: number; height: number; top: number; canvas?: HTMLCanvasElement; scale?: number; page?: PDFPageProxy; task?: RenderTask; failed?: boolean };
type ZoomAnchor = { page: number; x: number; y: number; offsetX: number; offsetY: number };
type ViewerConfig = { source: string; worker: string; assets: string; localization: { messages: Record<string, string>; language: string } };

/** Owns the PDF lifecycle, bounded canvas window and stable page-relative viewport. */
class DocxPdfViewer {
  private readonly host = acquireVsCodeApi();
  private readonly config: ViewerConfig = JSON.parse(document.getElementById("preview-config")!.textContent!);
  private readonly viewport = document.getElementById("viewport")!;
  private readonly pagesElement = document.getElementById("pages")!;
  private readonly pageInput = document.getElementById("page") as HTMLInputElement;
  private readonly zoomInput = document.getElementById("zoom") as HTMLSelectElement;
  private state: PreviewState;
  private pdf?: PDFDocumentProxy;
  private loading?: PDFDocumentLoadingTask;
  private candidate?: PDFDocumentLoadingTask;
  private slots: PageSlot[] = [];
  private desired = new Set<number>();
  private revision = 0;
  private epoch = 0;
  private pumping = false;
  private frame = 0;
  private zoomFrame = 0;
  private pendingZoom?: number;
  private zoomTimer?: ReturnType<typeof setTimeout>;
  private resizeTimer?: ReturnType<typeof setTimeout>;
  private worker?: Worker;
  private pdfWorker?: PDFWorker;
  private workerUrl?: string;
  private disposed = false;

  /** Restores controls and registers events before asking the extension for a document. */
  constructor() {
    configureLocalization(this.config.localization.messages, this.config.localization.language);
    this.state = normalizePreviewState(this.host.getState(), this.config.source);
    document.getElementById("refresh")!.addEventListener("click", () => this.host.postMessage({ type: "refresh" }));
    document.getElementById("previous")!.addEventListener("click", () => this.goToPage(this.position().page - 1));
    document.getElementById("next")!.addEventListener("click", () => this.goToPage(this.position().page + 1));
    document.getElementById("zoom-in")!.addEventListener("click", () => this.zoomBy(1.2));
    document.getElementById("zoom-out")!.addEventListener("click", () => this.zoomBy(1 / 1.2));
    document.getElementById("actual")!.addEventListener("click", () => this.changeZoom(1));
    document.getElementById("fit")!.addEventListener("click", () => this.changeZoom("fit"));
    this.zoomInput.addEventListener("change", () => this.changeZoom(this.zoomInput.value === "fit" ? "fit" : Number(this.zoomInput.value)));
    this.pageInput.addEventListener("change", () => this.goToPage(this.pageInput.valueAsNumber));
    this.viewport.addEventListener("scroll", () => this.schedule(), { passive: true });
    this.viewport.addEventListener("wheel", event => this.onWheel(event), { passive: false });
    new ResizeObserver(() => {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.relayout(), 100);
    }).observe(this.viewport);
    window.addEventListener("message", (event: MessageEvent<HostMessage>) => {
      const message = event.data;
      if (message.type === "document") void this.load(message);
      else if (message.type === "invalidate") {
        // An edit may arrive while the next PDF is parsing or painting. Reject
        // that candidate while keeping the last fully displayed document alive.
        this.revision = Math.max(this.revision, message.revision);
        void this.candidate?.destroy().catch(() => {});
      }
      else if (message.type === "status") this.status(message.text, Boolean(message.failed), message.busy);
    });
    window.addEventListener("pagehide", () => this.dispose());
    this.updateControls();
    void this.initialize();
  }

  /** Starts the offline module worker; fetching a blob avoids Webview worker URL restrictions. */
  private async initialize(): Promise<void> {
    try {
      const response = await fetch(this.config.worker);
      if (!response.ok) throw new Error(`PDF worker HTTP ${response.status}`);
      const script = await response.text();
      if (this.disposed) return;
      this.workerUrl = URL.createObjectURL(new Blob([script], { type: "text/javascript" }));
      this.worker = new Worker(this.workerUrl, { type: "module" });
      // Explicit ownership keeps destroying an old PDF from destroying the replacement's shared worker.
      this.pdfWorker = PDFWorker.create({ port: this.worker });
      this.host.postMessage({ type: "ready" });
    } catch (error) {
      this.status(t("Could not start PDF viewer: {0}", String(error)), true, false);
      this.host.postMessage({ type: "log", message: String(error) });
    }
  }

  /** Loads all page geometries, then renders the retained anchor before replacing the last good document. */
  private async load(message: Extract<HostMessage, { type: "document" }>): Promise<void> {
    if (message.revision < this.revision) return;
    const revision = this.revision = message.revision;
    const task = getDocument({ url: message.url, worker: this.pdfWorker,
      cMapUrl: this.config.assets + "cmaps/", cMapPacked: true,
      standardFontDataUrl: this.config.assets + "standard_fonts/", wasmUrl: this.config.assets + "wasm/",
      iccUrl: this.config.assets + "iccs/" });
    const previousCandidate = this.candidate;
    this.candidate = task;
    void previousCandidate?.destroy().catch(() => {});
    try {
      const pdf = await task.promise;
      const sizes: Array<{ width: number; height: number }> = new Array(pdf.numPages);
      let cursor = 0;
      /** Reads page boxes without rasterizing the document; concurrency bounds worker requests. */
      const readSizes = async () => {
        while (cursor < pdf.numPages) {
          if (revision !== this.revision) throw new Error("Superseded PDF");
          const index = cursor++;
          const page = await pdf.getPage(index + 1);
          const box = page.getViewport({ scale: 1 });
          sizes[index] = { width: box.width, height: box.height };
        }
      };
      await Promise.all(Array.from({ length: Math.min(6, pdf.numPages) }, readSizes));
      if (revision !== this.revision) return;
      const state = normalizePreviewState({ ...this.state, position: this.pdf ? this.position() : this.state.position }, message.source, pdf.numPages);
      const scale = this.scale(sizes, state.zoom);
      const anchor = state.position.page - 1;
      const page = await pdf.getPage(anchor + 1);
      const canvas = await this.draw(page, scale);
      if (revision !== this.revision) { canvas.width = canvas.height = 0; return; }
      const oldTask = this.loading;
      this.epoch++;
      for (const slot of this.slots) this.release(slot);
      this.pdf = pdf;
      this.loading = task;
      this.candidate = undefined;
      this.state = state;
      this.desired.clear();
      this.slots = sizes.map(size => ({ ...size, top: 0, element: document.createElement("div") }));
      for (const [index, slot] of this.slots.entries()) {
        slot.element.className = "page";
        slot.element.setAttribute("aria-label", t("Page {0}", index + 1));
        const label = document.createElement("span");
        label.className = "page-label";
        label.textContent = t("Page {0}", index + 1);
        slot.element.append(label);
      }
      this.pagesElement.replaceChildren(...this.slots.map(slot => slot.element));
      this.slots[anchor].canvas = canvas;
      this.slots[anchor].scale = scale;
      this.slots[anchor].page = page;
      this.slots[anchor].element.append(canvas);
      this.layout();
      this.restore(state.position);
      this.pageInput.max = String(pdf.numPages);
      document.getElementById("total")!.textContent = String(pdf.numPages);
      // Cleanup failure cannot invalidate a replacement that has already been successfully painted.
      await oldTask?.destroy().catch(error => this.host.postMessage({ type: "log", message: `Old PDF cleanup: ${String(error)}` }));
      this.host.postMessage({ type: "loaded", revision });
      this.schedule();
    } catch (error) {
      if (revision === this.revision) {
        this.status(t("Could not display PDF: {0}", String(error)), true, false);
        this.host.postMessage({ type: "failed", revision, message: String(error) });
      }
    } finally {
      if (this.loading !== task) await task.destroy().catch(() => {});
      if (this.candidate === task) this.candidate = undefined;
    }
  }

  /** Computes fit width from the widest page so landscape sections do not overflow unexpectedly. */
  private scale(sizes: Array<{ width: number }>, zoom = this.state.zoom): number {
    return zoom === "fit" ? Math.max(0.1, (this.viewport.clientWidth - 32) / Math.max(1, ...sizes.map(size => size.width))) : zoom * 96 / 72;
  }

  /** Applies page dimensions while preserving lightweight placeholders for unpainted pages. */
  private layout(): void {
    const scale = this.scale(this.slots);
    let top = 16;
    for (const slot of this.slots) {
      slot.top = top;
      slot.element.style.width = `${slot.width * scale}px`;
      slot.element.style.height = `${slot.height * scale}px`;
      top += slot.height * scale + 16;
    }
    this.pagesElement.style.width = `${Math.max(this.viewport.clientWidth, ...this.slots.map(slot => slot.width * scale + 32))}px`;
    // At small zoom levels the last page can be shorter than the viewport.
    // Leave enough trailing space to align it at the top, otherwise a jump to
    // that page is clamped upward and immediately reports the preceding page.
    this.pagesElement.style.paddingBottom = `${Math.max(16, this.viewport.clientHeight - (this.slots.at(-1)?.height ?? 0) * scale)}px`;
    this.updateControls();
  }

  /** Keeps boundary buttons, mode feedback and a single temporary zoom option in sync. */
  private updateControls(commitPage = false): void {
    const loaded = this.slots.length > 0;
    const page = loaded ? this.position().page : 1;
    this.pageInput.disabled = !loaded;
    // Scroll and resize callbacks must not overwrite a page number being typed.
    if (commitPage || document.activeElement !== this.pageInput) this.pageInput.value = String(page);
    (document.getElementById("previous") as HTMLButtonElement).disabled = !loaded || page <= 1;
    (document.getElementById("next") as HTMLButtonElement).disabled = !loaded || page >= this.slots.length;
    const zoom = this.numericZoom();
    (document.getElementById("zoom-out") as HTMLButtonElement).disabled = !loaded || zoom <= 0.5;
    (document.getElementById("zoom-in") as HTMLButtonElement).disabled = !loaded || zoom >= 3;
    for (const id of ["actual", "fit"]) {
      const button = document.getElementById(id) as HTMLButtonElement;
      button.disabled = !loaded;
      button.setAttribute("aria-pressed", String(id === "fit" ? this.state.zoom === "fit" : this.state.zoom === 1));
    }
    this.zoomInput.disabled = !loaded;
    const value = String(this.state.zoom);
    // Wheel gestures produce arbitrary percentages; keep only the current custom
    // option so a long session cannot grow an unusably large zoom menu.
    const custom = this.zoomInput.querySelector<HTMLOptionElement>("[data-custom]");
    if (custom && custom.value !== value) custom.remove();
    if (![...this.zoomInput.options].some(option => option.value === value)) {
      const option = new Option(`${Math.round(zoom * 100)}%`, value);
      option.dataset.custom = "true";
      this.zoomInput.add(option);
    }
    this.zoomInput.value = value;
  }

  /** Finds the page at the top of the viewport and records a page-relative offset. */
  private position(): PreviewPosition {
    if (!this.slots.length) return this.state.position;
    const top = this.viewport.scrollTop;
    let index = this.slots.findIndex(slot => slot.top + slot.element.offsetHeight > top);
    if (index < 0) index = this.slots.length - 1;
    const slot = this.slots[index];
    return { page: index + 1, fraction: Math.max(0, Math.min(1, (top - slot.top) / Math.max(1, slot.element.offsetHeight))), horizontal: this.viewport.scrollLeft };
  }

  /** Restores the same physical page and proportional position after refresh or zoom. */
  private restore(position: PreviewPosition): void {
    const slot = this.slots[Math.min(this.slots.length, Math.max(1, position.page)) - 1];
    if (!slot) return;
    this.viewport.scrollTop = slot.top + position.fraction * slot.element.offsetHeight;
    this.viewport.scrollLeft = position.horizontal;
  }

  /** Coalesces viewport events and keeps at most eight nearby page bitmaps alive. */
  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      if (!this.pdf || !this.slots.length) return;
      const position = this.position();
      this.state.position = position;
      this.host.setState(this.state);
      this.updateControls();
      const first = position.page - 1;
      let last = first;
      while (last + 1 < this.slots.length && this.slots[last + 1].top < this.viewport.scrollTop + this.viewport.clientHeight) last++;
      this.desired = new Set<number>();
      for (let index = first; index <= Math.min(last + 1, first + 6, this.slots.length - 1); index++) this.desired.add(index);
      if (first > 0) this.desired.add(first - 1);
      for (const [index, slot] of this.slots.entries()) if (!this.desired.has(index)) this.release(slot);
      if (!this.zoomTimer) void this.pump();
    });
  }

  /** Paints one page at a time, rechecking visibility and document identity after each await. */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.pdf && !this.zoomTimer) {
        const scale = this.scale(this.slots);
        const index = [...this.desired].find(index => index < this.slots.length && (!this.slots[index].canvas || this.slots[index].scale !== scale) && !this.slots[index].failed);
        if (index === undefined) break;
        const slot = this.slots[index];
        const epoch = this.epoch;
        try {
          const page = await this.pdf.getPage(index + 1);
          if (epoch !== this.epoch || !this.desired.has(index)) continue;
          slot.page = page;
          const canvas = await this.draw(page, scale, slot);
          if (epoch !== this.epoch || !this.desired.has(index)) { canvas.width = canvas.height = 0; continue; }
          if (slot.canvas) { slot.canvas.remove(); slot.canvas.width = slot.canvas.height = 0; }
          slot.canvas = canvas;
          slot.scale = scale;
          slot.element.append(canvas);
        } catch (error) {
          if ((error as Error).name !== "RenderingCancelledException" && epoch === this.epoch) {
            slot.failed = true;
            this.host.postMessage({ type: "log", message: `Page ${index + 1}: ${String(error)}` });
            this.status(t("Could not render page {0}", index + 1), true, false);
          }
        } finally { slot.task = undefined; }
      }
    } finally { this.pumping = false; }
  }

  /** Draws a bounded HiDPI canvas; large zoom levels cannot allocate unbounded pixel surfaces. */
  private async draw(page: PDFPageProxy, scale: number, slot?: PageSlot): Promise<HTMLCanvasElement> {
    const viewport = page.getViewport({ scale });
    const ratio = Math.min(window.devicePixelRatio || 1, 2, Math.sqrt(8_000_000 / (viewport.width * viewport.height)));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width * ratio));
    canvas.height = Math.max(1, Math.floor(viewport.height * ratio));
    const task = page.render({ canvas, canvasContext: canvas.getContext("2d")!, viewport, transform: [ratio, 0, 0, ratio, 0, 0] });
    if (slot) slot.task = task;
    try { await task.promise; return canvas; }
    catch (error) { canvas.width = canvas.height = 0; throw error; }
  }

  /** Cancels offscreen work and releases its bitmap and page resources. */
  private release(slot: PageSlot): void {
    slot.task?.cancel();
    if (slot.canvas) { slot.canvas.remove(); slot.canvas.width = slot.canvas.height = 0; slot.canvas = undefined; }
    slot.page?.cleanup();
    slot.page = undefined;
  }

  /** Reflows page boxes after resize or zoom without losing the current page-relative location. */
  private relayout(anchor?: ZoomAnchor): void {
    if (!this.slots.length) return;
    const position = this.position();
    this.epoch++;
    // Retain the last bitmap while scaling; replacing it only after painting
    // avoids white-page flicker during consecutive wheel gestures or resizes.
    for (const slot of this.slots) { slot.task?.cancel(); slot.failed = false; }
    this.layout();
    if (anchor) {
      const slot = this.slots[anchor.page];
      this.viewport.scrollTop = slot.top + anchor.y * slot.element.offsetHeight - anchor.offsetY;
      this.viewport.scrollLeft = slot.element.offsetLeft + anchor.x * slot.element.offsetWidth - anchor.offsetX;
    } else this.restore(position);
    this.updateControls();
    this.schedule();
  }

  /** Applies a bounded numeric zoom or width-fit mode while preserving the viewport anchor. */
  private changeZoom(zoom: number | "fit", point?: { x: number; y: number }): void {
    if (!this.slots.length) return;
    const next = zoom === "fit" ? "fit" : Math.min(3, Math.max(0.5, Number.isFinite(zoom) ? zoom : 1));
    if (next === this.state.zoom) return;
    const anchor = point ? this.zoomAnchor(point.x, point.y) : undefined;
    this.state.zoom = next;
    this.relayout(anchor);
  }

  /** Resolves width-fit mode to the same percentage used by image preview zoom steps. */
  private numericZoom(): number {
    return this.state.zoom === "fit" ? this.scale(this.slots) * 72 / 96 : this.state.zoom;
  }

  /** Steps toolbar zoom multiplicatively, matching the image preview interaction. */
  private zoomBy(factor: number): void {
    this.changeZoom(this.numericZoom() * factor);
  }

  /** Captures the page point under the pointer, including horizontal page centering. */
  private zoomAnchor(clientX: number, clientY: number): ZoomAnchor {
    const viewport = this.viewport.getBoundingClientRect();
    const offsetX = clientX - viewport.left;
    const offsetY = clientY - viewport.top;
    const top = this.viewport.scrollTop + offsetY;
    let page = this.slots.findIndex(slot => slot.top + slot.element.offsetHeight > top);
    if (page < 0) page = this.slots.length - 1;
    const slot = this.slots[page];
    return { page, offsetX, offsetY,
      x: (this.viewport.scrollLeft + offsetX - slot.element.offsetLeft) / Math.max(1, slot.element.offsetWidth),
      y: (top - slot.top) / Math.max(1, slot.element.offsetHeight) };
  }

  /** Reserves Ctrl-wheel for document zoom, coalescing layout and delaying expensive rasterization. */
  private onWheel(event: WheelEvent): void {
    if (!event.ctrlKey) return;
    event.preventDefault();
    if (!this.slots.length || event.deltaY === 0) return;
    this.pendingZoom = Math.min(3, Math.max(0.5, (this.pendingZoom ?? this.numericZoom()) * (event.deltaY < 0 ? 1.2 : 1 / 1.2)));
    clearTimeout(this.zoomTimer);
    this.zoomTimer = setTimeout(() => { this.zoomTimer = undefined; this.schedule(); }, 120);
    if (this.zoomFrame) cancelAnimationFrame(this.zoomFrame);
    this.zoomFrame = requestAnimationFrame(() => {
      this.zoomFrame = 0;
      const zoom = this.pendingZoom!;
      this.pendingZoom = undefined;
      this.changeZoom(zoom, { x: event.clientX, y: event.clientY });
    });
  }

  /** Navigates to an existing physical page and leaves out-of-range input clamped. */
  private goToPage(page: number): void {
    if (!this.slots.length) return;
    if (!Number.isFinite(page)) { this.updateControls(true); return; }
    this.restore({ page: Math.max(1, Math.min(this.slots.length, Math.floor(page))), fraction: 0, horizontal: this.viewport.scrollLeft });
    this.updateControls(true);
    this.schedule();
  }

  /** Updates accessible progress text while retaining the last successfully displayed pages. */
  private status(text: string, failed: boolean, busy: boolean): void {
    const status = document.getElementById("status")!;
    status.textContent = text;
    status.title = text;
    document.getElementById("status-group")!.classList.toggle("error", failed);
    document.getElementById("status-group")!.classList.toggle("busy", busy);
    status.setAttribute("aria-busy", String(busy));
  }

  /** Releases this Webview's tasks, worker and blob URL when its document is unloaded. */
  private dispose(): void {
    this.disposed = true;
    this.revision++;
    this.epoch++;
    this.pdf = undefined;
    cancelAnimationFrame(this.frame);
    cancelAnimationFrame(this.zoomFrame);
    clearTimeout(this.resizeTimer);
    clearTimeout(this.zoomTimer);
    for (const slot of this.slots) this.release(slot);
    void this.candidate?.destroy().catch(() => {});
    void this.loading?.destroy().catch(() => {});
    this.worker?.terminate();
    this.pdfWorker?.destroy();
    if (this.workerUrl) URL.revokeObjectURL(this.workerUrl);
  }
}

new DocxPdfViewer();

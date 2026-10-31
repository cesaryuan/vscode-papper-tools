import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { t } from "../localization";
import { findPandocManuscriptProject, preparePapperEnvironment, resolvePapperExecutable } from "../papperBuildUtils";
import { isBuildableMarkdownDocument } from "../vscodeUtils";
import { buildDocxPreview, PapperPreviewService, removePreviewDirectory, type PreviewArtifact } from "./build";
import { buildDocxPreviewHtml } from "./html";
import type { HostMessage, ViewerMessage } from "./protocol";

/** Owns independent experimental DOCX preview panels without changing HTML preview behavior. */
export class DocxPreviewController implements vscode.Disposable {
  private readonly sessions = new Map<string, DocxPreviewSession>();

  /** Shares packaged viewer assets and the existing Papper output channel. */
  constructor(private readonly extensionUri: vscode.Uri, private readonly output: vscode.OutputChannel) {}

  /** Opens the selected source using its current buffer, including inactive editor title actions. */
  async open(uri?: vscode.Uri): Promise<void> {
    const document = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
    if (!document || !isBuildableMarkdownDocument(document)) {
      void vscode.window.showWarningMessage(t("Open a saved Markdown file before starting DOCX preview"));
      return;
    }
    if (!vscode.workspace.isTrusted) {
      void vscode.window.showWarningMessage(t("Trust this workspace before building DOCX preview"));
      return;
    }
    const key = document.uri.toString();
    let session = this.sessions.get(key);
    if (!session) {
      session = new DocxPreviewSession(this.extensionUri, document.uri, this.output, () => this.sessions.delete(key));
      this.sessions.set(key, session);
    }
    session.panel.reveal(vscode.ViewColumn.Beside, true);
    await session.refresh();
  }

  /** Refreshes only an already-open source after save when enabled. */
  onSaved(document: vscode.TextDocument): void {
    const session = this.sessions.get(document.uri.toString());
    if (session && vscode.workspace.getConfiguration("pandocManuscriptTools", document.uri).get("docxPreview.refreshOnSave", true)) {
      session.onSaved();
    }
  }

  /** Debounces actual edits to an open preview without saving the user's buffer. */
  onChanged(document: vscode.TextDocument): void {
    if (vscode.workspace.getConfiguration("pandocManuscriptTools", document.uri).get("docxPreview.refreshOnEdit", true)) {
      this.sessions.get(document.uri.toString())?.onChanged();
    }
  }

  /** Closes all owned panels and cancels their native child processes. */
  dispose(): void { for (const session of [...this.sessions.values()]) session.panel.dispose(); }
}

/** Coalesces editor snapshots and retains the last PDF until its replacement is displayed. */
class DocxPreviewSession {
  readonly panel: vscode.WebviewPanel;
  private readonly directory = path.join(os.tmpdir(), `pmt-docx-preview-${crypto.randomUUID()}`);
  private readonly cancellation = new AbortController();
  private readonly service = new PapperPreviewService();
  private readonly ready: Promise<boolean>;
  private signalReady!: (ready: boolean) => void;
  private readyTimer: NodeJS.Timeout;
  private revision = 0;
  private pending?: { revision: number };
  private running?: Promise<void>;
  private editTimer?: NodeJS.Timeout;
  private disposed = false;
  private artifact?: PreviewArtifact;
  private delivery?: { revision: number; resolve(success: boolean): void };

  /** Creates a source-bound panel and a private temporary root available through VS Code resource URIs. */
  constructor(extensionUri: vscode.Uri, private readonly source: vscode.Uri, private readonly output: vscode.OutputChannel, onDisposed: () => void) {
    this.panel = vscode.window.createWebviewPanel("pandocManuscriptTools.docxPreview",
      t("{0} — DOCX Preview (Experimental)", path.basename(source.fsPath)), vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, "dist"), vscode.Uri.file(this.directory)] });
    this.ready = new Promise(resolve => { this.signalReady = resolve; });
    this.readyTimer = setTimeout(() => this.signalReady(false), 20_000);
    this.panel.webview.onDidReceiveMessage((message: ViewerMessage) => this.onMessage(message));
    this.panel.onDidDispose(() => {
      this.disposed = true;
      this.pending = undefined;
      this.cancellation.abort();
      const stopped = this.service.dispose();
      clearTimeout(this.editTimer);
      clearTimeout(this.readyTimer);
      this.signalReady(false);
      this.delivery?.resolve(false);
      onDisposed();
      // Wait until native children exit before deleting their temporary input/output files.
      void Promise.allSettled([this.running, stopped]).then(() => this.cleanup()).catch(error => this.output.appendLine(`[DOCX preview] Cleanup failed: ${String(error)}`));
    });
    this.panel.webview.html = buildDocxPreviewHtml(this.panel.webview, extensionUri, source.toString());
  }

  /** Coalesces repeated refresh requests so an older conversion cannot overwrite a newer save. */
  refresh(): Promise<void> {
    if (this.disposed) return Promise.resolve();
    clearTimeout(this.editTimer);
    this.pending = { revision: ++this.revision };
    this.send({ type: "invalidate", revision: this.revision });
    // PDF.js suppresses acknowledgements for invalidated candidates; release
    // the host wait as well so a save during PDF loading cannot stall for 60s.
    this.delivery?.resolve(false);
    if (!this.running) {
      this.running = this.drain().finally(() => { this.running = undefined; });
    }
    return this.running;
  }

  /** Flushes a pending edit debounce immediately on save. */
  onSaved(): void { void this.refresh(); }

  /** Invalidate an in-flight snapshot immediately, then queue only the latest settled edit. */
  onChanged(): void {
    if (this.disposed) return;
    ++this.revision;
    this.send({ type: "invalidate", revision: this.revision });
    this.pending = undefined;
    this.delivery?.resolve(false);
    clearTimeout(this.editTimer);
    const configured = vscode.workspace.getConfiguration("pandocManuscriptTools", this.source).get("docxPreview.editDelay", 700);
    const delay = Number.isFinite(configured) ? Math.min(5000, Math.max(250, configured)) : 700;
    this.editTimer = setTimeout(() => { void this.refresh(); }, delay);
  }

  /** Handles only known viewer messages and acknowledges the exact published PDF revision. */
  private onMessage(message: ViewerMessage): void {
    if (this.disposed || !message || typeof message.type !== "string") return;
    if (message.type === "ready") { clearTimeout(this.readyTimer); this.signalReady(true); }
    else if (message.type === "refresh") void this.refresh();
    else if ((message.type === "loaded" || message.type === "failed") && this.delivery?.revision === message.revision) {
      if (message.type === "failed") this.output.appendLine(`[DOCX preview] PDF viewer: ${message.message}`);
      this.delivery.resolve(message.type === "loaded");
    } else if (message.type === "log") this.output.appendLine(`[DOCX preview] Viewer: ${String(message.message).slice(0, 2000)}`);
  }

  /** Builds current unsaved snapshots and publishes only current, successfully displayed artifacts. */
  private async drain(): Promise<void> {
    while (this.pending && !this.disposed) {
      const request = this.pending;
      this.pending = undefined;
      let next: PreviewArtifact | undefined;
      try {
        if (!vscode.workspace.isTrusted) throw new Error(t("Trust this workspace before building DOCX preview"));
        if (!await this.ready) throw new Error(t("PDF viewer did not start. See the Papper Tools output"));
        const document = await vscode.workspace.openTextDocument(this.source);
        if (!this.isCurrent(request.revision)) continue;
        this.send({ type: "status", text: t("Building DOCX preview…"), busy: true });
        const project = await findPandocManuscriptProject(this.source);
        const papper = await resolvePapperExecutable(this.output);
        const environment = await preparePapperEnvironment(papper);
        if (!this.isCurrent(request.revision)) continue;
        this.output.appendLine(`[DOCX preview] Building buffer ${this.source.fsPath}; embedded PDF renderer`);
        next = await buildDocxPreview({ source: this.source.fsPath, project: project.rootUri.fsPath, directory: this.directory,
          sourceText: document.getText(), service: this.service,
          papper, env: environment.env, signal: this.cancellation.signal, output: this.output });
        if (!this.isCurrent(request.revision)) continue;
        this.send({ type: "status", text: t("Displaying DOCX preview…"), busy: true });
        const displayed = await this.publish(next, request.revision);
        if (displayed && this.isCurrent(request.revision)) {
          const previous = this.artifact;
          this.artifact = next;
          next = undefined;
          if (previous) await removePreviewDirectory(this.directory, previous.directory);
          this.output.appendLine(`[DOCX preview] DOCX=${this.artifact.buildMs.toFixed(0)} ms; PDF=${this.artifact.conversionMs.toFixed(0)} ms`);
          if (this.isCurrent(request.revision)) this.send({ type: "status", text: t("DOCX preview updated"), busy: false });
        } else if (this.isCurrent(request.revision)) throw new Error(t("Could not display the new PDF. The previous preview is retained"));
      } catch (error) {
        if (this.isCurrent(request.revision)) {
          const message = t("DOCX preview failed: {0}", error instanceof Error ? error.message : String(error));
          this.output.appendLine(`[DOCX preview] ${message}`);
          this.send({ type: "status", text: message, busy: false, failed: true });
        }
      } finally {
        if (next) await removePreviewDirectory(this.directory, next.directory).catch(error => this.output.appendLine(`[DOCX preview] Could not remove obsolete build: ${String(error)}`));
      }
    }
  }

  /** Holds the candidate file until PDF.js has loaded and painted its first visible page. */
  private async publish(artifact: PreviewArtifact, revision: number): Promise<boolean> {
    let timer: NodeJS.Timeout;
    const result = new Promise<boolean>(resolve => {
      this.delivery = { revision, resolve };
      timer = setTimeout(() => resolve(false), 60_000);
    });
    try {
      const accepted = await this.panel.webview.postMessage({ type: "document", revision, source: this.source.toString(),
        url: this.panel.webview.asWebviewUri(vscode.Uri.file(artifact.pdf)).toString() } satisfies HostMessage);
      if (!accepted) this.delivery?.resolve(false);
      return await result;
    } finally {
      // A Webview can close while posting; never leave its acknowledgement timer alive.
      clearTimeout(timer!);
      this.delivery = undefined;
    }
  }

  /** Rejects results from a closed panel or a build superseded by a newer explicit refresh. */
  private isCurrent(revision: number): boolean { return !this.disposed && revision === this.revision; }

  /** Posts progress without replacing the loaded viewer document or its scroll state. */
  private send(message: HostMessage): void {
    if (!this.disposed) void Promise.resolve(this.panel.webview.postMessage(message))
      .catch(error => this.output.appendLine(`[DOCX preview] Could not update viewer status: ${String(error)}`));
  }

  /** Removes only this session's generated directory after conversion and resource delivery finish. */
  private async cleanup(): Promise<void> {
    await removePreviewDirectory(os.tmpdir(), this.directory);
  }
}

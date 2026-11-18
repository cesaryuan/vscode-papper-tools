/** VS Code custom-document entry point for creating, saving and restoring editable combination figures. */
import * as vscode from "vscode";
import * as path from "path";
import { createFigure, createPanel, arrangePanels, validateFigure, type FigureDocument, type Panel } from "./model";
import { syncPanelTree } from "./panelTree";
import { parseFigureSvg } from "./document";
import { serializeFigure } from "./svg";
import { absoluteAsset, figureAssets, hydrateFigure, portableFigure, setEmbedded, IMAGE_TYPES } from "./assets";
import { conversionEdits, importMarkdownGroup, markdownImagePath, type ImportedGroup } from "./markdown";
import { buildSubfigureHtml } from "./html";
import type { EditorMessage } from "./protocol";
import { findImageTokenAtPosition } from "../imagePreview/imageTokenParser";
import { t } from "../localization";
import { setPngDpi } from "./png";
import { SubfigureHoverProvider } from "./hover";
import { PANDOC_SELECTOR } from "../constants";

export const SUBFIGURE_EDITOR = "pandocManuscriptTools.subfigureEditor";
export const NEW_SUBFIGURE = "pandocManuscriptTools.newSubfigure";
export const EDIT_SUBFIGURE = "pandocManuscriptTools.editSubfigure";
export const CONVERT_SUBFIGURE = "pandocManuscriptTools.convertSubfigure";
type ManuscriptTarget = { uri: string; group?: ImportedGroup; offset?: number; original?: string };
type Draft = { figure: FigureDocument; directory: string; manuscript?: ManuscriptTarget; diskSource?: string };

/** Holds editable state while VS Code owns dirty tracking, history and hot-exit backups. */
export class FigureEditorDocument implements vscode.CustomDocument {
  revision = 0;
  readonly panels = new Set<vscode.WebviewPanel>();
  saved: FigureDocument;
  sources: Awaited<ReturnType<typeof figureAssets>> | undefined;
  diskSource: string | undefined;
  undoDepth = 0;
  redoDepth = 0;
  private sourceKey = "";
  /** Keeps absolute source paths in the editing session and rebases them only when writing SVG. */
  constructor(readonly uri: vscode.Uri, public figure: FigureDocument, public directory: string, public manuscript?: ManuscriptTarget) {
    this.saved = structuredClone(figure);
  }
  /** Releases webview references when VS Code closes the document. */
  dispose(): void { this.panels.clear(); }
  /** Reuses large full-quality asset data across geometry-only edits. */
  async assets(): Promise<Awaited<ReturnType<typeof figureAssets>>> {
    const key = this.figure.elements.filter((element): element is Panel => element.kind === "panel").map((panel) => panel.source).join("\0");
    if (!this.sources || this.sourceKey !== key) { this.sources = await figureAssets(this.figure); this.sourceKey = key; }
    return this.sources;
  }
}

/** Integrates commands, editable SVG documents, manuscript conversion and export with VS Code. */
export class SubfigureEditorController implements vscode.CustomEditorProvider<FigureEditorDocument>, vscode.Disposable {
  private readonly changes = new vscode.EventEmitter<vscode.CustomDocumentEditEvent<FigureEditorDocument>>();
  readonly onDidChangeCustomDocument = this.changes.event;
  private readonly drafts = new Map<string, Draft>();
  private readonly documents = new Set<FigureEditorDocument>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pendingPng = new Map<FigureEditorDocument, { destination: vscode.Uri; dpi: number }>();

  /** Registers explicit editing entry points so normal SVG preview remains available. */
  constructor(private readonly context: vscode.ExtensionContext, private readonly output: vscode.OutputChannel) {
    this.disposables.push(vscode.window.registerCustomEditorProvider(SUBFIGURE_EDITOR, this, { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }));
    this.disposables.push(vscode.commands.registerCommand(NEW_SUBFIGURE, (uri?: vscode.Uri, selected?: vscode.Uri[]) => this.run(() => this.create(uri, selected))));
    this.disposables.push(vscode.commands.registerCommand(EDIT_SUBFIGURE, (uri?: vscode.Uri) => this.run(() => this.edit(uri))));
    this.disposables.push(vscode.commands.registerCommand(CONVERT_SUBFIGURE, (uri?: string, offset?: number, version?: number) => this.run(() => this.convert(uri, offset, version))));
    this.disposables.push(vscode.languages.registerHoverProvider(PANDOC_SELECTOR, new SubfigureHoverProvider(CONVERT_SUBFIGURE)));
    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    /** Invalidates only documents that reference the changed image, preserving manual geometry. */
    const changed = (uri: vscode.Uri): void => {
      for (const document of this.documents) if (document.figure.elements.some((element) => element.kind === "panel" && element.source === uri.fsPath)) {
        document.sources = undefined;
        void this.sendState(document).catch((error) => this.output.appendLine(`[subfigure] Asset refresh failed: ${error}`));
      }
    };
    this.disposables.push(watcher, watcher.onDidChange(changed), watcher.onDidCreate(changed), watcher.onDidDelete(changed));
  }

  /** Reports actionable errors once while retaining failed edits for correction. */
  private async run(operation: () => Promise<unknown>): Promise<void> {
    try { await operation(); }
    catch (error) { this.output.appendLine(`[subfigure] ${error}`); await vscode.window.showErrorMessage(t("Combination figure: {0}", error instanceof Error ? error.message : String(error))); }
  }

  /** Creates an unsaved figure from selected resources or the current manuscript insertion point. */
  private async create(uri?: vscode.Uri, selected?: vscode.Uri[]): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const manuscript = !uri && editor && ["markdown", "mdx"].includes(editor.document.languageId) && editor.document.uri.scheme === "file"
      ? { uri: editor.document.uri.toString(), offset: editor.document.offsetAt(editor.selection.active), original: editor.document.getText() } : undefined;
    const directory = uri ? ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory ? uri.fsPath : path.dirname(uri.fsPath))
      : manuscript ? path.dirname(editor.document.uri.fsPath) : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!directory) throw new Error("Open a manuscript folder before creating a combination figure");
    const figure = createFigure();
    const images = (selected?.length ? selected : uri ? [uri] : []).filter((item) => IMAGE_TYPES[path.extname(item.fsPath).toLowerCase()]);
    for (const image of images) figure.elements.push(createPanel(figure, image.fsPath, path.basename(image.fsPath)));
    arrangePanels(figure);
    await this.openDraft({ figure, directory, manuscript });
  }

  /** Opens only a recognized combination SVG, including an image referenced at the Markdown cursor. */
  private async edit(uri?: vscode.Uri): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!uri && editor && ["markdown", "mdx"].includes(editor.document.languageId)) {
      const image = findImageTokenAtPosition(editor.document, editor.selection.active);
      if (image?.extension === ".svg") uri = vscode.Uri.file(absoluteAsset(image.target, path.dirname(editor.document.uri.fsPath)));
    }
    uri ??= editor?.document.uri;
    if (!uri || path.extname(uri.path).toLowerCase() !== ".svg") throw new Error("Select a combination SVG or place the cursor on its Markdown image");
    parseFigureSvg(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8"));
    await vscode.commands.executeCommand("vscode.openWith", uri, SUBFIGURE_EDITOR);
  }

  /** Imports a source group as a draft, leaving the manuscript untouched until first save. */
  private async convert(uri?: string, offset?: number, version?: number): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const document = uri ? await vscode.workspace.openTextDocument(vscode.Uri.parse(uri)) : editor?.document;
    if (!document || document.uri.scheme !== "file") throw new Error("Open a saved Markdown manuscript first");
    if (version !== undefined && document.version !== version) throw new Error("The manuscript changed; hover over the subfigure again");
    const group = importMarkdownGroup(document.getText(), offset ?? document.offsetAt(editor.selection.active));
    const directory = path.dirname(document.uri.fsPath);
    const figure = hydrateFigure(group.figure, directory);
    await this.openDraft({ figure, directory, manuscript: { uri: document.uri.toString(), group } });
  }

  /** Associates an untitled custom document with recoverable draft state, without creating a disk file. */
  private async openDraft(draft: Draft): Promise<void> {
    const uri = vscode.Uri.file(path.join(draft.directory, `combination-${Date.now()}.svg`)).with({ scheme: "untitled" });
    this.drafts.set(uri.toString(), draft);
    await vscode.commands.executeCommand("vscode.openWith", uri, SUBFIGURE_EDITOR);
  }

  /** Restores a hot-exit backup, a pending draft, or an existing SVG layout. */
  async openCustomDocument(uri: vscode.Uri, context: vscode.CustomDocumentOpenContext): Promise<FigureEditorDocument> {
    let draft: Draft;
    let diskSource: string | undefined;
    if (context.backupId) draft = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(vscode.Uri.parse(context.backupId))).toString("utf8"));
    else if (this.drafts.has(uri.toString())) { draft = this.drafts.get(uri.toString()); this.drafts.delete(uri.toString()); }
    else {
      const directory = path.dirname(uri.fsPath);
      const bytes = context.untitledDocumentData ?? await vscode.workspace.fs.readFile(uri);
      diskSource = Buffer.from(bytes).toString("utf8");
      draft = { figure: hydrateFigure(parseFigureSvg(Buffer.from(bytes).toString("utf8")), directory) , directory };
    }
    validateFigure(draft.figure);
    const document = new FigureEditorDocument(uri, draft.figure, draft.directory, draft.manuscript);
    document.diskSource = draft.diskSource ?? diskSource;
    this.documents.add(document);
    return document;
  }

  /** Wires a CSP-restricted browser editor to serialized document mutations and native history. */
  async resolveCustomEditor(document: FigureEditorDocument, panel: vscode.WebviewPanel): Promise<void> {
    document.panels.add(panel);
    panel.webview.options = { enableScripts: true, localResourceRoots: [this.context.extensionUri] };
    panel.webview.html = buildSubfigureHtml(panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "subfigure-editor.js")).toString(), panel.webview.cspSource,
      panel.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, "dist", "codicons", "codicon.css")).toString());
    let queue = Promise.resolve();
    const messages = panel.webview.onDidReceiveMessage((message: EditorMessage) => {
      queue = queue.then(() => this.handleMessage(document, panel, message)).catch(async (error) => {
        this.output.appendLine(`[subfigure] ${error}`);
        await panel.webview.postMessage({ type: "error", message: t("Combination figure: {0}", error instanceof Error ? error.message : String(error)) });
      });
    });
    panel.onDidDispose(() => { messages.dispose(); document.panels.delete(panel); if (!document.panels.size) this.documents.delete(document); });
  }

  /** Applies one user gesture as one native undo step, rather than logging every pointer movement. */
  private change(document: FigureEditorDocument, figure: FigureDocument, label: string, initial = false): void {
    validateFigure(figure);
    const before = structuredClone(document.figure), after = structuredClone(figure);
    // Acknowledge an optimistic client revision even when this edit has no visible effect.
    if (!initial && JSON.stringify(before) === JSON.stringify(after)) { document.revision++; return; }
    document.figure = after; document.revision++;
    if (!initial) { document.undoDepth++; document.redoDepth = 0; }
    /** Replays a history snapshot and refreshes every view of the document. */
    const restore = async (value: FigureDocument): Promise<void> => { document.figure = structuredClone(value); document.revision++; await this.sendState(document); };
    this.changes.fire({ document, label,
      undo: async () => { if (!initial) { document.undoDepth--; document.redoDepth++; } await restore(before); },
      redo: async () => { if (!initial) { document.undoDepth++; document.redoDepth--; } await restore(after); } });
  }

  /** Sends complete layout state with cached, full-quality images after a committed operation. */
  private async sendState(document: FigureEditorDocument): Promise<void> {
    const assets = await document.assets();
    await Promise.all([...document.panels].map((panel) => panel.webview.postMessage({ type: "state", figure: document.figure,
      revision: document.revision, canUndo: document.undoDepth > 0, canRedo: document.redoDepth > 0, ...assets })));
  }

  /** Adds local or dropped embedded images while preserving an already edited layout. */
  private async addImages(document: FigureEditorDocument, images: Array<{ source: string; name: string }>): Promise<void> {
    const figure = structuredClone(document.figure);
    const initial = figure.elements.length === 0;
    for (const image of images) {
      const panel = createPanel(figure, image.source, image.name);
      if (!initial) { panel.x = 12 + figure.elements.length * 4; panel.y = 12 + figure.elements.length * 4; }
      figure.elements.push(panel);
    }
    if (initial || figure.layout.mode === "rows" || figure.layout.mode === "panels") arrangePanels(figure);
    else if (figure.layout.tree) syncPanelTree(figure);
    const result = figure.embedded ? await setEmbedded(figure, true) : figure;
    this.change(document, result, t("Add images"));
    await this.sendState(document);
  }

  /** Handles the narrow message protocol, retaining host ownership of files and undo. */
  private async handleMessage(document: FigureEditorDocument, panel: vscode.WebviewPanel, message: EditorMessage): Promise<void> {
    if (message.type === "ready") {
      // An untouched untitled draft must still prompt for saving when it is closed.
      if (document.uri.scheme === "untitled" && document.revision === 0) this.change(document, document.figure, t("Create combination figure"), true);
      await this.sendState(document);
    } else if (message.type === "change") {
      if (message.revision !== document.revision) { await this.sendState(document); return; }
      this.change(document, message.figure, message.label);
      await this.sendState(document);
    } else if (message.type === "textLayout") {
      for (const element of document.figure.elements) if (message.lines[element.id]) element.lines = message.lines[element.id];
      if (document.figure.autoHeight && Number.isFinite(message.height) && message.height > 0) document.figure.height = message.height;
    } else if (message.type === "save") await vscode.commands.executeCommand("workbench.action.files.save");
    else if (message.type === "saveAs") await vscode.commands.executeCommand("workbench.action.files.saveAs");
    else if (message.type === "undo" || message.type === "redo") {
      // Toolbar focus can leave a different editor as the command target; keep VS Code's native stack.
      if (!panel.active) panel.reveal(panel.viewColumn);
      await vscode.commands.executeCommand(message.type);
    }
    else if (message.type === "refresh") { document.sources = undefined; await this.sendState(document); }
    else if (message.type === "embed") {
      this.change(document, await setEmbedded(document.figure, message.enabled), t("Change image storage"));
      await this.sendState(document);
    } else if (message.type === "addImages") {
      const uris = await vscode.window.showOpenDialog({ canSelectMany: true, defaultUri: vscode.Uri.file(document.directory), filters: { Images: Object.keys(IMAGE_TYPES).map((key) => key.slice(1)) } });
      if (uris?.length) await this.addImages(document, uris.map((uri) => ({ source: uri.fsPath, name: path.basename(uri.fsPath) })));
    } else if (message.type === "drop") {
      const images = (message.paths ?? []).filter((item) => IMAGE_TYPES[path.extname(item).toLowerCase()])
        .map((source) => ({ source: absoluteAsset(source, document.directory), name: path.basename(source) }));
      for (const file of message.files ?? []) {
        if (!IMAGE_TYPES[path.extname(file.name).toLowerCase()] || !file.data.startsWith("data:image/")) continue;
        images.push({ source: file.data, name: file.name });
      }
      if (images.length) await this.addImages(document, images);
    } else if (message.type === "openSource") {
      const item = document.figure.elements.find((element): element is Panel => element.kind === "panel" && element.id === message.id);
      const source = item?.linkedSource ?? item?.source;
      if (source && !source.startsWith("data:")) await vscode.commands.executeCommand("vscode.open", vscode.Uri.file(source));
    } else if (message.type === "exportPng") {
      if (!Number.isFinite(message.dpi) || message.dpi <= 0) throw new Error("DPI must be positive");
      const destination = await vscode.window.showSaveDialog({ defaultUri: vscode.Uri.file(path.join(document.directory, "combination.png")), filters: { PNG: ["png"] } });
      if (destination) {
        const assets = await document.assets();
        if (assets.failures.length) throw new Error(assets.failures.join("\n"));
        this.pendingPng.set(document, { destination, dpi: message.dpi });
        await panel.webview.postMessage({ type: "export", sources: assets.sources, dpi: message.dpi });
      }
    } else if (message.type === "png") {
      const pending = this.pendingPng.get(document);
      if (!pending || !message.data.startsWith("data:image/png;base64,")) return;
      const bytes = setPngDpi(Buffer.from(message.data.split(",")[1], "base64"), pending.dpi);
      await vscode.workspace.fs.writeFile(pending.destination, bytes);
      this.pendingPng.delete(document);
      this.output.appendLine(`[subfigure] Exported PNG: ${pending.destination.fsPath}`);
    }
  }

  /** Writes existing documents, preserving the disk file if serialization or assets are invalid. */
  async saveCustomDocument(document: FigureEditorDocument): Promise<void> { await this.persist(document, document.uri); }
  /** Rebases source links for the destination chosen by the standard Save As action. */
  async saveCustomDocumentAs(document: FigureEditorDocument, destination: vscode.Uri): Promise<void> { await this.persist(document, destination); }

  /** Saves SVG and first-time manuscript edits as one workspace operation with a native undo path. */
  private async persist(document: FigureEditorDocument, destination: vscode.Uri): Promise<void> {
    if (destination.scheme !== "file") throw new Error("Save the combination figure to a local SVG file");
    validateFigure(document.figure);
    const saved = portableFigure(document.figure, path.dirname(destination.fsPath));
    const bytes = Buffer.from(serializeFigure(saved));
    const manuscript = document.manuscript;
    if (manuscript) {
      const source = await vscode.workspace.openTextDocument(vscode.Uri.parse(manuscript.uri));
      const edits = manuscript.group ? conversionEdits(source.getText(), manuscript.group, path.relative(path.dirname(source.uri.fsPath), destination.fsPath).replace(/\\/g, "/"), saved.width)
        : source.getText() === manuscript.original ? [{ start: manuscript.offset, end: manuscript.offset,
          text: `\n\n![Combination figure](${markdownImagePath(path.relative(path.dirname(source.uri.fsPath), destination.fsPath).replace(/\\/g, "/"))}){#fig:combination-${Date.now()} width="${saved.width / 72}in"}\n\n` }]
          : (() => { throw new Error("The manuscript changed; save the SVG separately and insert its image reference manually"); })();
      const workspaceEdit = new vscode.WorkspaceEdit();
      // A new file plus source replacement form one undoable operation; never overwrite an unrelated SVG.
      workspaceEdit.createFile(destination, { contents: bytes });
      for (const edit of edits) workspaceEdit.replace(source.uri, new vscode.Range(source.positionAt(edit.start), source.positionAt(edit.end)), edit.text);
      if (!await vscode.workspace.applyEdit(workspaceEdit, { isRefactoring: true })) throw new Error("The manuscript and SVG could not be updated");
      document.manuscript = undefined;
    } else {
      const open = vscode.workspace.textDocuments.find((item) => item.uri.toString() === destination.toString());
      if (open?.isDirty) throw new Error("The SVG source has unsaved edits; save or revert its source before saving the layout");
      // Source view or an external SVG app may have changed the same file since this editor opened.
      if (destination.toString() === document.uri.toString() && document.diskSource !== undefined) {
        const current = Buffer.from(await vscode.workspace.fs.readFile(destination)).toString("utf8");
        if (current !== document.diskSource) throw new Error("The SVG changed outside the layout editor; reopen it or use Save As to keep both versions");
      }
      await vscode.workspace.fs.writeFile(destination, bytes);
    }
    document.saved = structuredClone(document.figure);
    if (destination.toString() === document.uri.toString()) document.diskSource = bytes.toString("utf8");
    this.output.appendLine(`[subfigure] Saved SVG: ${destination.fsPath}`);
  }

  /** Restores last-saved layout using the correct source directory after Save As. */
  async revertCustomDocument(document: FigureEditorDocument): Promise<void> {
    if (document.uri.scheme === "untitled") document.figure = structuredClone(document.saved);
    else {
      document.diskSource = Buffer.from(await vscode.workspace.fs.readFile(document.uri)).toString("utf8");
      document.figure = hydrateFigure(parseFigureSvg(document.diskSource), path.dirname(document.uri.fsPath));
    }
    document.revision++; await this.sendState(document);
  }

  /** Persists both the draft and its pending manuscript operation for hot-exit recovery. */
  async backupCustomDocument(document: FigureEditorDocument, context: vscode.CustomDocumentBackupContext): Promise<vscode.CustomDocumentBackup> {
    await vscode.workspace.fs.writeFile(context.destination, Buffer.from(JSON.stringify({ figure: document.figure, directory: document.directory,
      manuscript: document.manuscript, diskSource: document.diskSource })));
    return { id: context.destination.toString(), delete: async () => { await vscode.workspace.fs.delete(context.destination); } };
  }

  /** Releases custom-document resources when the extension deactivates. */
  dispose(): void { this.changes.dispose(); this.disposables.forEach((item) => item.dispose()); this.documents.clear(); }
}

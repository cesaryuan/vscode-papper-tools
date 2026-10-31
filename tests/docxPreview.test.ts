import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import type * as vscode from "vscode";
import { buildDocxPreview, PapperPreviewService, type PreviewBuildOptions } from "../src/docxPreview/build";
import type { DocxPreviewController } from "../src/docxPreview/controller";
import type { HostMessage, ViewerMessage } from "../src/docxPreview/protocol";
import { SourceModuleFixture } from "./helpers/sourceModule";

/** Controls conversion completion without depending on native tool startup time. */
function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

/** Waits for externally observable asynchronous work, with a bounded failure deadline. */
async function until(predicate: () => boolean | Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 4000;
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, "Preview did not reach the expected observable state");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

/** Supplies stable file identities without opening a real editor. */
function uri(filename: string): vscode.Uri {
  const fsPath = path.resolve(filename);
  return { fsPath, scheme: "file", toString: () => `file:${fsPath}` } as vscode.Uri;
}

/** Models the viewer acknowledgement and close boundaries used by public preview commands. */
class Panel {
  readonly messages: HostMessage[] = [];
  listener!: (message: ViewerMessage) => void;
  onClose!: () => void;
  acknowledgement: "loaded" | "failed" | "pending" = "loaded";
  closed = false;
  readonly webview = {
    html: "",
    /** Installs the extension's Webview message listener. */
    onDidReceiveMessage: (listener: (message: ViewerMessage) => void) => { this.listener = listener; },
    /** Leaves generated resource paths observable for file retention assertions. */
    asWebviewUri: (value: vscode.Uri) => value,
    /** Acknowledges document delivery as a successful paint or a failed PDF load. */
    postMessage: async (message: HostMessage) => {
      this.messages.push(message);
      if (message.type === "document" && this.acknowledgement !== "pending") this.listener({ type: this.acknowledgement, revision: message.revision, message: "Invalid PDF" });
      return !this.closed;
    },
  };

  /** Installs the actual controller's close callback. */
  onDidDispose(callback: () => void): void { this.onClose = callback; }
  /** Supplies the editor-group operation without a real editor. */
  reveal(): void {}
  /** Emits panel closure only once, matching VS Code disposal. */
  dispose(): void { if (!this.closed) { this.closed = true; this.onClose(); } }
}

/** Keeps real controller scheduling and temporary file cleanup while replacing native conversion and editor UI. */
class Fixture {
  readonly panels: Panel[] = [];
  readonly builds: PreviewBuildOptions[] = [];
  readonly logs: string[] = [];
  readonly source = uri("docx-preview-fixture/manuscript.md");
  readonly controller: DocxPreviewController;
  gate?: ReturnType<typeof deferred>;
  saves = 0;
  text = "Initial buffer";
  document: { uri: vscode.Uri; isDirty: boolean; getText(): string; save(): Promise<boolean> };

  /** Wires controllable external work to the public controller interface. */
  constructor() {
    const fixture = this;
    this.document = {
      uri: this.source, isDirty: false,
      /** Returns the latest unsaved editor snapshot. */
      getText() { return fixture.text; },
      /** Emits the same save event that a real manual refresh must suppress. */
      async save() { fixture.saves++; this.isDirty = false; fixture.controller.onSaved(this as vscode.TextDocument); return true; },
    };
    const module = new SourceModuleFixture({
      vscode: {
        workspace: {
          isTrusted: true,
          /** Returns the source selected by the public command. */
          async openTextDocument() { return fixture.document; },
          /** Uses the feature's normal refresh-on-save default. */
          getConfiguration() { return { get: (_key: string, fallback: unknown) => fallback }; },
        },
        window: {
          /** Records independent panels and their lifecycle. */
          createWebviewPanel() { const panel = new Panel(); fixture.panels.push(panel); return panel; },
        },
        ViewColumn: { Beside: 2 }, Uri: { file: uri, /** Resolves packaged viewer resources. */ joinPath: (base: vscode.Uri, ...parts: string[]) => uri(path.join(base.fsPath, ...parts)) },
      },
      "src/localization.ts": { /** Retains readable progress and error diagnostics. */ t: (value: string, ...args: unknown[]) => value.replace(/\{(\d+)\}/g, (_match, index) => String(args[Number(index)])) },
      "src/vscodeUtils.ts": { /** Accepts the fixture's saved Markdown document. */ isBuildableMarkdownDocument: () => true },
      "src/docxPreview/html.ts": { /** Keeps browser rendering independent of host lifecycle tests. */ buildDocxPreviewHtml: () => "" },
      "src/papperBuildUtils.ts": {
        /** Supplies the build's working directory without project discovery. */
        async findPandocManuscriptProject() { return { rootUri: uri(".") }; },
        /** Leaves native tool installation outside the scheduling contract. */
        async resolvePapperExecutable() { return "papper"; },
        /** Leaves host environment discovery outside the scheduling contract. */
        async preparePapperEnvironment() { return { env: process.env }; },
      },
      "src/docxPreview/build.ts": {
        ...new SourceModuleFixture({}).load<object>("src/docxPreview/build.ts"),
        /** Produces real owned files and lets tests delay or abort an in-flight conversion. */
        async buildDocxPreview(options: PreviewBuildOptions) {
          fixture.builds.push(options);
          await fs.mkdir(options.directory, { recursive: true });
          // Panel closure can win the mkdir race; match the native runner's already-aborted check.
          options.signal.throwIfAborted();
          const gate = fixture.gate;
          fixture.gate = undefined;
          if (gate) await new Promise<void>((resolve, reject) => {
            /** Cancels the simulated native conversion when its owning panel closes. */
            const abort = () => reject(new Error("Preview build cancelled"));
            options.signal.addEventListener("abort", abort, { once: true });
            void gate.promise.then(resolve).finally(() => options.signal.removeEventListener("abort", abort));
          });
          const directory = await fs.mkdtemp(path.join(options.directory, "build-"));
          const pdf = path.join(directory, "preview.pdf");
          await fs.writeFile(pdf, "%PDF-fixture");
          return { directory, pdf, buildMs: 1, conversionMs: 1 };
        },
      },
    }).load<{ DocxPreviewController: typeof DocxPreviewController }>("src/docxPreview/controller.ts");
    this.controller = new module.DocxPreviewController(uri("."), { /** Captures externally visible failure diagnostics. */ appendLine: (message: string) => { this.logs.push(message); } } as unknown as vscode.OutputChannel);
  }

  /** Starts a source-bound preview after its viewer reports readiness. */
  async open(): Promise<void> {
    const opening = this.controller.open(this.source);
    await until(() => this.panels.length > 0);
    this.panels[0].listener({ type: "ready" });
    return opening;
  }

  /** Counts actual document deliveries rather than transient progress messages. */
  documents(): Extract<HostMessage, { type: "document" }>[] {
    return this.panels[0].messages.filter((message): message is Extract<HostMessage, { type: "document" }> => message.type === "document");
  }

  /** Closes the preview and verifies that its private files disappear. */
  async close(): Promise<void> {
    this.controller.dispose();
    if (this.builds.length) await until(async () => !await fs.stat(this.builds[0].directory).then(() => true, () => false));
  }
}

test("manual DOCX refresh reads the dirty buffer without saving; subsequent saves refresh the open panel", async () => {
  const fixture = new Fixture();
  try {
    fixture.document.isDirty = true;
    await fixture.open();
    assert.equal(fixture.saves, 0);
    assert.equal(fixture.builds[0].sourceText, "Initial buffer");
    assert.equal(fixture.builds.length, 1);
    fixture.controller.onSaved(fixture.document as unknown as vscode.TextDocument);
    await until(() => fixture.documents().length === 2);
    assert.equal(fixture.saves, 0);
    assert.equal(fixture.builds.length, 2);
  } finally { await fixture.close(); }
});

test("typing coalesces unsaved buffers and invalidates an in-flight result before the debounce expires", async () => {
  const fixture = new Fixture();
  const gate = fixture.gate = deferred();
  try {
    const opening = fixture.open();
    await until(() => fixture.builds.length === 1);
    fixture.text = "Intermediate unsaved edit";
    fixture.controller.onChanged(fixture.document as unknown as vscode.TextDocument);
    fixture.text = "Latest unsaved edit";
    fixture.controller.onChanged(fixture.document as unknown as vscode.TextDocument);
    gate.resolve();
    await opening;
    assert.equal(fixture.documents().length, 0, "An obsolete snapshot must not appear during the edit debounce");
    await until(() => fixture.documents().length === 1);
    assert.equal(fixture.builds.length, 2);
    assert.equal(fixture.builds[1].sourceText, "Latest unsaved edit");
    assert.equal(fixture.saves, 0);
  } finally { gate.resolve(); await fixture.close(); }
});

test("closing a preview cancels a pending edit debounce", async () => {
  const fixture = new Fixture();
  try {
    await fixture.open();
    fixture.controller.onChanged(fixture.document as unknown as vscode.TextDocument);
    await fixture.close();
    await new Promise(resolve => setTimeout(resolve, 800));
    assert.equal(fixture.builds.length, 1);
  } finally { await fixture.close(); }
});

test("saves during DOCX conversion coalesce and obsolete builds never replace the preview", async () => {
  const fixture = new Fixture();
  const gate = fixture.gate = deferred();
  try {
    const opening = fixture.open();
    await until(() => fixture.builds.length === 1);
    fixture.controller.onSaved(fixture.document as unknown as vscode.TextDocument);
    fixture.controller.onSaved(fixture.document as unknown as vscode.TextDocument);
    gate.resolve();
    await opening;
    assert.equal(fixture.builds.length, 2);
    assert.equal(fixture.documents().length, 1);
    assert.equal(fixture.documents()[0].revision, 3);
    assert.equal((await fs.readdir(fixture.builds[0].directory)).length, 1);
  } finally { gate.resolve(); await fixture.close(); }
});

test("failed PDF replacement retains the previous file until a later successful paint", async () => {
  const fixture = new Fixture();
  try {
    await fixture.open();
    const original = fixture.documents()[0].url.slice("file:".length);
    fixture.panels[0].acknowledgement = "failed";
    await fixture.controller.open(fixture.source);
    await fs.access(original);
    const rejected = fixture.documents()[1].url.slice("file:".length);
    await assert.rejects(fs.access(rejected));
    fixture.panels[0].acknowledgement = "loaded";
    await fixture.controller.open(fixture.source);
    await assert.rejects(fs.access(original));
    await fs.access(fixture.documents()[2].url.slice("file:".length));
  } finally { await fixture.close(); }
});

test("a save during PDF loading supersedes the candidate without waiting for its acknowledgement timeout", async () => {
  const fixture = new Fixture();
  try {
    await fixture.open();
    fixture.panels[0].acknowledgement = "pending";
    const loading = fixture.controller.open(fixture.source);
    await until(() => fixture.documents().length === 2);
    fixture.panels[0].acknowledgement = "loaded";
    fixture.controller.onSaved(fixture.document as unknown as vscode.TextDocument);
    await until(() => fixture.documents().length === 3);
    await loading;
    assert.equal(fixture.documents()[2].revision, 3);
  } finally { await fixture.close(); }
});

test("closing DOCX preview aborts its conversion, removes private files and never publishes the result", async () => {
  const fixture = new Fixture();
  const gate = fixture.gate = deferred();
  try {
    const opening = fixture.open();
    await until(async () => fixture.builds.length === 1 && await fs.stat(fixture.builds[0].directory).then(() => true, () => false));
    fixture.controller.dispose();
    await opening;
    assert.equal(fixture.builds[0].signal.aborted, true);
    assert.equal(fixture.documents().length, 0);
  } finally { gate.resolve(); await fixture.close(); }
});

test("the Papper client reuses its service for unsaved snapshots and restarts after a crash", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pmt-preview-client-test-"));
  const service = new PapperPreviewService();
  const cancellation = new AbortController();
  // A real HTTP/process boundary catches stale URLs and protocol/cancellation
  // bugs; actual DOCX/PDF rendering is exercised by Papper's native integration tests.
  const script = `
const http = require('node:http');
const token = process.argv[3];
const server = http.createServer((request, response) => {
  if (request.headers.authorization !== 'Bearer ' + token) { response.writeHead(401).end(); return; }
  let body = '';
  request.on('data', chunk => body += chunk);
  request.on('end', () => {
    const value = JSON.parse(body);
    if (value.source_text === 'crash') { process.exit(9); return; }
    response.writeHead(200, {'Content-Type':'application/pdf','X-Papper-Build-Ms':'7','X-Papper-Pdf-Ms':'2'});
    response.end('%PDF-' + JSON.stringify({pid:process.pid, text:value.source_text}));
  });
});
server.listen(0, '127.0.0.1', () => console.log(JSON.stringify({type:'ready',protocol:'papper-docx-preview-v1',url:'http://127.0.0.1:' + server.address().port})));
process.stdin.resume();
process.stdin.on('end', () => server.close());
`;
  try {
    await fs.writeFile(path.join(directory, "__docx_preview_server"), script);
    const source = path.join(directory, "manuscript.md");
    await fs.writeFile(source, "Saved content");
    const options: PreviewBuildOptions = { source, sourceText: "First unsaved buffer", project: directory,
      directory: path.join(directory, "artifacts"), papper: process.execPath, env: process.env,
      signal: cancellation.signal, output: { /** Keeps fixture diagnostics out of the test runner output. */ appendLine() {} }, service };
    const first = await buildDocxPreview(options);
    const firstPayload = JSON.parse((await fs.readFile(first.pdf, "utf8")).slice(5));
    options.sourceText = "Second unsaved buffer";
    const second = await buildDocxPreview(options);
    const secondPayload = JSON.parse((await fs.readFile(second.pdf, "utf8")).slice(5));
    assert.equal(firstPayload.pid, secondPayload.pid);
    assert.equal(secondPayload.text, "Second unsaved buffer");
    assert.equal(second.buildMs, 7);
    assert.equal(await fs.readFile(source, "utf8"), "Saved content");
    options.sourceText = "crash";
    await assert.rejects(buildDocxPreview(options));
    options.sourceText = "Recovered buffer";
    const recovered = await buildDocxPreview(options);
    const recoveredPayload = JSON.parse((await fs.readFile(recovered.pdf, "utf8")).slice(5));
    assert.equal(recoveredPayload.text, "Recovered buffer");
    assert.notEqual(recoveredPayload.pid, secondPayload.pid);
    await service.dispose();
    assert.throws(() => process.kill(recoveredPayload.pid, 0), /ESRCH/);
  } finally {
    cancellation.abort();
    await service.dispose();
    await fs.rm(directory, { recursive: true, force: true });
  }
});

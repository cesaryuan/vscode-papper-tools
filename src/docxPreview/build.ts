import * as cp from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createInterface } from "node:readline";

export type PreviewLog = { appendLine(message: string): void };
export type PreviewBuildOptions = {
  source: string; sourceText: string; project: string; directory: string; papper: string;
  service: PapperPreviewService;
  env: NodeJS.ProcessEnv; signal: AbortSignal; output: PreviewLog;
};
export type PreviewArtifact = { directory: string; pdf: string; buildMs: number; conversionMs: number };

/** Owns the authenticated Papper service and reuses its Pandoc/PDF pipeline across edits. */
export class PapperPreviewService {
  private child?: cp.ChildProcess;
  private ready?: Promise<string>;
  private identity?: string;
  private readonly token = crypto.randomBytes(32).toString("hex");

  /** Starts lazily and restarts after a native crash or a changed project/tool environment. */
  private start(options: PreviewBuildOptions): Promise<string> {
    options.signal.throwIfAborted();
    const identity = JSON.stringify([options.papper, options.project, options.env]);
    if (this.identity !== identity) this.dispose();
    if (this.ready) return this.ready;
    this.identity = identity;
    const child = this.child = cp.spawn(options.papper, ["__docx_preview_server", "--token", this.token, "--work-dir", options.directory], {
      cwd: options.project, env: options.env, windowsHide: true, detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });
    options.output.appendLine(`[DOCX preview] Starting Papper embedded PDF service: ${options.papper}`);
    this.ready = new Promise<string>((resolve, reject) => {
      let diagnostic = "";
      let started = false;
      /** Bound UTF-8 startup diagnostics while retaining native failure details. */
      const record = (text: string) => {
        diagnostic = (diagnostic + text).slice(-8192);
        options.output.appendLine(text.trimEnd());
      };
      child.stderr!.setEncoding("utf8").on("data", record);
      const lines = createInterface({ input: child.stdout! });
      /** Stop only this panel's service and its Pandoc descendants. */
      const cancel = () => { stopProcess(child); reject(new Error("Preview build cancelled")); };
      const timer = setTimeout(() => { stopProcess(child); reject(new Error("Papper preview service did not start within 20s")); }, 20_000);
      options.signal.addEventListener("abort", cancel, { once: true });
      if (options.signal.aborted) cancel();
      lines.on("line", (line: string) => {
        if (started) { if (line.trim()) record(line); return; }
        try {
          const message = JSON.parse(line);
          const url = new URL(message.url);
          if (message.type !== "ready" || message.protocol !== "papper-docx-preview-v1"
            || url.protocol !== "http:" || url.hostname !== "127.0.0.1" || !url.port) throw new Error("Unsupported preview service protocol");
          started = true;
          clearTimeout(timer);
          resolve(url.origin);
        } catch { record(line); }
      });
      child.once("error", error => reject(new Error(`Could not start Papper preview service: ${error.message}`)));
      child.once("close", code => {
        clearTimeout(timer);
        lines.close();
        options.signal.removeEventListener("abort", cancel);
        if (this.child === child) { this.child = undefined; this.ready = undefined; }
        reject(new Error(`Papper preview service exited (${code}). Update Papper if it lacks embedded DOCX preview. ${diagnostic.trim()}`));
      });
    });
    return this.ready;
  }

  /** Submit the unsaved buffer; only completed valid PDFs are returned for publication. */
  async render(options: PreviewBuildOptions): Promise<{ bytes: Uint8Array; buildMs: number; conversionMs: number }> {
    const url = await this.start(options);
    let response: Response;
    try {
      response = await fetch(`${url}/preview`, {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
        body: JSON.stringify({ source: options.source, source_text: options.sourceText }),
        signal: AbortSignal.any([options.signal, AbortSignal.timeout(120_000)]),
      });
    } catch (error) {
      // A hung or crashed service must not leave the next edit connected to a
      // dead URL or queued behind work whose response will never be consumed.
      await this.dispose();
      throw error;
    }
    if (!response.ok) throw new Error(`Papper preview HTTP ${response.status}: ${(await response.text()).slice(-8192)}`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (Buffer.from(bytes.subarray(0, 5)).toString("ascii") !== "%PDF-") throw new Error("Papper did not return a valid PDF");
    return { bytes, buildMs: Number(response.headers.get("X-Papper-Build-Ms")) || 0,
      conversionMs: Number(response.headers.get("X-Papper-Pdf-Ms")) || 0 };
  }

  /** Terminate only the service owned by this panel; the next render can start afresh. */
  dispose(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.ready = undefined;
    this.identity = undefined;
    if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise(resolve => {
      child.once("close", () => resolve());
      child.stdin?.end();
      stopProcess(child);
    });
  }
}

/** Stops only a preview-owned process tree on timeout, cancellation or panel disposal. */
function stopProcess(child: cp.ChildProcess): void {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === "win32") {
    const killer = cp.spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    killer.on("error", () => child.kill());
  } else {
    try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  }
}

/** Store a unique PDF from Papper's resident service without touching source or exported files. */
export async function buildDocxPreview(options: PreviewBuildOptions): Promise<PreviewArtifact> {
  await fs.mkdir(options.directory, { recursive: true });
  const directory = await fs.mkdtemp(path.join(options.directory, "build-"));
  const pdf = path.join(directory, "preview.pdf");
  try {
    const { bytes, buildMs, conversionMs } = await options.service.render(options);
    options.signal.throwIfAborted();
    await fs.writeFile(pdf, bytes);
    return { directory, pdf, buildMs, conversionMs };
  } catch (error) {
    await removePreviewDirectory(options.directory, directory);
    throw error;
  }
}

/** Deletes only a verified descendant of this preview's owned temporary directory. */
export async function removePreviewDirectory(root: string, directory: string): Promise<void> {
  const relative = path.relative(path.resolve(root), path.resolve(directory));
  if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error("Refusing to remove a directory outside the preview session");
  }
  await fs.rm(directory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

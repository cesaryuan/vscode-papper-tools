/** Resolves new figure widths from Papper settings and the Word reference section, without building the manuscript. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { parse, stringify } from "yaml";
import { unzipSync, strFromU8 } from "fflate";
import { DOMParser } from "@xmldom/xmldom";
import * as vscode from "vscode";
import { AsyncLruCache } from "../asyncLruCache";
import { getConfigurationContract } from "../configurationContract";
import { findExistingPapperExecutable, findPandocManuscriptProject } from "../papperBuildUtils";
import { getYamlHeader } from "../manuscriptStyle/document";

type Settings = { lang?: string; pandocMetadata?: { lang?: string }; reply?: Settings | null; docxPageMargins?: { left?: string | number; right?: string | number } | null };
type Page = { width: number; left: number; right: number };
// Section geometry from the reference shipped alongside the bundled configuration, in Word twips.
const offlinePage: Page = { width: 11906, left: 1080, right: 1080 };
const word = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const execute = promisify(execFile);

/** Exports just the Word reference, isolating the probe from the user's project and document outputs. */
async function exportPage(executable: string, header: object, project: object, reference?: string): Promise<Page> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "papper-page-"));
  try {
    await fs.writeFile(path.join(directory, "page.md"), `---\n${stringify(header)}---\n`);
    await fs.writeFile(path.join(directory, "style.yml"), stringify(project));
    const env: NodeJS.ProcessEnv = { ...process.env, PAPPER_DISABLE_UPDATE_CHECK: "1" }; delete env.PMT_STYLE_FILE;
    if (reference) env.PMT_REFERENCE_DOC = reference; else delete env.PMT_REFERENCE_DOC;
    await execute(executable, ["build", "docx", "page.md", "--export-reference-doc", "reference.docx"], { cwd: directory, env, windowsHide: true, timeout: 10000 });
    return referencePage(await fs.readFile(path.join(directory, "reference.docx")));
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}

/** Keeps the slow-path key independent of text, citations and unrelated Word styles. */
function layoutSettings(settings: Settings): Settings {
  return { docxPageMargins: settings.docxPageMargins, pandocMetadata: { lang: settings.pandocMetadata?.lang },
    reply: settings.reply ? layoutSettings(settings.reply) : settings.reply };
}

/** Reads the body section's actual paper width and horizontal margins, including landscape or custom paper. */
export function referencePage(bytes: Uint8Array): Page {
  const xml = unzipSync(bytes, { filter: entry => entry.name === "word/document.xml" })["word/document.xml"];
  const doc = new DOMParser().parseFromString(strFromU8(xml), "application/xml");
  const sections = doc.getElementsByTagNameNS(word, "sectPr");
  const section = Array.from(sections).find(item => item.parentNode?.localName === "body") ?? sections[0];
  /** Read only direct section properties, not tracked historical revisions. */
  const twips = (child: string, attr: string): number => {
    const raw = Array.from(section?.childNodes ?? []).find(item => item.nodeType === 1 && item.localName === child) as typeof section;
    const value = raw?.getAttributeNS(word, attr);
    if (!value || !Number.isFinite(Number(value))) throw new Error(`Missing DOCX section ${child}/${attr}`);
    return Number(value);
  };
  return { width: twips("pgSz", "w"), left: twips("pgMar", "left"), right: twips("pgMar", "right") };
}

/** Converts each configured side to Word's integer twips before subtracting, just as the DOCX writer does. */
function marginTwips(value: string | number): number {
  const match = /^(\d+(?:\.\d*)?|\.\d+)\s*(pt|mm|cm|in)?$/i.exec(String(value).trim());
  if (!match) throw new Error(`Invalid DOCX margin: ${value}`);
  const factors: Record<string, number> = { pt: 20, in: 1440, cm: 1440 / 2.54, mm: 1440 / 25.4 };
  return Math.round(Number(match[1]) * factors[match[2]?.toLowerCase() || "pt"]);
}

/** Mirrors the Papper margin cascade; null restores the reference, not zero or the bundled style. */
export function writableWidth(page: Page, defaults: Settings, project: Settings, inline: Settings, reply: boolean): number {
  const layers = [defaults, project, ...(reply && inline.reply !== null ? [defaults.reply, project.reply] : []), inline, ...(reply ? [inline.reply] : [])];
  let left = page.left, right = page.right;
  for (const layer of layers) {
    const margins = layer?.docxPageMargins;
    if (margins === null) { left = page.left; right = page.right; }
    if (margins?.left != null) left = marginTwips(margins.left);
    if (margins?.right != null) right = marginTwips(margins.right);
  }
  const points = (page.width - left - right) / 20;
  if (points <= 0) throw new Error("DOCX margins leave no writable width");
  return points;
}

/** Fingerprints file replacements as well as in-place edits for both style and reference caches. */
async function fingerprint(filename: string): Promise<string> {
  const stat = await fs.stat(filename);
  return JSON.stringify([filename, stat.size, stat.mtimeMs, stat.ctimeMs]);
}

/** Caches parsed project YAML and reference geometry; only the first lookup for a Papper build needs a reference export. */
export class FigurePageWidth {
  private readonly styles = new AsyncLruCache<Settings>(32, 131072, () => 1);
  private readonly pages = new AsyncLruCache<Page>(16, 32768, () => 1);
  private readonly versions = new AsyncLruCache<string>(4, 4096, () => 1);

  /** Shares the regular configuration refresh and persists the tiny bundled reference record across windows. */
  constructor(private readonly state: vscode.Memento, private readonly ensure: () => Promise<void>, private readonly output: vscode.OutputChannel,
    private readonly installedDefaults = () => true) {}

  /** Retains a bounded set of reference measurements across windows, including version-specific fallback exports. */
  private async cachedExport(key: string, load: () => Promise<Page>): Promise<Page> {
    const hash = createHash("sha256").update(key).digest("hex"), storage = "subfigure.pageCache.v2";
    return this.pages.getOrCreate(hash, async () => {
      const hit = this.state.get<[string, Page][]>(storage)?.find(([entry]) => entry === hash);
      if (hit) return hit[1];
      const page = await load();
      await this.state.update(storage, [[hash, page], ...(this.state.get<[string, Page][]>(storage) || []).slice(0, 15)]);
      return page;
    });
  }

  /** Uses a custom reference directly or asks the installed binary for its unmodified template once. */
  private async page(root: string, version: string): Promise<Page> {
    const custom = process.env.PMT_REFERENCE_DOC ? path.resolve(root, process.env.PMT_REFERENCE_DOC)
      : process.env.PAPPER_RESOURCE_ROOT ? path.resolve(process.env.PAPPER_RESOURCE_ROOT, "pandoc/manuscript-template/reference-doc.docx") : undefined;
    if (custom) return this.pages.getOrCreate(await fingerprint(custom), async () => referencePage(await fs.readFile(custom)));
    const executable = await findExistingPapperExecutable();
    if (!executable) return offlinePage;
    const key = `${version}:${await fingerprint(executable)}`;
    try { return await this.cachedExport(key, () => exportPage(executable, { title: "Page", papperSettings: { docxPageMargins: null, docxStyle: null } }, {})); }
    catch (error) { this.output.appendLine(`[Subfigure] Using bundled reference geometry: ${String(error)}`); return offlinePage; }
  }

  /** Reads saved project settings and current manuscript frontmatter; neither cache depends on manuscript body edits. */
  async get(source: vscode.Uri, text = ""): Promise<number> {
    await this.ensure();
    const contract = getConfigurationContract(), root = (await findPandocManuscriptProject(source)).rootUri.fsPath;
    const filename = path.resolve(root, process.env.PMT_STYLE_FILE || "style.yml");
    let project: Settings = {};
    try { project = await this.styles.getOrCreate(await fingerprint(filename), async () => parse(await fs.readFile(filename, "utf8")) || {}); }
    catch (error) { if (error.code !== "ENOENT" || process.env.PMT_STYLE_FILE) throw error; }
    const header = parse(getYamlHeader(text)?.content || "") || {}, inline: Settings = header.papperSettings || {};
    const lang = String(header.lang ?? inline.pandocMetadata?.lang ?? project.pandocMetadata?.lang ?? "").trim().replaceAll("_", "-");
    const reply = typeof header.reply === "string" && !!header.reply.trim();
    if (!this.installedDefaults()) {
      const executable = await findExistingPapperExecutable();
      if (executable) {
        const binary = await fingerprint(executable), reference = process.env.PMT_REFERENCE_DOC && path.resolve(root, process.env.PMT_REFERENCE_DOC);
        const resource = reference || (process.env.PAPPER_RESOURCE_ROOT && path.resolve(process.env.PAPPER_RESOURCE_ROOT, "pandoc/manuscript-template/reference-doc.docx"));
        const probe = { title: "Page", lang: lang || undefined, reply: reply ? "manuscript.md" : undefined, papperSettings: layoutSettings(inline) };
        const style = layoutSettings(project);
        try {
          const version = await this.versions.getOrCreate(binary, async () => (await execute(executable, ["--version"], { windowsHide: true, timeout: 3000 })).stdout.trim());
          const key = JSON.stringify([version, binary, resource && await fingerprint(resource), probe, style]);
          const page = await this.cachedExport(key, () => exportPage(executable, probe, style, reference));
          return writableWidth(page, {}, {}, {}, false);
        } catch (error) { this.output.appendLine(`[Subfigure] Cannot measure installed defaults; using bundled settings: ${String(error)}`); }
      }
    }
    const defaults = /^(?:zh(?:-|$)|zhcn$|zhhans$)/i.test(lang) ? contract.defaults.chinese : contract.defaults.standard;
    return writableWidth(await this.page(root, contract.papperVersion), defaults, project, inline, reply);
  }
}

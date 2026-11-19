import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import test, { type TestContext } from "node:test";
import { DOMParser } from "@xmldom/xmldom";
import type * as vscode from "vscode";
import { SourceModuleFixture } from "./helpers/sourceModule";

/** Checks the actual URI target, including path decoding and separate URL suffixes. */
function preservesResourceUrlComponents(): void {
  const source = path.resolve("resource-fixture");
  const resolvedPaths: string[] = [];
  const module = new SourceModuleFixture({ vscode: { Uri: {
    /** Captures the filesystem path before conversion to a URL can mask a decoding bug. */
    file(fsPath: string) { resolvedPaths.push(fsPath); return { fsPath }; },
  } } }).load<typeof import("../src/papperMarkdownPreview/webview")>("src/papperMarkdownPreview/webview.ts");
  const webview = {
    /** Uses standard file-URL escaping to model asWebviewUri's treatment of literal filenames. */
    asWebviewUri(uri: vscode.Uri) { return pathToFileURL(uri.fsPath); },
  } as unknown as vscode.Webview;
  const html = module.rewriteHtmlResourceUris('<img src="assets/figure%201.png?v=2&amp;theme=dark#panel"><a href="chapter.html#results">Go</a><img src="a&#38;b%23c.png"><img src="literal%ZZ.png">', webview, source);
  assert.deepEqual(resolvedPaths, [
    path.join(source, "assets", "figure 1.png"), path.join(source, "chapter.html"),
    path.join(source, "a&b#c.png"), path.join(source, "literal%ZZ.png"),
  ]);
  assert.ok(html.includes(`${pathToFileURL(resolvedPaths[0])}?v=2&amp;theme=dark#panel`));
  assert.ok(html.includes(`${pathToFileURL(resolvedPaths[1])}#results`));
  const external = '<a href="#local">Local</a><img src="https://example.com/a.png"><img src="data:image/png;base64,eA==">';
  assert.equal(module.rewriteHtmlResourceUris(external, webview, source), external);
}

test("HTML resources decode filenames and retain query/fragment components", preservesResourceUrlComponents);

/** Decodes an SVG image source for inspecting the artwork delivered to the preview. */
function parseEmbeddedSvg(dataUri: string) {
  const payload = /^data:image\/svg\+xml;base64,([^#]+)/.exec(dataUri)?.[1];
  assert.ok(payload, `Expected an embedded SVG source: ${dataUri}`);
  return new DOMParser().parseFromString(Buffer.from(payload, "base64").toString("utf8"), "image/svg+xml");
}

/** Verifies the preview embeds direct links at full quality and leaves nested SVG contents alone. */
async function embedsLinkedSvgPanels(context: TestContext): Promise<void> {
  const project = await fs.mkdtemp(path.join(os.tmpdir(), "pmt-linked-svg-"));
  /** Removes the disposable manuscript and its sample assets. */
  context.after(() => fs.rm(project, { recursive: true, force: true }));
  const assets = path.join(project, "assets");
  const manuscript = path.join(project, "chapters");
  await fs.mkdir(path.join(assets, "panels"), { recursive: true });
  await fs.mkdir(manuscript);
  const rootSvg = '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink"><rect width="20" height="20"/><image xlink:href="panel%20%23a%26b.png?size=1"/><image href="panels/nested.svg"/><image href="missing.png"/></svg>';
  const nestedSvg = '<svg xmlns="http://www.w3.org/2000/svg"><image href="../panel%20%23a%26b.png"/></svg>';
  const raster = await fs.readFile(path.resolve(__dirname, "../assets/icon.png"));
  await Promise.all([
    fs.writeFile(path.join(assets, "combined.svg"), rootSvg),
    fs.writeFile(path.join(assets, "panels", "nested.svg"), nestedSvg),
    fs.writeFile(path.join(assets, "panel #a&b.png"), raster),
    fs.writeFile(path.join(assets, "plain.svg"), '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>'),
  ]);
  const module = new SourceModuleFixture({ vscode: {} }).load<typeof import("../src/papperMarkdownPreview/webview")>("src/papperMarkdownPreview/webview.ts");
  const original = '<figure><img alt="Combined panel" src="../assets/combined.svg?v=2#panel" style="width:40%"></figure><img src="../assets/plain.svg">';
  const html = await module.embedHtmlLinkedSvgImages(original, manuscript, project, {
    /** A missing image must not prevent the available panels from rendering. */
    appendLine() {},
  });
  const source = /<figure><img alt="Combined panel" src="([^"]+)" style="width:40%"><\/figure>/.exec(html)?.[1];
  assert.ok(source?.endsWith("#panel"));
  const combined = parseEmbeddedSvg(source);
  const panels = combined.getElementsByTagName("image");
  const rasterSource = panels.item(0)!.getAttribute("xlink:href")!;
  assert.deepEqual(Buffer.from(rasterSource.replace(/^data:image\/png;base64,/, ""), "base64"), raster);
  const nested = parseEmbeddedSvg(panels.item(1)!.getAttribute("href")!);
  assert.equal(nested.getElementsByTagName("image").item(0)!.getAttribute("href"), "../panel%20%23a%26b.png");
  assert.equal(panels.item(2)!.getAttribute("href"), "missing.png");
  assert.ok(html.endsWith('<img src="../assets/plain.svg">'));
  assert.equal(await fs.readFile(path.join(assets, "combined.svg"), "utf8"), rootSvg);
}

test("Markdown preview embeds directly linked images at full quality without following nested SVG links", embedsLinkedSvgPanels);

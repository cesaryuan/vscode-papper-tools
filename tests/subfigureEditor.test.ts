/** Verifies saved figure behavior, physical typography and manuscript preservation across conversion. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { DOMParser, type Element } from "@xmldom/xmldom";
import { A4, PT_PER_MM, createFigure, createPanel, arrangePanels, resizeFigure, reflowFigure, renumberPanels, autoRenumberPanels, validateFigure, visibleRatio, type Panel } from "../src/subfigureEditor/model";
import { serializeFigure } from "../src/subfigureEditor/svg";
import { parseFigureSvg } from "../src/subfigureEditor/document";
import { importMarkdownGroup, conversionEdits } from "../src/subfigureEditor/markdown";
import { prepareGroupConversion } from "../src/subfigureEditor/conversion";
import { hydrateFigure, portableFigure, assetDataUri, setEmbedded } from "../src/subfigureEditor/assets";
import { setPngDpi } from "../src/subfigureEditor/png";
import { SourceModuleFixture } from "./helpers/sourceModule";
import { dockPanels, findDockTarget, panelRows, resizeRowPair, snapRowDivider, snapSelection } from "../src/subfigureEditor/layout";
import { dockTreePanels, findTreeDock, nestedPanelPreset, resizeTreeDivider, syncPanelTree, treeGeometry, treePanelIds } from "../src/subfigureEditor/panelTree";
import { cropFromFrame, cropGeometry, dragCropFrame, panCropSource, whitespaceCrop } from "../src/subfigureEditor/crop";

/** Applies independent source edits using their original UTF-16 offsets. */
function apply(text: string, edits: Array<{ start: number; end: number; text: string }>): string {
  for (const edit of [...edits].sort((a, b) => b.start - a.start)) text = text.slice(0, edit.start) + edit.text + text.slice(edit.end);
  return text;
}

/** Builds an actual mixed-ratio picture group with formatted captions for round-trip assertions. */
function sample() {
  const figure = createFigure();
  for (const [index, ratio] of [2, 1, 1.5, .8, 3].entries()) {
    const panel = createPanel(figure, `figures/panel ${index}.svg`, `Panel ${index}`, ratio);
    panel.caption = [{ text: "A long caption with " }, { text: "italic and bold", italic: true, bold: true }, { text: "2", script: "super" }];
    figure.elements.push(panel);
  }
  figure.layout.rows = [2, 3]; figure.layout.weights = [1, 2, 1, 1, 2];
  arrangePanels(figure);
  return figure;
}

test("saved SVG reopens with all pictures, cropped regions and rich captions", () => {
  const figure = sample();
  const panel = figure.elements[1] as Panel;
  panel.crop = { left: 10, right: 20, top: 5, bottom: 5 };
  reflowFigure(figure);
  const text = serializeFigure(figure);
  const saved = new DOMParser().parseFromString(text, "image/svg+xml");
  assert.equal(saved.getElementsByTagName("image").length, 5);
  assert.equal(saved.getElementsByTagName("image")[1].getAttribute("href"), panel.source);
  assert.equal((saved.getElementsByTagName("image")[1].parentNode as Element).getAttribute("viewBox"), "100 50 700 900");
  assert.equal(saved.getElementsByTagName("foreignObject").length, 0);
  const reopened = parseFigureSvg(text);
  assert.equal(serializeFigure(reopened), text);
  // Cached glyph widths depend on the renderer's font measurements.
  reflowFigure(reopened);
  assert.deepEqual(reopened, figure);
  assert(text.includes('font-weight="bold"') && text.includes('font-style="italic"') && text.includes('baseline-shift="-0.4em"'));
  assert.throws(() => parseFigureSvg('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'), /not an editable/);
});

test("legacy nested figures get stable short IDs without changing panel references or custom IDs", () => {
  const figure = sample();
  const legacy = "e-11abccdf-16b5-48db-aaab-119f35f72d91";
  const ids = [legacy, "e1", "custom-panel", "e2", "s1"];
  figure.elements.forEach((element, index) => { element.id = ids[index]; });
  nestedPanelPreset(figure, 1);
  figure.layout.tree.id = "e-aabbbbee-7788-47ec-abcd-123456780abc";
  const reopened = parseFigureSvg(serializeFigure(figure));
  const shortId = reopened.elements[0].id;
  assert.match(shortId, /^e\d+$/);
  assert.deepEqual(reopened.elements.slice(1).map(element => element.id), ids.slice(1));
  assert.deepEqual(treePanelIds(reopened.layout.tree), [shortId, ...ids.slice(1)]);
  validateFigure(reopened);
  const saved = serializeFigure(reopened);
  assert.ok(saved.includes(`data-element-id="${shortId}"`) && !saved.includes(legacy));
  assert.equal(serializeFigure(parseFigureSvg(saved)), saved);
  const batch = ["A", "B"].map(name => createPanel(reopened, `${name}.svg`, name));
  reopened.elements.push(...batch);
  syncPanelTree(reopened);
  validateFigure(reopened);
});

test("mixed-script SVG text retains rich formatting and separate Chinese and Western faces after reopening", () => {
  const figure = createFigure();
  // Older files may omit both Chinese-font settings; keep their existing Western face.
  delete figure.font.cjkFamily;
  const title = { kind: "text" as const, id: "title", x: 0, y: 0, width: 300, style: { ...figure.font, family: "Arial" },
    runs: [{ text: "pH值，𠀀2", bold: true, script: "sub" as const }] };
  figure.elements.push(title);
  for (const chinese of ["SimSun", "KaiTi"]) {
    if (chinese === "KaiTi") title.style.cjkFamily = chinese;
    const svg = serializeFigure(parseFigureSvg(serializeFigure(figure)));
    const spans = Array.from(new DOMParser().parseFromString(svg, "image/svg+xml").getElementsByTagName("tspan"));
    assert.deepEqual(spans.map(span => [span.textContent, span.getAttribute("font-family") || (span.parentNode as Element).getAttribute("font-family")]),
      [["pH", "Arial"], ["值，𠀀", chinese], ["2", "Arial"]]);
    assert(spans.every(span => span.getAttribute("font-weight") === "bold" && span.hasAttribute("baseline-shift")));
  }
});

test("resaving legacy metadata produces a stable readable SVG without adding spaces to rich captions", () => {
  const figure = createFigure();
  const panel = createPanel(figure, 'figures/A&B.svg', "A");
  panel.labelPosition = "none";
  panel.caption = [{ text: '"A" & ' }, { text: "<B> ]]>", bold: true }];
  figure.elements.push(panel);
  const legacyJson = JSON.stringify(figure).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const oldSvg = `<svg xmlns="http://www.w3.org/2000/svg"><metadata id="papper-subfigure">${legacyJson}</metadata></svg>`;
  const saved = serializeFigure(parseFigureSvg(oldSvg));
  assert.match(saved, /^\s*"format": "papper-subfigure",$/m);
  assert.match(saved, /^ {6}<image /m);
  const reopened = parseFigureSvg(saved);
  reflowFigure(figure); reflowFigure(reopened);
  assert.deepEqual(reopened, figure);
  assert.equal(serializeFigure(parseFigureSvg(saved)), saved);
  const xml = new DOMParser().parseFromString(saved, "image/svg+xml");
  assert.equal(xml.getElementsByTagName("text")[0].textContent, '"A" & <B> ]]>');
  assert.equal(xml.getElementsByTagName("image")[0].getAttribute("href"), panel.source);
});

test("compact metadata preserves measured wrapping and reads linked images from their own artwork", () => {
  const figure = sample();
  const panel = figure.elements[0] as Panel;
  panel.labelPosition = "top-right";
  panel.style = { ...panel.style, size: 13 };
  reflowFigure(figure, () => 60);
  const saved = serializeFigure(figure);
  const metadata = new DOMParser().parseFromString(saved, "image/svg+xml").getElementsByTagName("metadata")[0].textContent;
  assert(!metadata.includes('"lines"') && !metadata.includes(panel.source));
  const relinked = saved.replaceAll(panel.source, "figures/new.svg");
  const reopened = parseFigureSvg(relinked);
  assert.equal((reopened.elements[0] as Panel).source, "figures/new.svg");
  assert.equal(serializeFigure(reopened), relinked);
  assert.throws(() => parseFigureSvg(saved.replace(`data-element-id="${panel.id}"`, 'data-element-id="other"')), /Missing SVG artwork/);
});

test("new figure widths inherit DOCX margins by side and update on style edits, including reference-margin resets", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "papper-width-"));
  const doc = { fsPath: path.join(root, "paper.md") };
  const fixture = new SourceModuleFixture({ vscode: {}, "src/papperBuildUtils.ts": {
    findPandocManuscriptProject: async () => ({ rootUri: { fsPath: root } }), findExistingPapperExecutable: async (): Promise<undefined> => undefined,
  }, "src/configurationContract.ts": { getConfigurationContract: () => ({ papperVersion: "fixture", defaults: {
    standard: { docxPageMargins: { left: "1in", right: "1in" } }, chinese: { docxPageMargins: { left: "36pt", right: "36pt" } },
  } }) } });
  const { FigurePageWidth, writableWidth } = fixture.load<typeof import("../src/subfigureEditor/pageWidth")>("src/subfigureEditor/pageWidth.ts");
  const width = new FigurePageWidth({} as never, async () => {}, {} as never);
  try {
    await writeFile(path.join(root, "style.yml"), "docxPageMargins: {left: 1cm}\n");
    const first = await width.get(doc as never);
    await writeFile(path.join(root, "style.yml"), "docxPageMargins: {left: 2cm}\n# updated\n");
    assert(Math.abs((first - await width.get(doc as never)) - 72 / 2.54) < .05);
    const chinese = await width.get(doc as never, "---\nlang: zh-CN\n---\n");
    assert.equal(chinese - await width.get(doc as never), 36);
    // A custom 10-inch page with a two-inch reference right margin, overridden by the manuscript on the left.
    assert.equal(writableWidth({ width: 14400, left: 720, right: 2880 }, { docxPageMargins: { right: "1cm" } },
      { docxPageMargins: null }, { docxPageMargins: { left: "1in" } }, false), 504);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("changing physical width preserves manual positions proportionally and keeps printed text size", () => {
  const figure = sample();
  figure.elements[0].x = 17;
  const oldWidth = figure.width;
  resizeFigure(figure, oldWidth * .75);
  const saved = new DOMParser().parseFromString(serializeFigure(figure), "image/svg+xml");
  const viewWidth = Number(saved.documentElement.getAttribute("viewBox").split(" ")[2]);
  const physicalWidth = parseFloat(saved.documentElement.getAttribute("width")) * 72;
  const text = saved.getElementsByTagName("text")[0];
  const finalPointSize = Number(text.getAttribute("font-size")) * physicalWidth / viewWidth;
  assert(Math.abs(finalPointSize - 10) < .001);
  assert.equal(figure.elements[0].x, 17 * .75);
  assert.equal(figure.elements[0].style.size, 10);
  assert.equal(figure.elements.length, 5);
});

test("mixed rows and width weights preserve every panel without moving independent text", () => {
  const figure = sample();
  figure.elements.push({ kind: "text", id: "row-title", x: 3, y: 4, width: 60, runs: [{ text: "Method" }], style: { ...figure.font } });
  arrangePanels(figure);
  const panels = figure.elements.filter((item): item is Panel => item.kind === "panel");
  assert.equal(new Set(panels.map((item) => item.y)).size, 2);
  assert.equal(panels[1].width / panels[0].width, 2);
  assert.equal(panels[2].y, panels[4].y);
  assert.equal(figure.elements.at(-1).x, 3);
  assert(figure.height > panels[4].y + panels[4].height);
  const original = panels[0].label;
  panels[0].y = 1000;
  assert.equal(panels[0].label, original);
  renumberPanels(figure);
  assert.equal(panels[0].label, "e");
});

test("a root-level conversion from a chapter rebases both links and preserves the cited custom panel label", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "papper-crossref-"));
  try {
    const chapter = path.join(root, "chapter"), assets = path.join(chapter, "assets");
    await mkdir(assets, { recursive: true });
    await writeFile(path.join(assets, "图 A.svg"), '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="80"/>');
    const text = 'See @fig:a.\n\n::: {#fig:p}\n![One](<assets/图 A.svg>){#fig:a label="i"} ![Two](<assets/图 A.svg>){#fig:b}\n\nCombined caption.\n:::\n';
    const result = await prepareGroupConversion(text, text.indexOf("![One]"), 432, path.join(chapter, "paper.md"), root);
    assert.equal(result.destination, path.join(root, "subfigure-p.svg"));
    assert.deepEqual(result.warnings, []);
    assert.equal(apply(text, result.edits).trim(), 'See [@fig:p] (i).\n\n![Combined caption.](../subfigure-p.svg){#fig:p width="6in"}');
    const saved = parseFigureSvg(result.bytes.toString());
    const panel = saved.elements[0] as Panel;
    assert.equal(panel.source, "chapter/assets/%E5%9B%BE%20A.svg");
    assert.equal(panel.ratio, 2.5);
    autoRenumberPanels(saved);
    assert.equal(panel.label, "i");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("converting fenced and HTML crossref groups preserves formatted captions, ordering and main references", () => {
  for (const [open, close] of [['::: {#fig:comparison}', ':::'], ['<div id="fig:comparison">', '</div>']]) {
    const text = `See [@fig:comparison] and [@fig:left].\r\n\r\n${open}\r\n![**Left**](<images/a b.png>){#fig:left width="40%" crop-right="10"} ![*Right*](b.svg){#fig:right width="60%" label="c"}\r\n\r\nOverall *caption*.\r\n${close}\r\n\r\nLiteral: \`@fig:left\``;
    const group = importMarkdownGroup(text, text.indexOf("!["));
    assert.equal(group.figure.elements.length, 2);
    assert.equal((group.figure.elements[0] as Panel).source, "images/a b.png");
    assert.equal((group.figure.elements[0] as Panel).crop.right, 10);
    assert.equal((group.figure.elements[0] as Panel).caption[0].bold, true);
    assert.equal((group.figure.elements[1] as Panel).caption[0].italic, true);
    assert.equal(group.children["fig:right"], "c");
    const result = apply(text, conversionEdits(text, group, "figures/comparison plot.svg", group.figure.width));
    assert(result.includes('![Overall *caption*.](figures/comparison%20plot.svg){#fig:comparison'));
    assert(result.includes("See [@fig:comparison] and [@fig:comparison] (a)."));
    assert(result.endsWith("Literal: `@fig:left`"));
    assert(!result.includes("![**Left**]"));
    assert(result.includes("\r\n\r\nLiteral"));
  }
});

test("bilingual crossref conversion renders both panel captions and retains the translated figure title", () => {
  const forms = [
    ['::: {#fig:comparison original-number="图 2-8" caption-en=\'Comparison of "test" cases\'} :::', ':::',
      'caption-en=\'Comparison of "test" cases\''],
    ['<div id="fig:comparison" original-number="图 2-8" caption-en="Comparison of &quot;test&quot; cases">', '</div>',
      'caption-en="Comparison of \\"test\\" cases"'],
  ];
  for (const [open, close, title] of forms) {
    const source = [open,
      '![正常](normal.png){#fig:normal caption-en="(a) **Normal**"} ![突变](mutation.png){#fig:mutation caption-en="(c) *Mutation*"}',
      "", "各类工况对比", close,
    ].join("\n");
    const group = importMarkdownGroup(source, source.indexOf("![正常]"));
    const saved = parseFigureSvg(serializeFigure(group.figure));
    const captions = saved.elements.map(element => element.kind === "panel" ? element.caption : []);
    assert.deepEqual(captions.map(runs => runs.map(run => run.text).join("")), ["正常\nNormal", "突变\n(c) Mutation"]);
    assert(captions[0].some(run => run.text === "Normal" && run.bold));
    assert(captions[1].some(run => run.text === "Mutation" && run.italic));
    assert.deepEqual(saved.elements.map(element => element.lines?.map(line => line.runs.map(run => run.text).join(""))),
      [["(a) 正常", "(a) Normal"], ["(b) 突变", "(c) Mutation"]]);
    saved.elements.reverse();
    arrangePanels(saved);
    renumberPanels(saved);
    arrangePanels(saved);
    const reordered = parseFigureSvg(serializeFigure(saved));
    assert.deepEqual(reordered.elements.map(element => element.lines?.map(line => line.runs.map(run => run.text).join(""))),
      [["(a) 突变", "(c) Mutation"], ["(b) 正常", "(b) Normal"]]);
    const rewritten = apply(source, conversionEdits(source, group, "subfigure-comparison.svg", group.figure.width));
    assert(rewritten.includes('![各类工况对比](subfigure-comparison.svg){#fig:comparison'));
    assert(rewritten.endsWith(`original-number="图 2-8" ${title}}`));
  }
});

test("conversion refuses stale source, mixed content and reference forms it cannot safely preserve", () => {
  const source = '::: {#fig:group}\n![A](a.png){#fig:a width="50%"} ![B](b.png){#fig:b width="50%"}\n\nCaption\n:::';
  const group = importMarkdownGroup(source, 15);
  assert.throws(() => conversionEdits(source.replace("Caption", "Changed"), group, "out.svg", 400), /changed/);
  for (const suffix of ["\n[@fig:a; @fig:b]", "\n[panel](#fig:a)", "\n[@fig:a]{.red}", '\n<a href="#fig:a">Panel</a>']) {
    const text = source + suffix;
    assert.throws(() => conversionEdits(text, importMarkdownGroup(text, 15), "out.svg", 400));
  }
  assert.throws(() => importMarkdownGroup(source.replace("![A]", "Data table | ![A]"), 15));
  assert.throws(() => importMarkdownGroup(source.replace("![A]", "![$x$]"), 15), /mathematics/);
  assert.throws(() => importMarkdownGroup("```\n" + source + "\n```", 20));
});

test("conversion preserves prose punctuation around bare, bracketed and parenthesized child citations", () => {
  const source = 'In this layout, the left panel (@fig:subfigure-a) compares with @fig:subfigure-b. See [@fig:subfigure-a].\n\n'
    + '<div id="fig:subfigure-example">\n![Left](a.png){#fig:subfigure-a width=49%}\n![Right](b.png){#fig:subfigure-b width=49%}\n\nOverall caption.\n</div>\n\n'
    + 'Literal: `@fig:subfigure-a`; escaped: \\@fig:subfigure-b';
  const group = importMarkdownGroup(source, source.indexOf("![Left]"));
  const converted = apply(source, conversionEdits(source, group, "combination.svg", group.figure.width));
  assert(converted.startsWith('In this layout, the left panel ([@fig:subfigure-example] (a)) compares with [@fig:subfigure-example] (b). See [@fig:subfigure-example] (a).'));
  assert(converted.includes('![Overall caption.](combination.svg){#fig:subfigure-example'));
  assert(converted.endsWith('Literal: `@fig:subfigure-a`; escaped: \\@fig:subfigure-b'));
});

test("subfigure hover targets its source document and group from images, containers and citations", async () => {
  const fixture = new SourceModuleFixture({ vscode: {
    MarkdownString: class { value = ""; isTrusted: unknown;
      /** Retains hover Markdown for checking the actual clickable editing action. */
      appendMarkdown(text: string) { this.value += text; } },
    Hover: class {
      /** Captures the rendered hover body as returned to the host. */
      constructor(public contents: unknown, public range: unknown) {} },
  } });
  const { SubfigureHoverProvider, findHoveredGroup } = fixture.load<typeof import("../src/subfigureEditor/hover")>("src/subfigureEditor/hover.ts");
  const { renderHover } = fixture.load<typeof import("../src/hoverActions")>("src/hoverActions.ts");
  const text = 'See @fig:group and @fig:a.\n\n::: {#fig:group}\n![A](a.png){#fig:a} ![B](b.png){#fig:b}\n\nCaption\n:::\n\nOrdinary paragraph.\n`@fig:a`';
  for (const offset of [text.indexOf("@fig:group"), text.indexOf("@fig:a"), text.indexOf("![A]"), text.indexOf("Caption"), text.indexOf(":::")]) {
    const group = findHoveredGroup(text, offset);
    assert.equal(group?.parent, "fig:group");
    const document = { getText: () => text, offsetAt: () => offset, uri: { scheme: "file", toString: () => "file:///different/manuscript.md" }, version: 7, lineAt: () => ({ range: {} }) };
    const contribution = await new SubfigureHoverProvider("convert.test", "edit.test").contribute(document as never, { line: 0 } as never);
    const markdown = renderHover([contribution!])!.contents[0] as { value: string; isTrusted: unknown };
    assert.deepEqual(markdown.isTrusted, { enabledCommands: ["convert.test"] });
    const args = JSON.parse(decodeURIComponent(markdown.value.match(/command:convert.test\?([^)]*)/)[1]));
    assert.deepEqual(args, ["file:///different/manuscript.md", group.start, 7]);
  }
  assert.equal(findHoveredGroup(text, text.indexOf("Ordinary")), undefined);
  assert.equal(findHoveredGroup(text, text.lastIndexOf("@fig:a")), undefined);
});

test("one image action row places editing after both styles and removes it when SVG metadata changes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "papper-hover-"));
  try {
    const filename = path.join(directory, "组合图 example.svg"), manuscript = path.join(directory, "paper (draft).md");
    const fixture = new SourceModuleFixture({ vscode: {
      MarkdownString: class { value = ""; isTrusted: unknown;
        /** Captures the actionable Markdown emitted to the user. */
        appendMarkdown(text: string) { this.value += text; } },
      Hover: class {
        /** Keeps the hover's public body and target range available for assertions. */
        constructor(public contents: unknown, public range: unknown) {} },
      Range: class Range {
        /** Represents the real image token's source span. */
        constructor(public startLine: number, public startCharacter: number, public endLine: number, public endCharacter: number) {}
        /** Intersects the single-line style and image spans on this fixture. */
        intersection(other: this) { return new Range(0, Math.max(this.startCharacter, other.startCharacter), 0, Math.min(this.endCharacter, other.endCharacter)); } },
      Uri: { file: (value: string) => ({ toString: () => pathToFileURL(value).toString() }) },
    } });
    const { SubfigureHoverProvider } = fixture.load<typeof import("../src/subfigureEditor/hover")>("src/subfigureEditor/hover.ts");
    const { ManuscriptStyleController } = fixture.load<typeof import("../src/manuscriptStyle/controller")>("src/manuscriptStyle/controller.ts");
    const { PapperActionHoverProvider } = fixture.load<typeof import("../src/hoverActions")>("src/hoverActions.ts");
    const provider = new PapperActionHoverProvider([
      new ManuscriptStyleController({ globalStorageUri: { fsPath: directory } } as never, undefined),
      new SubfigureHoverProvider("convert.test", "edit.test"),
    ], { appendLine: assert.fail } as never);
    let text = "![Combined plot](<组合图%20example.svg>){#fig:combined}";
    const document = { getText: () => text, offsetAt: (position: { character: number }) => position.character,
      uri: { scheme: "file", fsPath: manuscript, toString: () => pathToFileURL(manuscript).toString() },
      version: 1, lineAt: () => ({ text, range: {} }) };
    await writeFile(filename, serializeFigure(sample()));
    /** Reads the single visible row and follows each link's actual resource argument. */
    async function readRow() {
      const hover = await provider.provideHover(document as never, { line: 0, character: 5 } as never, { isCancellationRequested: false } as never);
      assert.equal(hover?.contents.length, 1);
      const row = hover!.contents[0] as { value: string; isTrusted: unknown };
      assert.equal(row.value.split("Papper Tools: ").length, 2);
      assert.ok(!row.value.includes("\n"));
      const links = [...row.value.matchAll(/\[([^\]]+)\]\(command:([^?]+)\?([^)]*)\)/g)];
      assert.deepEqual(row.isTrusted, { enabledCommands: [...new Set(links.map(link => link[2]))] });
      return links.map(link => [link[1], JSON.parse(decodeURIComponent(link[3]))]);
    }
    const styles = ["Image Caption", "Figure"].map(name => [`Set ${name} Style`, [document.uri.toString(), name]]);
    assert.deepEqual(await readRow(), [...styles, ["$(layout) Edit subfigure layout", [pathToFileURL(filename).toString()]]]);
    await writeFile(filename, '<svg xmlns="http://www.w3.org/2000/svg"><text>ordinary SVG</text></svg>');
    assert.deepEqual(await readRow(), styles);
    await writeFile(filename, '<svg xmlns="http://www.w3.org/2000/svg"><metadata id="papper-subfigure">{"format":"invalid"}</metadata></svg>');
    assert.deepEqual(await readRow(), styles);
    text = "![Missing](missing.svg)";
    document.version++;
    assert.deepEqual(await readRow(), styles);
    text = "![Remote](https://example.com/combined.svg)";
    document.version++;
    assert.deepEqual(await readRow(), styles);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("automatic numbering follows edited visual positions and disabling it preserves custom labels after reopening", () => {
  const figure = sample(), panels = figure.elements as Panel[], moved = panels[0];
  moved.y = 2000;
  assert(autoRenumberPanels(figure));
  assert.equal(moved.label, "e"); assert.equal(panels[1].label, "a");
  assert.equal(autoRenumberPanels(figure), false);
  figure.autoRenumber = false; moved.label = "Custom";
  moved.y = 0; assert.equal(autoRenumberPanels(figure), false);
  const restored = parseFigureSvg(serializeFigure(figure));
  assert.equal(restored.autoRenumber, false); assert.equal((restored.elements[0] as Panel).label, "Custom");
  renumberPanels(restored);
  assert.equal((restored.elements[0] as Panel).label, "a");
  restored.autoRenumber = true;
  (restored.elements[1] as Panel).label = "Manual";
  assert(autoRenumberPanels(restored));
  assert.equal((restored.elements[1] as Panel).label, "b");
});

test("unnumbered layouts retain their captions and stay unnumbered after editing and reopening", () => {
  const figure = createFigure();
  const first = createPanel(figure, "first.png", "First");
  const second = createPanel(figure, "second.png", "Second");
  first.labelPosition = "top-left";
  second.label = "b";
  second.repeatLabel = true;
  second.caption = [{ text: "基线\nBaseline" }];
  figure.elements.push(first, second);
  figure.showPanelLabels = false;
  arrangePanels(figure);
  const hidden = serializeFigure(figure);
  const restored = parseFigureSvg(hidden);
  const added = createPanel(restored, "third.png", "Third");
  restored.elements.push(added);
  assert.equal(autoRenumberPanels(restored), false);
  renumberPanels(restored);
  restored.layout.mode = "panels";
  arrangePanels(restored);
  const reopened = parseFigureSvg(serializeFigure(restored));
  assert.equal(reopened.showPanelLabels, false);
  assert.deepEqual(reopened.elements.map(element => element.lines.map(line => line.runs.map(run => run.text).join(""))),
    [[], ["基线", "Baseline"], []]);
  reopened.showPanelLabels = true;
  assert(autoRenumberPanels(reopened));
  reflowFigure(reopened);
  const visible = serializeFigure(reopened);
  assert.match(visible, />\(a\)<\/tspan>/);
  assert.match(visible, />\(b\) Baseline<\/tspan>/);
});

test("Save As rebases links and embedded assets round-trip without changing image bytes", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "papper-figure-"));
  try {
    const source = path.join(directory, "素材 figure.svg");
    await writeFile(source, '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="50"><text x="0" y="20">Source</text></svg>');
    const figure = createFigure();
    figure.elements.push(createPanel(figure, source, "Source"));
    const target = path.join(directory, "figures");
    await mkdir(target);
    const portable = portableFigure(figure, target);
    assert.equal(decodeURIComponent((portable.elements[0] as Panel).source), "../素材 figure.svg");
    assert.equal((hydrateFigure(parseFigureSvg(serializeFigure(portable)), target).elements[0] as Panel).source, source);
    const embedded = await setEmbedded(figure, true);
    assert((embedded.elements[0] as Panel).source.startsWith("data:image/svg+xml;base64,"));
    const saved = serializeFigure(portableFigure(embedded, target));
    const metadata = new DOMParser().parseFromString(saved, "image/svg+xml").getElementsByTagName("metadata")[0].textContent;
    assert(!metadata.includes("base64,"));
    const reopened = hydrateFigure(parseFigureSvg(saved), target);
    assert.equal((reopened.elements[0] as Panel).source, (embedded.elements[0] as Panel).source);
    const restored = await setEmbedded(reopened, false);
    assert.equal((restored.elements[0] as Panel).source, source);
  } finally { await rm(directory, { recursive: true }); }
});

test("nested SVG local images become full-quality self-contained preview and export sources", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "papper-figure-"));
  try {
    const original = Buffer.from("89504e470d0a1a0a00000000", "hex");
    await writeFile(path.join(directory, "panel.png"), original);
    const svg = path.join(directory, "layout.svg");
    await writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg"><image href="panel.png"/></svg>');
    const uri = await assetDataUri(svg);
    const decoded = Buffer.from(uri.split(",")[1], "base64").toString("utf8");
    assert(decoded.includes(`data:image/png;base64,${original.toString("base64")}`));
    await writeFile(svg, '<svg xmlns="http://www.w3.org/2000/svg"><image href="layout.svg"/></svg>');
    await assert.rejects(assetDataUri(svg), /Circular/);
  } finally { await rm(directory, { recursive: true }); }
});

test("PNG export stores requested physical DPI and preserves image pixel chunks", () => {
  const source = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB8QAAAAASUVORK5CYII=", "base64");
  const output = Buffer.from(setPngDpi(source, 300));
  const physical = output.indexOf("pHYs");
  assert.equal(output.readUInt32BE(physical + 4), Math.round(300 / .0254));
  assert.equal(output.readUInt32BE(physical + 8), Math.round(300 / .0254));
  assert.equal(output[physical + 12], 1);
  assert(output.subarray(output.indexOf("IDAT")).equals(source.subarray(source.indexOf("IDAT"))));
  assert.equal(Buffer.from(setPngDpi(output, 150)).toString("ascii").match(/pHYs/g).length, 1);
});

test("invalid cropping is rejected before a saved figure can be replaced", () => {
  const figure = sample(), panel = figure.elements[0] as Panel;
  panel.crop.left = 80; panel.crop.right = 30;
  assert.throws(() => validateFigure(figure), /crop/);
});

test("side docking joins equal-height images and dropping below a row creates a full-width row", () => {
  const figure = sample();
  const panels = figure.elements.filter((element): element is Panel => element.kind === "panel");
  const labels = new Map(panels.map((panel) => [panel.id, panel.label]));
  const moving = panels[4], target = panels[0];
  dockPanels(figure, new Set([moving.id]), { kind: "beside", anchor: target.id, side: "after" });
  const firstRow = panelRows(figure)[0];
  assert.deepEqual(firstRow.map((panel) => panel.id), [target.id, moving.id, panels[1].id]);
  for (const panel of firstRow) assert(Math.abs(panel.width / visibleRatio(panel) - firstRow[0].height) < .001);
  const drop = findDockTarget(figure, new Set([moving.id]), figure.width / 2,
    Math.max(...firstRow.map((panel) => panel.y + panel.height + (panel.lines?.length ?? 0) * panel.style.size * 1.25 + panel.gap)) + 1);
  assert.equal(drop.kind, "row");
  assert.equal(drop.side, "after");
  dockPanels(figure, new Set([moving.id]), drop);
  const rows = panelRows(figure);
  assert.deepEqual(rows.map((row) => row.length), [2, 1, 2]);
  assert.equal(rows[1][0].id, moving.id);
  assert.equal(rows[1][0].width, figure.width - 2 * figure.layout.padding);
  assert.equal(new Set(rows.flat().map((panel) => panel.id)).size, 5);
  assert(rows.flat().every((panel) => panel.label === labels.get(panel.id)));
  const reopened = parseFigureSvg(serializeFigure(figure));
  assert.deepEqual(panelRows(reopened).map((row) => row.map((panel) => panel.id)), rows.map((row) => row.map((panel) => panel.id)));
});

test("default row widths give cropped images equal heights and manual divider proportions survive reopening", () => {
  const figure = sample(), panels = panelRows(figure).flat();
  figure.layout.weights = [];
  panels[0].crop = { left: 10, right: 20, top: 5, bottom: 5 };
  arrangePanels(figure);
  for (const row of panelRows(figure)) {
    for (const panel of row) assert(Math.abs(panel.width / visibleRatio(panel) - row[0].height) < .001);
    assert(Math.abs(row.reduce((sum, panel) => sum + panel.width, 0) + figure.layout.gap * (row.length - 1)
      + 2 * figure.layout.padding - figure.width) < .001);
  }
  const [left, right] = panelRows(figure)[0], width = left.width, combined = left.width + right.width;
  resizeRowPair(figure, left.id, right.id, 17);
  assert(Math.abs(left.width - width - 17) < .001);
  assert(Math.abs(left.width + right.width - combined) < .001);
  const savedWidths = panelRows(figure).flat().map((panel) => panel.width);
  const reopened = parseFigureSvg(serializeFigure(figure));
  arrangePanels(reopened);
  panelRows(reopened).flat().forEach((panel, index) => assert(Math.abs(panel.width - savedWidths[index]) < .001));
});

test("row divider changes adjacent proportions without changing other rows or losing edited panel content", () => {
  const figure = sample(), rows = panelRows(figure);
  const left = rows[0][0], right = rows[0][1], originalWidth = left.width, total = left.width + right.width;
  const otherWidths = rows[1].map((panel) => panel.width), caption = structuredClone(left.caption);
  left.crop.right = 15;
  resizeRowPair(figure, left.id, right.id, originalWidth * .3);
  assert(Math.abs(left.width - originalWidth * 1.3) < .001);
  assert(Math.abs(left.width + right.width - total) < .001);
  assert.deepEqual(panelRows(figure)[1].map((panel) => panel.width), otherWidths);
  assert.deepEqual(left.caption, caption);
  assert.equal(left.crop.right, 15);
  resizeRowPair(figure, left.id, right.id, total * 100);
  assert(right.width > 0);
  validateFigure(figure);
});

test("divider snapping lands on canvas fractions, holds through small jitter and releases outside the capture zone", () => {
  const figure = createFigure();
  figure.width = 400; figure.layout.padding = 10; figure.layout.weights = [1, 2, 1, 3];
  figure.elements = [2, 1, 1, 1].map((ratio) => createPanel(figure, "panel.svg", "Panel", ratio));
  arrangePanels(figure);
  const [[left, right], other] = panelRows(figure), origin = (left.x + left.width + right.x) / 2;
  const otherWidths = other.map((panel) => panel.width);
  for (const target of [100, 400 / 3, 200, 800 / 3, 300]) {
    const result = snapRowDivider(figure, left.id, right.id, target + 2 - origin, 4);
    assert(Math.abs(result.snap.x - target) < .001);
  }
  const captured = snapRowDivider(figure, left.id, right.id, 202 - origin, 4);
  const held = snapRowDivider(figure, left.id, right.id, 205 - origin, 4, captured.snap.x);
  assert.equal(held.snap.x, 200);
  const released = snapRowDivider(figure, left.id, right.id, 207 - origin, 4, captured.snap.x);
  assert.equal(released.snap, undefined);
  assert.equal(released.delta, 207 - origin);
  resizeRowPair(figure, left.id, right.id, captured.delta);
  assert(Math.abs((left.x + left.width + right.x) / 2 - 200) < .001);
  assert.deepEqual(other.map((panel) => panel.width), otherWidths);
  assert.equal(snapRowDivider(figure, left.id, right.id, 2, 0).snap, undefined);
});

test("divider snapping restores cropped-image equal heights, aligns other rows and skips unreachable guides", () => {
  const figure = createFigure();
  figure.width = 400; figure.layout.padding = 10; figure.layout.weights = [1, 2, 1, 3];
  figure.elements = [2, 1, 1, 1].map((ratio) => createPanel(figure, "panel.svg", "Panel", ratio));
  arrangePanels(figure);
  const [[left, right], other] = panelRows(figure), origin = (left.x + left.width + right.x) / 2;
  left.crop.right = 25;
  const equalHeight = snapRowDivider(figure, left.id, right.id, 238 - origin, 2);
  assert.equal(equalHeight.snap.kind, "equal-height");
  const otherDivider = (other[0].x + other[0].width + other[1].x) / 2;
  const aligned = snapRowDivider(figure, left.id, right.id, otherDivider + 1 - origin, 2);
  assert.equal(aligned.snap.kind, "aligned");
  resizeRowPair(figure, left.id, right.id, equalHeight.delta);
  assert(Math.abs(left.width / 1.5 - right.width) < .001);
  figure.layout.columns = 3; figure.layout.rows = []; figure.layout.weights = [2, 3, 5, 1]; arrangePanels(figure);
  const [a, b] = panelRows(figure)[0], pairOrigin = (a.x + a.width + b.x) / 2;
  const equalWidth = snapRowDivider(figure, a.id, b.id, 106 - pairOrigin, 2);
  assert.equal(equalWidth.snap.kind, "equal-width");
  resizeRowPair(figure, a.id, b.id, equalWidth.delta);
  assert(Math.abs(a.width - b.width) < .001);
  const unreachable = snapRowDivider(figure, a.id, b.id, 200 - 105, 2);
  assert.equal(unreachable.snap, undefined);
  resizeRowPair(figure, a.id, b.id, unreachable.delta);
  assert(b.width >= 12 - .001);
});

test("free movement aligns a selection as a group and reports guides for the captured canvas or element coordinates", () => {
  const figure = createFigure();
  figure.width = 400; figure.height = 400; figure.autoHeight = false;
  const a = createPanel(figure, "a.svg", "A"), b = createPanel(figure, "b.svg", "B"), target = createPanel(figure, "c.svg", "Target");
  Object.assign(a, { x: 20, y: 30, width: 60, height: 40, labelPosition: "none" });
  Object.assign(b, { x: 100, y: 30, width: 40, height: 40, labelPosition: "none" });
  Object.assign(target, { x: 240, y: 180, width: 80, height: 60, labelPosition: "none" });
  figure.elements = [a, b, target];
  reflowFigure(figure);
  const group = new Set([a.id, b.id]), result = snapSelection(figure, group, 121, 151, 4);
  assert.equal(result.dx, 120); assert.equal(result.dy, 150);
  assert.deepEqual(result.guides.map((guide) => [guide.axis, guide.position, guide.kind]),
    [["x", 200, "canvas-center"], ["y", 200, "canvas-center"]]);
  const held = snapSelection(figure, group, 125, 155, 4, result.guides);
  assert.equal(held.dx, 120); assert.equal(held.dy, 150);
  const edge = snapSelection(figure, new Set([a.id]), 161, 151, 4);
  assert.equal(edge.dx, 160);
  assert(edge.guides.some((guide) => guide.axis === "x" && guide.position === 240 && guide.kind === "element-edge"));
  const centre = snapSelection(figure, new Set([a.id]), 231, 161, 4);
  assert.equal(centre.dx, 230); assert.equal(centre.dy, 160);
  assert(centre.guides.every((guide) => guide.kind === "element-center"));
  const bypassed = snapSelection(figure, group, 121, 151, 0, result.guides);
  assert.deepEqual(bypassed, { dx: 121, dy: 151, guides: [] });
  const bounded = snapSelection(figure, group, -100, -100, 0);
  assert.equal(bounded.dx, -20); assert.equal(bounded.dy, -30);
  assert.equal(b.x - a.x, 80);
});

test("nested panels support one left image beside two stacked right images with fixed-size captions and reversible geometry", () => {
  const figure = sample(); figure.elements = figure.elements.slice(0, 3); figure.layout.weights = [];
  nestedPanelPreset(figure, 1); arrangePanels(figure);
  const [left, top, bottom] = figure.elements as Panel[];
  assert(left.x < top.x && top.x === bottom.x);
  assert(top.y === left.y && bottom.y > top.y + top.height);
  assert(Math.abs(top.width - bottom.width) < .001);
  assert(Math.abs(left.y + left.height + left.gap + left.lines.length * 12.5
    - bottom.y - bottom.height - bottom.gap - bottom.lines.length * 12.5) < .001);
  assert(figure.elements.every((element) => element.style.size === 10));
  validateFigure(figure);
  const reopened = parseFigureSvg(serializeFigure(figure)), saved = structuredClone(reopened.elements);
  arrangePanels(reopened);
  reopened.elements.forEach((element, index) => {
    assert(Math.abs(element.x - saved[index].x) < .001); assert(Math.abs(element.y - saved[index].y) < .001);
    assert(Math.abs(element.width - saved[index].width) < .001);
  });
  const dividers = treeGeometry(figure).dividers;
  assert(dividers.some((divider) => divider.axis === "x"));
  const horizontal = dividers.find((divider) => divider.axis === "y"), beforeLeft = structuredClone(left), oldHeight = top.height;
  resizeTreeDivider(figure, horizontal.split, horizontal.index, 15, 0);
  assert(top.height > oldHeight + 1);
  assert.deepEqual(left, beforeLeft);
  validateFigure(figure);
  const resized = parseFigureSvg(serializeFigure(figure));
  arrangePanels(resized);
  resized.elements.forEach((element, index) => {
    const original = figure.elements[index];
    for (const key of ["x", "y", "width"] as const) assert(Math.abs(element[key] - original[key]) < .001);
    if (element.kind === "panel" && original.kind === "panel") assert(Math.abs(element.height - original.height) < .001);
  });
});

test("four-sided local docking creates nested splits and deleting or adding panels preserves every remaining image", () => {
  const figure = sample(); figure.elements = figure.elements.slice(0, 3); figure.layout.rows = [3]; figure.layout.weights = []; arrangePanels(figure);
  const [left, top, moving] = figure.elements as Panel[], labels = figure.elements.map((panel) => panel.kind === "panel" && panel.label);
  const target = findTreeDock(figure, new Set([moving.id]), top.x + top.width / 2, top.y + top.height - 1);
  assert.equal(target.scope, "panel"); assert.equal(target.side, "bottom");
  dockTreePanels(figure, new Set([moving.id]), target);
  assert(left.x < top.x); assert.equal(top.x, moving.x); assert(moving.y > top.y);
  assert.deepEqual(figure.elements.map((panel) => panel.kind === "panel" && panel.label), labels);
  assert.deepEqual(treePanelIds(figure.layout.tree), figure.elements.map((panel) => panel.id));
  figure.elements = figure.elements.filter((panel) => panel.id !== top.id);
  arrangePanels(figure);
  assert.equal(treePanelIds(figure.layout.tree).length, 2);
  const added = createPanel(figure, "new.svg", "New"); figure.elements.push(added);
  arrangePanels(figure);
  assert.equal(new Set(treePanelIds(figure.layout.tree)).size, 3);
  validateFigure(figure);
  const outer = findTreeDock(figure, new Set([added.id]), -2, left.y + left.height / 2);
  assert.equal(outer.scope, "figure"); assert.equal(outer.side, "left");
  dockTreePanels(figure, new Set([added.id]), outer);
  assert.equal(treePanelIds(figure.layout.tree)[0], added.id);
  validateFigure(figure);
});

test("dropping on a panel centre exchanges only the two slots; dragging home or multi-dragging to a centre has no target", () => {
  const figure = sample(); nestedPanelPreset(figure, 1); arrangePanels(figure);
  const [left, upper, lower] = figure.elements as Panel[], moving = new Set([left.id]);
  const centreX = upper.x + upper.width / 2, centreY = upper.y + upper.height / 2;
  assert.equal(findTreeDock(figure, moving, left.x + left.width / 2, left.y + left.height / 2), undefined);
  assert.equal(findTreeDock(figure, new Set([left.id, lower.id]), centreX, centreY), undefined);
  const target = findTreeDock(figure, moving, centreX, centreY), before = treePanelIds(figure.layout.tree);
  assert.equal(target?.side, "center");
  dockTreePanels(figure, moving, target);
  assert.deepEqual(treePanelIds(figure.layout.tree), before.map((id) => id === left.id ? upper.id : id === upper.id ? left.id : id));
  assert.equal(left.x, lower.x); assert(upper.x < left.x); assert(left.y < lower.y);
  validateFigure(parseFigureSvg(serializeFigure(figure)));
});

test("the full gutter beside a stacked column inserts a sibling column, not a panel inside the stack", () => {
  const figure = sample(); nestedPanelPreset(figure, 1); arrangePanels(figure);
  const [left, upper, lower, moving] = figure.elements as Panel[], ids = new Set([moving.id]);
  const gutter = (left.x + left.width + upper.x) / 2;
  const nearTop = findTreeDock(figure, ids, gutter, upper.y + upper.height / 2);
  const nearBottom = findTreeDock(figure, ids, gutter, lower.y + lower.height / 2);
  assert.equal(nearBottom?.scope, "gap"); assert.deepEqual(nearBottom, nearTop);
  dockTreePanels(figure, ids, nearBottom);
  assert.equal(upper.x, lower.x); assert(left.x < moving.x && moving.x < lower.x);
  assert.equal(left.y, moving.y); assert.equal(moving.y, upper.y); assert(lower.y > upper.y);
  validateFigure(parseFigureSvg(serializeFigure(figure)));
});

test("A4 whitespace docks whole rows and columns, including the paper bottom, while rejecting off-paper drops", () => {
  const original = sample(); original.layout.rows = [5]; original.layout.weights = []; arrangePanels(original);
  const marginX = (A4.width - original.width) / 2, marginY = 22 * PT_PER_MM;
  const canvas = { x: -marginX, y: -marginY, width: A4.width, height: A4.height };
  const moving = original.elements[2].id, ids = new Set([moving]);
  const cases = [
    { x: original.width / 2, y: A4.height - marginY - 2, side: "bottom" },
    { x: -marginX + 2, y: A4.height - marginY - 2, side: "left" },
    { x: -marginX + 2, y: original.height / 2, side: "left" },
    { x: A4.width - marginX - 2, y: original.height / 2, side: "right" },
    { x: A4.width - marginX - 2, y: -marginY + 2, side: "right" },
    { x: A4.width - marginX - 2, y: A4.height - marginY - 2, side: "right" },
    { x: original.width + 1, y: -marginY + 2, side: "right" },
    { x: original.width + 1, y: A4.height - marginY - 2, side: "right" },
    { x: original.width / 2, y: -marginY + 2, side: "top" },
  ] as const;
  for (const position of cases) {
    const figure = structuredClone(original), target = findTreeDock(figure, ids, position.x, position.y, canvas);
    assert.equal(target?.scope, "figure"); assert.equal(target?.side, position.side);
    dockTreePanels(figure, ids, target);
    const panel = figure.elements.find((element) => element.id === moving) as Panel;
    const others = figure.elements.filter((element): element is Panel => element.kind === "panel" && element.id !== moving);
    if (position.side === "bottom") assert(others.every((other) => panel.y > other.y + other.height));
    if (position.side === "top") assert(others.every((other) => panel.y + panel.height < other.y));
    if (position.side === "left") assert(others.every((other) => panel.x + panel.width < other.x));
    if (position.side === "right") assert(others.every((other) => panel.x > other.x + other.width));
    assert.equal(figure.width, original.width);
    validateFigure(parseFigureSvg(serializeFigure(figure)));
  }
  assert.equal(findTreeDock(original, ids, original.width / 2, A4.height - marginY + 1, canvas), undefined);
  assert.equal(findTreeDock(original, ids, -marginX - 1, original.height / 2, canvas), undefined);
  assert.equal(findTreeDock(original, ids, A4.width - marginX + 1, original.height / 2, canvas), undefined);
  assert.equal(findTreeDock(original, ids, original.width / 2, -marginY - 1, canvas), undefined);
  // Hiding A4 keeps the figure-edge target but does not leave an invisible paper-sized drop surface.
  assert.equal(findTreeDock(original, ids, original.width / 2, A4.height - marginY - 2), undefined);
  assert.equal(findTreeDock(original, ids, original.width / 2, original.height + 10)?.side, "bottom");
});

test("invalid nested metadata cannot duplicate or omit a picture in the saved SVG", () => {
  const figure = sample(); figure.layout.mode = "panels"; syncPanelTree(figure);
  const duplicate = structuredClone(figure);
  duplicate.layout.tree = { kind: "split", id: "bad", axis: "x", children: [
    { kind: "panel", id: figure.elements[0].id }, { kind: "panel", id: figure.elements[0].id }] };
  assert.throws(() => validateFigure(duplicate), /layout/);
  figure.layout.tree = { kind: "panel", id: figure.elements[0].id };
  assert.throws(() => validateFigure(figure), /missing/);
});

test("interactive crop frames round-trip existing crops and preserve the source while constraining edges and image panning", () => {
  const figure = sample(), panel = figure.elements[0] as Panel;
  panel.crop = { left: 10, right: 20, top: 5, bottom: 15 };
  const originalSource = panel.source, original = cropGeometry(panel), recovered = cropFromFrame(original.source, original.frame);
  for (const key of ["left", "right", "top", "bottom"] as const) assert(Math.abs(recovered[key] - panel.crop[key]) < .000001);
  const smaller = dragCropFrame(original.source, original.frame, "se", -20, -10, 8);
  const cropped = cropFromFrame(original.source, smaller);
  assert(cropped.right > panel.crop.right); assert(cropped.bottom > panel.crop.bottom);
  const panned = panCropSource(original.source, smaller, 10000, -10000), panCrop = cropFromFrame(panned, smaller);
  assert(Math.abs(panCrop.left) < .000001); assert(Math.abs(panCrop.bottom) < .000001);
  const collapsed = dragCropFrame(original.source, smaller, "nw", 10000, 10000, 8);
  assert(collapsed.width >= 8 - .000001 && collapsed.height >= 8 - .000001);
  panel.crop = cropped; reflowFigure(figure);
  const reopened = parseFigureSvg(serializeFigure(figure)).elements[0] as Panel;
  assert.deepEqual(reopened.crop, cropped); assert.equal(reopened.source, originalSource);
  const reset = cropFromFrame(original.source, original.source);
  assert.deepEqual(reset, { left: 0, right: 0, top: 0, bottom: 0 });
});

/** Creates independent pixel fixtures with actual outer backgrounds, plot content and fine annotations. */
function cropPixels(background: [number, number, number, number]) {
  const width = 160, height = 120, data = new Uint8ClampedArray(width * height * 4);
  for (let offset = 0; offset < data.length; offset += 4) data.set(background, offset);
  return { width, height, data };
}

/** Paints known source-space content without sharing any of the production detection logic. */
function paintCropPixels(image: ReturnType<typeof cropPixels>, x: number, y: number, width: number, height: number, color: number[]): void {
  for (let row = y; row < y + height; row++) {
    for (let column = x; column < x + width; column++) image.data.set(color, (row * image.width + column) * 4);
  }
}

test("whitespace detection removes only outer margins while retaining pale one-pixel labels and internal whitespace", () => {
  const image = cropPixels([255, 255, 255, 255]);
  paintCropPixels(image, 40, 30, 80, 50, [30, 60, 120, 255]);
  paintCropPixels(image, 65, 40, 40, 30, [255, 255, 255, 255]);
  paintCropPixels(image, 20, 95, 1, 1, [230, 230, 230, 255]);
  const crop = whitespaceCrop(image);
  assert(crop.left > 5 && crop.left / 100 * image.width < 20);
  assert(crop.top > 5 && crop.top / 100 * image.height < 30);
  assert((100 - crop.right) / 100 * image.width > 120);
  assert((100 - crop.bottom) / 100 * image.height > 96);
  assert(crop.right > 5 && crop.bottom > 5);
});

test("whitespace detection handles transparent and noisy backgrounds and preserves marks touching the image edge", () => {
  const transparent = cropPixels([250, 10, 90, 0]);
  paintCropPixels(transparent, 40, 30, 80, 50, [255, 255, 255, 255]);
  const crop = whitespaceCrop(transparent);
  assert(crop.left > 20 && crop.top > 20 && crop.right > 20 && crop.bottom > 20);
  const noisy = cropPixels([255, 255, 255, 255]);
  for (let offset = 0; offset < noisy.data.length; offset += 4) {
    const value = 250 + offset % 6; noisy.data.set([value, value, value, 255], offset);
  }
  paintCropPixels(noisy, 40, 30, 80, 50, [0, 0, 0, 255]);
  assert(whitespaceCrop(noisy).left > 20);
  paintCropPixels(noisy, 0, 0, 1, 1, [0, 0, 0, 255]);
  const edge = whitespaceCrop(noisy);
  assert.equal(edge.left, 0); assert.equal(edge.top, 0); assert(edge.right > 0 && edge.bottom > 0);
});

test("whitespace detection leaves blank or nonuniform full-frame sources unchanged", () => {
  assert.equal(whitespaceCrop(cropPixels([255, 255, 255, 255])), undefined);
  assert.equal(whitespaceCrop(cropPixels([0, 0, 0, 0])), undefined);
  const image = cropPixels([255, 255, 255, 255]);
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) image.data.set([x, y * 2, (x + y) % 256, 255], (y * image.width + x) * 4);
  }
  assert.equal(whitespaceCrop(image), undefined);
});

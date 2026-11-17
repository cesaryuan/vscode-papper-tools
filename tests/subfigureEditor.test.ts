/** Verifies saved figure behavior, physical typography and manuscript preservation across conversion. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { DOMParser, type Element } from "@xmldom/xmldom";
import { createFigure, createPanel, arrangePanels, resizeFigure, reflowFigure, renumberPanels, validateFigure, type Panel } from "../src/subfigureEditor/model";
import { serializeFigure } from "../src/subfigureEditor/svg";
import { parseFigureSvg } from "../src/subfigureEditor/document";
import { importMarkdownGroup, conversionEdits } from "../src/subfigureEditor/markdown";
import { hydrateFigure, portableFigure, assetDataUri, setEmbedded } from "../src/subfigureEditor/assets";
import { setPngDpi } from "../src/subfigureEditor/png";
import { SourceModuleFixture } from "./helpers/sourceModule";

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
  assert.deepEqual(parseFigureSvg(text), figure);
  assert(text.includes('font-weight="bold"') && text.includes('font-style="italic"') && text.includes('baseline-shift="-0.4em"'));
  assert.throws(() => parseFigureSvg('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0"/></svg>'), /not an editable/);
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

test("subfigure hover targets its source document and group from images, containers and citations", () => {
  const fixture = new SourceModuleFixture({ vscode: {
    MarkdownString: class { value = ""; isTrusted: unknown;
      /** Retains hover Markdown for checking the actual clickable editing action. */
      appendMarkdown(text: string) { this.value += text; } },
    Hover: class {
      /** Captures the rendered hover body as returned to the host. */
      constructor(public contents: unknown, public range: unknown) {} },
  } });
  const { SubfigureHoverProvider, findHoveredGroup } = fixture.load<typeof import("../src/subfigureEditor/hover")>("src/subfigureEditor/hover.ts");
  const text = 'See @fig:group and @fig:a.\n\n::: {#fig:group}\n![A](a.png){#fig:a} ![B](b.png){#fig:b}\n\nCaption\n:::\n\nOrdinary paragraph.\n`@fig:a`';
  for (const offset of [text.indexOf("@fig:group"), text.indexOf("@fig:a"), text.indexOf("![A]"), text.indexOf("Caption"), text.indexOf(":::")]) {
    const group = findHoveredGroup(text, offset);
    assert.equal(group?.parent, "fig:group");
    const document = { getText: () => text, offsetAt: () => offset, uri: { scheme: "file", toString: () => "file:///different/manuscript.md" }, version: 7, lineAt: () => ({ range: {} }) };
    const hover = new SubfigureHoverProvider("convert.test").provideHover(document as never, { line: 0 } as never);
    const markdown = hover.contents as unknown as { value: string; isTrusted: unknown };
    assert.deepEqual(markdown.isTrusted, { enabledCommands: ["convert.test"] });
    const args = JSON.parse(decodeURIComponent(markdown.value.match(/command:convert.test\?([^)]*)/)[1]));
    assert.deepEqual(args, ["file:///different/manuscript.md", group.start, 7]);
  }
  assert.equal(findHoveredGroup(text, text.indexOf("Ordinary")), undefined);
  assert.equal(findHoveredGroup(text, text.lastIndexOf("@fig:a")), undefined);
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
    const restored = await setEmbedded(embedded, false);
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

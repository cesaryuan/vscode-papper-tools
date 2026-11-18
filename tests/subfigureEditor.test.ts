/** Verifies saved figure behavior, physical typography and manuscript preservation across conversion. */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import * as path from "node:path";
import { tmpdir } from "node:os";
import { DOMParser, type Element } from "@xmldom/xmldom";
import { A4, PT_PER_MM, createFigure, createPanel, arrangePanels, resizeFigure, reflowFigure, renumberPanels, validateFigure, visibleRatio, type Panel } from "../src/subfigureEditor/model";
import { serializeFigure } from "../src/subfigureEditor/svg";
import { parseFigureSvg } from "../src/subfigureEditor/document";
import { importMarkdownGroup, conversionEdits } from "../src/subfigureEditor/markdown";
import { hydrateFigure, portableFigure, assetDataUri, setEmbedded } from "../src/subfigureEditor/assets";
import { setPngDpi } from "../src/subfigureEditor/png";
import { SourceModuleFixture } from "./helpers/sourceModule";
import { dockPanels, findDockTarget, panelRows, resizeRowPair, snapRowDivider, snapSelection } from "../src/subfigureEditor/layout";
import { dockTreePanels, findTreeDock, nestedPanelPreset, resizeTreeDivider, syncPanelTree, treeGeometry, treePanelIds } from "../src/subfigureEditor/panelTree";
import { cropFromFrame, cropGeometry, dragCropFrame, panCropSource } from "../src/subfigureEditor/crop";

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

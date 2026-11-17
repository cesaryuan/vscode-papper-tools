import { MarkdownSyntax, parseAttributeList, readAttributeBlock } from "../markdownSyntax";
import { parsePandocDocument } from "../parser";
import { arrangePanels, createFigure, createPanel, type FigureDocument, type RichRun } from "./model";
import { decimal } from "./svg";

export type TextEdit = { start: number; end: number; text: string };
export type ImportedGroup = { start: number; end: number; original: string; parent: string; caption: string;
  children: Record<string, string>; figure: FigureDocument };

/** Parses only supported caption formatting so conversion never silently drops equations or links. */
export function parseCaption(text: string): RichRun[] {
  const result: RichRun[] = [];
  let bold = false, italic = false, script: "super" | "sub" | undefined, buffer = "";
  /** Flushes pending characters under their current inline formatting. */
  const flush = (): void => { if (buffer) result.push({ text: buffer, bold: bold || undefined, italic: italic || undefined, script }); buffer = ""; };
  for (let index = 0; index < text.length; index++) {
    const character = text[index];
    if (character === "\\" && index + 1 < text.length) { buffer += text[++index]; continue; }
    if (/[$`<>\[\]{}]/.test(character)) throw new Error("This caption contains unsupported Markdown or mathematics");
    if (text.startsWith("**", index) || text.startsWith("__", index)) { flush(); bold = !bold; index++; }
    else if (character === "*" || character === "_") { flush(); italic = !italic; }
    else if (character === "^" || character === "~") {
      flush();
      const next = character === "^" ? "super" : "sub";
      if (script && script !== next) throw new Error("Nested caption scripts are not supported");
      script = script ? undefined : next;
    } else buffer += character;
  }
  flush();
  if (bold || italic || script) throw new Error("The caption has incomplete inline formatting");
  return result;
}

/** Finds an enclosing supported Div using the shared scanner's literal and fence boundaries. */
export function importMarkdownGroup(text: string, offset: number): ImportedGroup {
  const parsed = parsePandocDocument(text), syntax = new MarkdownSyntax(text);
  const ranges: Array<{ start: number; end: number; innerStart: number; innerEnd: number; parent: string }> = [];
  for (const div of parsed.fencedDivs) {
    const attributes = parseAttributeList(div.attributes), parent = attributes?.id?.value;
    if (!div.closed || !parent?.startsWith("fig:")) continue;
    const first = syntax.lines[div.range.start.line], last = syntax.lines[div.range.end.line];
    ranges.push({ start: first.start, end: last.end, innerStart: first.next, innerEnd: last.start, parent });
  }
  for (const label of parsed.labels.filter((entry) => entry.source === "html-div" && entry.containerRange && entry.prefix === "fig")) {
    const end = syntax.lines[label.containerRange.end.line].start + label.containerRange.end.character;
    const closing = text.lastIndexOf("</div", end);
    if (closing >= label.fullEndOffset) ranges.push({ start: label.fullOffset, end, innerStart: label.fullEndOffset, innerEnd: closing, parent: label.label });
  }
  const selected = ranges.filter((range) => range.start <= offset && offset <= range.end).sort((a, b) => a.end - a.start - (b.end - b.start))[0];
  if (!selected) throw new Error("Place the cursor inside a pandoc-crossref subfigure group");
  const opening = text.slice(selected.start, selected.innerStart);
  if (opening.trim().startsWith(":::")) {
    const attributes = parseAttributeList(opening.trim().replace(/^:+\s*/, ""));
    if (attributes?.classes.length || attributes?.values.some((item) => item.key !== "original-number")) throw new Error("The figure group has attributes that cannot be preserved");
  }
  const inner = text.slice(selected.innerStart, selected.innerEnd);
  const figure = createFigure(), children: Record<string, string> = {};
  const lines = new MarkdownSyntax(inner).lines;
  let imageRowCount = 0, caption = "", captionStarted = false;
  for (const line of lines) {
    if (!line.text.trim()) {
      if (imageRowCount) { figure.layout.rows.push(imageRowCount); imageRowCount = 0; }
      continue;
    }
    let position = 0, images = 0;
    while (position < line.text.length) {
      while (/\s/.test(line.text[position] ?? "") && position < line.text.length) position++;
      if (position >= line.text.length) break;
      if (!line.text.startsWith("![", position)) break;
      if (captionStarted) throw new Error("Pictures after the overall caption are not supported");
      const image = readImage(line.text, position);
      const panel = createPanel(figure, image.target, image.target.split(/[\\/]/).at(-1) || image.target);
      panel.caption = parseCaption(image.caption);
      const attributes = image.attributes;
      const values = new Map(attributes?.values.map((item) => [item.key, item.value]) ?? []);
      const known = new Set(["width", "height", "label", "original-width", "original-height", "crop-left", "crop-right", "crop-top", "crop-bottom"]);
      if (attributes?.classes.length || [...values.keys()].some((key) => !known.has(key))) throw new Error("An image uses attributes that cannot be preserved by this editor");
      if (values.has("label")) panel.label = values.get("label");
      if (attributes?.id) {
        if (children[attributes.id.value] !== undefined) throw new Error("Duplicate child figure identifiers");
        children[attributes.id.value] = panel.label;
      }
      for (const edge of ["left", "right", "top", "bottom"] as const) panel.crop[edge] = Number(values.get(`crop-${edge}`) || 0);
      const width = values.get("width");
      if (width && !/^\d+(?:\.\d+)?%$/.test(width)) throw new Error("Subfigure widths must be percentages");
      figure.layout.weights.push(width ? parseFloat(width) : 1);
      figure.elements.push(panel);
      images++; position = image.end;
    }
    if (images && line.text.slice(position).trim()) throw new Error("An image row contains additional content");
    if (images) imageRowCount += images;
    else {
      if (imageRowCount) { figure.layout.rows.push(imageRowCount); imageRowCount = 0; }
      captionStarted = true;
      if (caption) throw new Error("A group must have one overall caption paragraph");
      caption = line.text.trim();
    }
  }
  if (imageRowCount) figure.layout.rows.push(imageRowCount);
  if (figure.elements.length < 2 || !caption) throw new Error("A subfigure group needs at least two pictures and an overall caption");
  arrangePanels(figure);
  return { ...selected, original: text.slice(selected.start, selected.end), caption, children, figure };
}

/** Reads balanced Markdown image captions and destinations, including spaces in angle-bracket paths. */
function readImage(text: string, start: number): { caption: string; target: string; attributes?: ReturnType<typeof parseAttributeList>; end: number } {
  let index = start + 2, depth = 1;
  const captionStart = index;
  while (index < text.length && depth) {
    if (text[index] === "\\") { index += 2; continue; }
    if (text[index] === "[") depth++;
    if (text[index] === "]") depth--;
    if (depth) index++;
  }
  const caption = text.slice(captionStart, index);
  if (text.slice(index, index + 2) !== "](") throw new Error("Only inline Markdown images can be imported");
  index += 2;
  let target = "";
  if (text[index] === "<") {
    const close = text.indexOf(">", ++index);
    if (close < 0) throw new Error("Incomplete image path");
    target = text.slice(index, close); index = close + 1;
  } else {
    const begin = index; depth = 0;
    while (index < text.length) {
      if (text[index] === "\\") { index += 2; continue; }
      if (text[index] === "(") depth++;
      if (text[index] === ")") { if (!depth) break; depth--; }
      if (!depth && /\s/.test(text[index])) break;
      index++;
    }
    target = text.slice(begin, index).replace(/\\([()])/g, "$1");
  }
  while (/\s/.test(text[index] ?? "") && index < text.length) index++;
  if (!target || text[index] !== ")") throw new Error("Image titles and incomplete destinations are not supported");
  index++;
  let attributes: ReturnType<typeof parseAttributeList>;
  if (text[index] === "{") {
    const read = readAttributeBlock(text, index);
    if (!read.block) throw new Error("Incomplete image attributes");
    attributes = read.block; index = attributes.end;
  }
  return { caption, target, attributes, end: index };
}

/** Encodes local paths for Markdown without turning spaces or parentheses into markup. */
export function markdownImagePath(target: string): string {
  return target.split("/").map((part) => encodeURIComponent(part)).join("/");
}

/** Plans an all-or-nothing replacement, preserving literal examples and surrounding prose. */
export function conversionEdits(text: string, group: ImportedGroup, svgPath: string, width: number): TextEdit[] {
  if (text.slice(group.start, group.end) !== group.original) throw new Error("The original figure group changed; reopen conversion from the updated manuscript");
  const parsed = parsePandocDocument(text), syntax = new MarkdownSyntax(text);
  const references = parsed.references.filter((entry) => group.children[entry.label] !== undefined && (entry.offset < group.start || entry.offset >= group.end));
  const edits: TextEdit[] = [{ start: group.start, end: group.end,
    text: `![${group.caption}](${markdownImagePath(svgPath)}){#${group.parent} width="${decimal(width / 72)}in"}` }];
  const seen = new Set<number>();
  for (const reference of references) {
    // The label offset excludes "@"; replacing the full token also keeps bare citations valid.
    let start = reference.fullOffset, end = reference.fullEndOffset;
    const span = syntax.spans.find((item) => item.contentStart <= start && end <= item.contentEnd);
    if (span || text[start - 1] === "-" || text[end] === "-" || text[end] === "{") throw new Error("A child reference has unsupported attributes or a reference range; update it before converting");
    const bracketStart = text.lastIndexOf("[", start), bracketEnd = text.indexOf("]", end);
    if (bracketStart >= 0 && bracketEnd >= 0 && !/[\r\n\[\]]/.test(text.slice(bracketStart + 1, start))
      && !/[\r\n\[\]]/.test(text.slice(end, bracketEnd))) {
      if (text.slice(bracketStart + 1, bracketEnd).trim() !== `@${reference.label}`) throw new Error("Grouped or prefixed child citations need to be split before converting");
      if (text[bracketEnd + 1] === "(") throw new Error("Linked child references cannot be converted");
      start = bracketStart; end = bracketEnd + 1;
    } else if (/\S/.test(text[start - 1] ?? "") && /[@\w]/.test(text[start - 1])) throw new Error("An ambiguous child reference cannot be converted");
    if (seen.has(start)) continue;
    seen.add(start);
    edits.push({ start, end, text: `[@${group.parent}] (${group.children[reference.label]})` });
  }
  // Explicit links are not citation tokens; reject them rather than delete their target.
  for (const destination of syntax.destinations) {
    if (destination.start >= group.start && destination.end <= group.end) continue;
    const target = text.slice(destination.start, destination.end);
    if (Object.keys(group.children).some((id) => target.includes(`#${id}`))) throw new Error("A child figure has an explicit Markdown link; update it before converting");
  }
  for (const tag of syntax.rawTags) {
    if (tag.start >= group.start && tag.end <= group.end) continue;
    if (Object.keys(group.children).some((id) => text.slice(tag.start, tag.end).includes(`#${id}`))) throw new Error("A child figure has an explicit HTML link; update it before converting");
  }
  return edits.sort((a, b) => a.start - b.start);
}

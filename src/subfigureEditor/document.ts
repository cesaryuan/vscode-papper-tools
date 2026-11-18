import { DOMParser, type Element } from "@xmldom/xmldom";
import { estimateText, validateFigure, type FigureDocument, type RichRun, type TextLine, type TextStyle } from "./model";
import { shortenLegacyIds } from "./ids";

/** Restores the actual saved wrapping even when a browser font measurement is not available yet. */
function savedLine(text: Element, style: TextStyle): TextLine {
  const runs: RichRun[] = Array.from(text.children).map(span => {
    const run: RichRun = { text: span.textContent };
    if (span.getAttribute("font-weight") === "bold") run.bold = true;
    if (span.getAttribute("font-style") === "italic") run.italic = true;
    const shift = span.getAttribute("baseline-shift");
    if (shift) run.script = shift.startsWith("-") ? "super" : "sub";
    return run;
  });
  return { runs, width: runs.reduce((sum, run) => sum + estimateText(run, style), 0) };
}

/** Expands the on-disk v2 layout into the existing editor model, pairing artwork by stable ID. */
function restoreCompactFigure(figure: Omit<FigureDocument, "version"> & { version: 2 }, root: Element): FigureDocument {
  const groups = new Map<string, Element>();
  for (const group of Array.from(root.children)) {
    const id = group.getAttribute("data-element-id");
    if (group.localName !== "g" || !id) continue;
    if (groups.has(id)) throw new Error(`Duplicate SVG artwork for ${id}`);
    groups.set(id, group);
  }
  for (const element of figure.elements) {
    const group = groups.get(element.id);
    if (!group) throw new Error(`Missing SVG artwork for ${element.id}`);
    element.style ??= { ...figure.font };
    const children = Array.from(group.children);
    if (element.kind === "panel") {
      const viewport = children.find(child => child.localName === "svg");
      const image = viewport && Array.from(viewport.children).find(child => child.localName === "image");
      element.source = image?.getAttribute("href") || image?.getAttributeNS("http://www.w3.org/1999/xlink", "href");
      element.crop ??= { left: 0, right: 0, top: 0, bottom: 0 };
    }
    // A corner label is rendered before the caption, but is not one of its wrapped lines.
    const skipLabel = element.kind === "panel" && element.label && element.labelPosition.startsWith("top-");
    element.lines = children.filter(child => child.localName === "text").slice(skipLabel ? 1 : 0)
      .map(line => savedLine(line, element.style));
  }
  return { ...figure, version: 1 };
}

/** Recognizes only our versioned editable documents, leaving ordinary SVG files untouched. */
export function parseFigureSvg(source: string): FigureDocument {
  const document = new DOMParser().parseFromString(source, "image/svg+xml");
  const metadata = Array.from(document.getElementsByTagName("metadata")).find((element) => element.getAttribute("id") === "papper-subfigure");
  if (!metadata) throw new Error("This SVG is not an editable Papper combination figure");
  const stored = JSON.parse(metadata.textContent);
  const figure: unknown = stored?.format === "papper-subfigure" && stored.version === 2
    ? restoreCompactFigure(stored, document.documentElement) : stored;
  validateFigure(figure);
  shortenLegacyIds(figure);
  return figure;
}

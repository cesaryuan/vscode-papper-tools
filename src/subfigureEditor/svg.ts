import { captionRuns, wrapText, type FigureDocument, type FigureElement, type Panel, type RichRun, type TextLine, type TextStyle } from "./model";
import { fontSegments } from "./fonts";

/** Escapes XML character data while leaving quotes readable in captions and layout JSON. */
function escapeXmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Also escapes quotes for values used inside markup attributes. */
export function escapeXml(value: string): string {
  return escapeXmlText(value).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Uses stable decimals so SVG edits remain reviewable in source control. */
export function decimal(value: number): string { return String(Math.round(value * 10000) / 10000); }

/** Serializes selected-font line geometry as ordinary SVG text and tspans. */
function textSvg(lines: TextLine[], x: number, y: number, width: number, style: TextStyle, prefix: string): string {
  const anchor = style.align === "center" ? "middle" : style.align === "right" ? "end" : "start";
  const textX = x + (style.align === "center" ? width / 2 : style.align === "right" ? width : 0);
  // Keep tspans adjacent: xml:space="preserve" would print indentation between styled runs.
  return lines.map((line, index) => `${prefix}<text x="${decimal(textX)}" y="${decimal(y + style.size + index * style.size * 1.25)}" text-anchor="${anchor}" font-family="${escapeXml(style.family)}" font-size="${decimal(style.size)}" fill="${escapeXml(style.color)}" xml:space="preserve">${line.runs.map(run => runSvg(run, style)).join("")}</text>`).join("");
}

/** Keeps rich text semantic while using explicit baseline offsets for portable superscripts. */
function runSvg(run: RichRun, style: TextStyle): string {
  const shift = run.script === "super" ? "-0.4em" : run.script === "sub" ? "0.25em" : "";
  const format = `${run.bold ? ' font-weight="bold"' : ""}${run.italic ? ' font-style="italic"' : ""}${shift ? ` font-size="70%" baseline-shift="${shift}"` : ""}`;
  return fontSegments(run.text, style).map(({ text, family }) =>
    `<tspan${family !== style.family ? ` font-family="${escapeXml(family)}"` : ""}${format}>${escapeXmlText(text)}</tspan>`).join("");
}

/** Draws one whole source image through an independent viewport so cropping never edits the source. */
function panelSvg(panel: Panel, source: string, prefix: string): string {
  const sourceWidth = 1000, sourceHeight = sourceWidth / panel.ratio;
  const { left, top, right, bottom } = panel.crop;
  const viewBox = [sourceWidth * left / 100, sourceHeight * top / 100, sourceWidth * (100 - left - right) / 100,
    sourceHeight * (100 - top - bottom) / 100].map(decimal).join(" ");
  let result = `${prefix}<svg x="${decimal(panel.x)}" y="${decimal(panel.y)}" width="${decimal(panel.width)}" height="${decimal(panel.height)}" viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet" overflow="hidden">`
    + `${prefix && prefix + "  "}<image width="${sourceWidth}" height="${decimal(sourceHeight)}" href="${escapeXml(source)}" xlink:href="${escapeXml(source)}" preserveAspectRatio="none"/>${prefix}</svg>`;
  if (panel.label && panel.labelPosition.startsWith("top-")) {
    const x = panel.labelPosition === "top-right" ? panel.x + panel.width - 4 : panel.x + 4;
    result += textSvg([{ runs: [{ text: `(${panel.label})` }], width: 0 }], x, panel.y + 2, 0,
      { ...panel.style, align: panel.labelPosition === "top-right" ? "right" : "left" }, prefix);
  }
  return result + textSvg(panel.lines ?? wrapText(captionRuns(panel), panel.width, panel.style), panel.x,
    panel.y + panel.height + panel.gap, panel.width, panel.style, prefix);
}

/** Draws the same element graph for live editing, SVG files and raster export. */
export function renderElement(element: FigureElement, resolve: (source: string) => string = (source) => source, formatted = false): string {
  const prefix = formatted ? "\n    " : "";
  const content = element.kind === "panel" ? panelSvg(element, resolve(element.source), prefix)
    : textSvg(element.lines ?? wrapText(element.runs, element.width, element.style), element.x, element.y, element.width, element.style, prefix);
  return `${formatted ? "  " : ""}<g data-element-id="${escapeXml(element.id)}">${content}${formatted ? "\n  " : ""}</g>`;
}

/** Stores editing intent; the SVG already contains image sources and measured caption lines. */
function layoutMetadata(figure: FigureDocument): string {
  const elements = figure.elements.map(element => {
    const { lines, style, ...fields } = element;
    const sameStyle = (Object.keys({ ...figure.font, ...style }) as (keyof TextStyle)[]).every(key => style[key] === figure.font[key]);
    if (fields.kind === "panel") {
      delete fields.source;
      if (Object.values(fields.crop).every(value => value === 0)) delete fields.crop;
    }
    return sameStyle ? fields : { ...fields, style };
  });
  return JSON.stringify({ ...figure, version: 2, elements }, null, 2);
}

/** Produces a standalone visible SVG with versioned layout metadata as its editable source. */
export function serializeFigure(figure: FigureDocument, resolve: (source: string) => string = (source) => source, metadata = true): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${decimal(figure.width / 72)}in" height="${decimal(figure.height / 72)}in" viewBox="0 0 ${decimal(figure.width)} ${decimal(figure.height)}">\n`
    + (metadata ? `  <metadata id="papper-subfigure">\n    ${escapeXmlText(layoutMetadata(figure)).replace(/\n/g, "\n    ")}\n  </metadata>\n` : "")
    + (figure.background === "white" ? `  <rect width="100%" height="100%" fill="white"/>\n` : "")
    + figure.elements.map((element) => renderElement(element, resolve, true) + "\n").join("") + "</svg>\n";
}

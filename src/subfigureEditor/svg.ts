import { captionRuns, wrapText, type FigureDocument, type FigureElement, type Panel, type RichRun, type TextLine, type TextStyle } from "./model";

/** Escapes XML text and attributes without interpreting source image names as markup. */
export function escapeXml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

/** Uses stable decimals so SVG edits remain reviewable in source control. */
export function decimal(value: number): string { return String(Math.round(value * 10000) / 10000); }

/** Serializes selected-font line geometry as ordinary SVG text and tspans. */
function textSvg(lines: TextLine[], x: number, y: number, width: number, style: TextStyle): string {
  const anchor = style.align === "center" ? "middle" : style.align === "right" ? "end" : "start";
  const textX = x + (style.align === "center" ? width / 2 : style.align === "right" ? width : 0);
  return lines.map((line, index) => `<text x="${decimal(textX)}" y="${decimal(y + style.size + index * style.size * 1.25)}" text-anchor="${anchor}" font-family="${escapeXml(style.family)}" font-size="${decimal(style.size)}" fill="${escapeXml(style.color)}" xml:space="preserve">${line.runs.map(runSvg).join("")}</text>`).join("");
}

/** Keeps rich text semantic while using explicit baseline offsets for portable superscripts. */
function runSvg(run: RichRun): string {
  const shift = run.script === "super" ? "-0.4em" : run.script === "sub" ? "0.25em" : "";
  return `<tspan${run.bold ? ' font-weight="bold"' : ""}${run.italic ? ' font-style="italic"' : ""}${shift ? ` font-size="70%" baseline-shift="${shift}"` : ""}>${escapeXml(run.text)}</tspan>`;
}

/** Draws one whole source image through an independent viewport so cropping never edits the source. */
function panelSvg(panel: Panel, source: string): string {
  const sourceWidth = 1000, sourceHeight = sourceWidth / panel.ratio;
  const { left, top, right, bottom } = panel.crop;
  const viewBox = [sourceWidth * left / 100, sourceHeight * top / 100, sourceWidth * (100 - left - right) / 100,
    sourceHeight * (100 - top - bottom) / 100].map(decimal).join(" ");
  let result = `<svg x="${decimal(panel.x)}" y="${decimal(panel.y)}" width="${decimal(panel.width)}" height="${decimal(panel.height)}" viewBox="${viewBox}" preserveAspectRatio="xMidYMid meet" overflow="hidden"><image width="${sourceWidth}" height="${decimal(sourceHeight)}" href="${escapeXml(source)}" xlink:href="${escapeXml(source)}" preserveAspectRatio="none"/></svg>`;
  if (panel.label && panel.labelPosition.startsWith("top-")) {
    const x = panel.labelPosition === "top-right" ? panel.x + panel.width - 4 : panel.x + 4;
    result += textSvg([{ runs: [{ text: `(${panel.label})` }], width: 0 }], x, panel.y + 2, 0,
      { ...panel.style, align: panel.labelPosition === "top-right" ? "right" : "left" });
  }
  return result + textSvg(panel.lines ?? wrapText(captionRuns(panel), panel.width, panel.style), panel.x,
    panel.y + panel.height + panel.gap, panel.width, panel.style);
}

/** Draws the same element graph for live editing, SVG files and raster export. */
export function renderElement(element: FigureElement, resolve: (source: string) => string = (source) => source): string {
  const content = element.kind === "panel" ? panelSvg(element, resolve(element.source))
    : textSvg(element.lines ?? wrapText(element.runs, element.width, element.style), element.x, element.y, element.width, element.style);
  return `<g data-element-id="${escapeXml(element.id)}">${content}</g>`;
}

/** Produces a standalone visible SVG with versioned layout metadata as its editable source. */
export function serializeFigure(figure: FigureDocument, resolve: (source: string) => string = (source) => source, metadata = true): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${decimal(figure.width / 72)}in" height="${decimal(figure.height / 72)}in" viewBox="0 0 ${decimal(figure.width)} ${decimal(figure.height)}">\n`
    + (metadata ? `<metadata id="papper-subfigure">${escapeXml(JSON.stringify(figure))}</metadata>\n` : "")
    + (figure.background === "white" ? `<rect width="100%" height="100%" fill="white"/>\n` : "")
    + figure.elements.map((element) => renderElement(element, resolve)).join("\n") + "\n</svg>\n";
}

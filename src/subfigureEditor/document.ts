import { DOMParser } from "@xmldom/xmldom";
import { validateFigure, type FigureDocument } from "./model";

/** Recognizes only our versioned editable documents, leaving ordinary SVG files untouched. */
export function parseFigureSvg(source: string): FigureDocument {
  const document = new DOMParser().parseFromString(source, "image/svg+xml");
  const metadata = Array.from(document.getElementsByTagName("metadata")).find((element) => element.getAttribute("id") === "papper-subfigure");
  if (!metadata) throw new Error("This SVG is not an editable Papper combination figure");
  const figure: unknown = JSON.parse(metadata.textContent);
  validateFigure(figure);
  return figure;
}

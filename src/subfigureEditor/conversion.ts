import * as path from "node:path";
import { imageSizeFromFile } from "image-size/fromFile";
import { hydrateFigure, portableFigure } from "./assets";
import { conversionEdits, importMarkdownGroup } from "./markdown";
import { arrangePanels, validateFigure } from "./model";
import { serializeFigure } from "./svg";

/** Prepares the SVG and citation edits together, resolving each link relative to the file that contains it. */
export async function prepareGroupConversion(text: string, cursor: number, width: number, manuscript: string, root: string) {
  const directory = path.dirname(manuscript);
  const group = importMarkdownGroup(text, cursor, width);
  // A crossref ID can contain characters such as ":" or "/" that cannot name a portable file.
  const figureId = group.parent.slice("fig:".length).replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-");
  const destination = path.join(root, `subfigure-${figureId}.svg`);
  const relativeSvg = path.relative(directory, destination).replace(/\\/g, "/");
  const edits = conversionEdits(text, group, relativeSvg, width);
  const figure = hydrateFigure(group.figure, directory);
  const warnings: string[] = [];
  // The file already needs its real panel proportions when opened outside the layout editor.
  await Promise.all(figure.elements.map(async panel => {
    if (panel.kind !== "panel" || panel.source.startsWith("data:")) return;
    try {
      const { width, height, orientation } = await imageSizeFromFile(panel.source);
      if (width > 0 && height > 0) panel.ratio = orientation >= 5 && orientation <= 8 ? height / width : width / height;
    } catch (error) {
      warnings.push(`[subfigure] Could not measure ${panel.source}: ${error}`);
    }
  }));
  arrangePanels(figure);
  validateFigure(figure);
  return { destination, edits, bytes: Buffer.from(serializeFigure(portableFigure(figure, root))), warnings };
}

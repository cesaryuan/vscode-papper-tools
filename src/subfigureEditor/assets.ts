import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { type FigureDocument, type Panel } from "./model";

export const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".webp": "image/webp", ".avif": "image/avif", ".gif": "image/gif", ".bmp": "image/bmp", ".svg": "image/svg+xml" };

/** Resolves a portable saved image reference without treating URL escapes as literal filenames. */
export function absoluteAsset(source: string, directory: string): string {
  if (source.startsWith("data:")) return source;
  if (source.startsWith("file:")) return fileURLToPath(source);
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(source)) throw new Error("Only local image files and embedded images are supported");
  if (path.isAbsolute(source)) return source;
  return path.resolve(directory, decodeURIComponent(source));
}

/** Hydrates file-relative references into session-local absolute paths for Save As and drafts. */
export function hydrateFigure(figure: FigureDocument, directory: string): FigureDocument {
  const result = structuredClone(figure);
  for (const element of result.elements) if (element.kind === "panel") {
    element.source = absoluteAsset(element.source, directory);
    if (element.linkedSource) element.linkedSource = absoluteAsset(element.linkedSource, directory);
  }
  return result;
}

/** Rebases both active and restorable links while keeping saved SVG metadata portable. */
export function portableFigure(figure: FigureDocument, directory: string): FigureDocument {
  const result = structuredClone(figure);
  for (const element of result.elements) if (element.kind === "panel") {
    for (const key of ["source", "linkedSource"] as const) {
      if (element[key] && !element[key].startsWith("data:")) element[key] = path.relative(directory, element[key]).replace(/\\/g, "/")
        .split("/").map((part) => encodeURIComponent(part)).join("/");
    }
  }
  return result;
}

/** Reads full-quality image data, recursively resolving linked images in imported SVG assets. */
export async function assetDataUri(source: string, ancestors = new Set<string>()): Promise<string> {
  if (source.startsWith("data:")) return source;
  if (ancestors.has(source)) throw new Error(`Circular SVG image reference: ${source}`);
  const type = IMAGE_TYPES[path.extname(source).toLowerCase()];
  if (!type) throw new Error(`Unsupported image type: ${path.extname(source)}`);
  let bytes = await fs.readFile(source);
  if (type === "image/svg+xml") {
    const next = new Set(ancestors).add(source);
    const document = new DOMParser().parseFromString(bytes.toString("utf8"), "image/svg+xml");
    for (const image of Array.from(document.getElementsByTagName("image"))) {
      const href = image.getAttribute("href") || image.getAttribute("xlink:href");
      if (!href || href.startsWith("#")) continue;
      const data = await assetDataUri(absoluteAsset(href, path.dirname(source)), next);
      image.setAttribute("href", data);
      image.setAttributeNS("http://www.w3.org/1999/xlink", "xlink:href", data);
    }
    bytes = Buffer.from(new XMLSerializer().serializeToString(document));
  }
  return `data:${type};base64,${bytes.toString("base64")}`;
}

/** Switches storage modes without losing a relative-link source needed to switch back. */
export async function setEmbedded(figure: FigureDocument, embedded: boolean): Promise<FigureDocument> {
  const result = structuredClone(figure);
  for (const element of result.elements) if (element.kind === "panel") {
    if (embedded && !element.source.startsWith("data:")) {
      element.linkedSource = element.source;
      element.source = await assetDataUri(element.source);
    } else if (!embedded && element.linkedSource) {
      element.source = element.linkedSource;
      delete element.linkedSource;
    }
  }
  result.embedded = embedded;
  return result;
}

/** Collects full-quality preview/export data once per distinct source in the current figure. */
export async function figureAssets(figure: FigureDocument): Promise<{ sources: Record<string, string>; failures: string[] }> {
  const sources: Record<string, string> = {}, failures: string[] = [];
  const panels = figure.elements.filter((element): element is Panel => element.kind === "panel");
  await Promise.all([...new Set(panels.map((panel) => panel.source))].map(async (source) => {
    try { sources[source] = await assetDataUri(source); }
    catch (error) { failures.push(String(error)); }
  }));
  return { sources, failures };
}

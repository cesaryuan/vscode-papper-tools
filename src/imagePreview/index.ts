import { t } from "../localization";
import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { findImageTokenAtPosition } from "./imageTokenParser";
import { getDataUriMimeType, prepareImageDataUriForHover } from "./dataUri";
import { resolveLocalPath } from "./pathResolver";
import { getSvgPreviewDimensions, pruneInlineRasterImagesToDataUriLimit, renderSvgPreviewDataUri } from "./svgPreview";
import { renderMetafilePreviewDataUri, type MetafilePreviewOptions } from "./emfPreview";
import { AsyncLruCache } from "../asyncLruCache";

type PreviewDocument = { uri: vscode.Uri };
type ImagePreviewRenderOptions = {
  metafile?: MetafilePreviewOptions;
  nestedRasterMaxDimension?: number;
};

// VS Code 1.135.0 truncates MarkdownString.value only when its length exceeds
// 100,000 JavaScript characters. Keep the complete Markdown text strictly below
// that boundary so an image destination can never be cut in the middle.
const VSCODE_MARKDOWN_VALUE_LIMIT = 100_000;
const SVG_HOVER_MAX_WIDTH = 480;
const SVG_HOVER_MAX_HEIGHT = 300;

export class ImagePreviewRenderer {
  declare output: import("vscode").OutputChannel;
  private readonly cache = new AsyncLruCache<string | undefined>(64, 16_000_000, (value) => value?.length || 0);
  /**
   * Creates a renderer for SVG, EMF, and WMF hover previews.
   *
   * @param output Output channel.
   */
  constructor(output: vscode.OutputChannel) {
    this.output = output;
  }

  /**
   * Builds a hover for a supported local image under the cursor.
   *
   * @param document Document URI used to resolve nested assets.
   * @param position Hover position.
   */
  async provideHover(document: vscode.TextDocument, position: vscode.Position) {
    const token = findImageTokenAtPosition(document, position);
    if (!token) {
      return undefined;
    }

    if (token.dataUri) {
      const markdown = await this.prepareEmbeddedHoverMarkdown(token.dataUri, token.target);
      return new vscode.Hover(markdown ?? buildImagePreviewUnavailableHover(token.target), token.range);
    }

    const imagePath = resolveLocalPath(document, token.target);
    if (!imagePath) {
      return undefined;
    }

    const markdown = await this.renderHoverMarkdown(document, imagePath, token.extension, token.target);
    return new vscode.Hover(markdown ?? buildImagePreviewUnavailableHover(token.target), token.range);
  }

  /**
   * Renders one image to a data URI, using an in-memory cache per path.
   *
   * @param document Text document.
   * @param imagePath Absolute image path.
   * @param extension Lowercase image extension.
   * @param options Optional render settings for non-hover preview contexts.
   */
  async renderToDataUri(document: PreviewDocument, imagePath: string, extension: string, options: ImagePreviewRenderOptions = {}) {
    let cacheKey;
    try {
      cacheKey = await this.createCacheKey(imagePath, extension, options);
    } catch (error) {
      this.output.appendLine(`Image preview could not read ${imagePath}: ${formatError(error)}`);
      return undefined;
    }

    const [imageKey, version] = cacheKey.split("\0");
    // Keep compression variants of the current image, but release superseded file versions.
    this.cache.deleteWhere((key) => key.startsWith(`${imageKey}\0`) && !key.startsWith(`${imageKey}\0${version}\0`));
    return this.cache.getOrCreate(cacheKey, () => this.renderToDataUriUncached(document, imagePath, extension, options));
  }

  /**
   * Creates a cache key that changes when the outer image file changes.
   *
   * @param imagePath Absolute image path.
   * @param extension Lowercase image extension.
   * @param options Optional render settings included in the cache key.
   */
  async createCacheKey(imagePath: string, extension: string, options: ImagePreviewRenderOptions = {}) {
    const stats = await fs.stat(imagePath);
    return `${JSON.stringify([extension, path.resolve(imagePath)])}\0${JSON.stringify([stats.size, stats.mtimeMs])}\0${renderOptionsCacheSuffix(options)}`;
  }

  /**
   * Renders one image without reading the preview cache.
   *
   * @param document Document URI used to resolve nested assets.
   * @param imagePath Absolute image path.
   * @param extension Lowercase image extension.
   * @param options Optional render settings for non-hover preview contexts.
   */
  async renderToDataUriUncached(document: PreviewDocument, imagePath: string, extension: string, options: ImagePreviewRenderOptions = {}) {
    if (extension === ".svg") {
      return renderSvgPreviewDataUri(document, imagePath, this.output, {
        maxNestedRasterDimension: options.nestedRasterMaxDimension,
      });
    }
    if (extension === ".emf" || extension === ".wmf") {
      return renderMetafilePreviewDataUri(imagePath, extension, this.output, {
        ...options.metafile,
        nestedRasterMaxDimension: options.nestedRasterMaxDimension ?? options.metafile?.nestedRasterMaxDimension,
      });
    }
    return undefined;
  }

  /**
   * Clears preview data held by the renderer.
   */
  dispose() {
    this.cache.clear();
  }

  /**
   * Renders a hover preview while progressively shrinking embedded raster images.
   *
   * VS Code truncates MarkdownString values above 100,000 characters. Re-rendering
   * at smaller inline-image dimensions keeps the preview as a self-contained data
   * URI while ensuring the complete Markdown image destination remains intact.
   *
   * @param document Preview document.
   * @param imagePath Absolute image path.
   * @param extension Lowercase image extension.
   * @param target Original image target used in the hover header.
   */
  private async renderHoverMarkdown(document: PreviewDocument, imagePath: string, extension: string, target: string): Promise<vscode.MarkdownString | undefined> {
    let previousLength: number | undefined;
    let smallestDataUri: string | undefined;
    let dimensionSuffix: string | undefined;
    for (const maxDimension of HOVER_NESTED_RASTER_DIMENSIONS) {
      const dataUri = await this.renderToDataUri(document, imagePath, extension, { nestedRasterMaxDimension: maxDimension });
      if (!dataUri) {
        return undefined;
      }
      smallestDataUri = dataUri;

      dimensionSuffix ??= extension === ".svg" ? getSvgHoverDimensionSuffix(dataUri) : "";
      const markdown = createImagePreviewHoverMarkdown(target, dataUri + dimensionSuffix);
      const markdownLength = markdown.value.length;
      if (markdownLength < VSCODE_MARKDOWN_VALUE_LIMIT) {
        if (maxDimension !== HOVER_NESTED_RASTER_DIMENSIONS[0]) {
          this.output.appendLine(`Image hover preview reduced inline raster images to ${maxDimension}px; final Markdown length is ${markdownLength}.`);
        }
        return markdown;
      }

      if (markdownLength !== previousLength) {
        this.output.appendLine(`Image hover preview Markdown length is ${markdownLength} at inline raster limit ${maxDimension}px; trying a smaller inline image size.`);
      }
      previousLength = markdownLength;
    }

    const prunedMarkdown = smallestDataUri ? this.pruneInlineRasterImagesForHover(target, smallestDataUri, dimensionSuffix) : undefined;
    if (prunedMarkdown) {
      return prunedMarkdown;
    }

    this.output.appendLine(`Image hover preview remains at or above VS Code's ${VSCODE_MARKDOWN_VALUE_LIMIT}-character Markdown limit after the smallest inline raster compression.`);
    return undefined;
  }

  /**
   * Prepares an embedded image data URI with the same progressive compression policy.
   *
   * @param sourceDataUri Original embedded image data URI.
   * @param target Original image target used in the hover header.
   */
  private async prepareEmbeddedHoverMarkdown(sourceDataUri: string, target: string): Promise<vscode.MarkdownString | undefined> {
    let previousLength: number | undefined;
    let smallestDataUri: string | undefined;
    let dimensionSuffix: string | undefined;
    for (const maxDimension of HOVER_NESTED_RASTER_DIMENSIONS) {
      const dataUri = await prepareImageDataUriForHover(sourceDataUri, this.output, {
        maxNestedRasterDimension: maxDimension,
      });
      if (!dataUri) {
        return undefined;
      }
      smallestDataUri = dataUri;

      dimensionSuffix ??= getSvgHoverDimensionSuffix(dataUri);
      const markdown = createImagePreviewHoverMarkdown(target, dataUri + dimensionSuffix);
      const markdownLength = markdown.value.length;
      if (markdownLength < VSCODE_MARKDOWN_VALUE_LIMIT) {
        if (maxDimension !== HOVER_NESTED_RASTER_DIMENSIONS[0]) {
          this.output.appendLine(`Embedded image hover reduced inline raster images to ${maxDimension}px; final Markdown length is ${markdownLength}.`);
        }
        return markdown;
      }

      if (markdownLength !== previousLength) {
        this.output.appendLine(`Embedded image hover Markdown length is ${markdownLength} at inline raster limit ${maxDimension}px; trying a smaller inline image size.`);
      }
      previousLength = markdownLength;
    }

    const prunedMarkdown = smallestDataUri ? this.pruneInlineRasterImagesForHover(target, smallestDataUri, dimensionSuffix) : undefined;
    if (prunedMarkdown) {
      return prunedMarkdown;
    }

    this.output.appendLine(`Embedded image hover remains at or above VS Code's ${VSCODE_MARKDOWN_VALUE_LIMIT}-character Markdown limit after the smallest inline raster compression.`);
    return undefined;
  }

  /**
   * Uses a zero-raster fallback only if 1px inline images still exceed the limit.
   *
   * @param target Original image target used in the hover header.
   * @param dataUri Smallest data URI produced by progressive raster compression.
   * @param dimensionSuffix Markdown image dimensions, preserved when nested images are pruned.
   */
  private pruneInlineRasterImagesForHover(target: string, dataUri: string, dimensionSuffix = ""): vscode.MarkdownString | undefined {
    const markdownOverhead = createImagePreviewHoverMarkdown(target, dimensionSuffix).value.length;
    const maximumDataUriLength = VSCODE_MARKDOWN_VALUE_LIMIT - markdownOverhead - 1;
    const pruned = pruneInlineRasterImagesToDataUriLimit(dataUri, maximumDataUriLength);
    if (!pruned) {
      return undefined;
    }

    const markdown = createImagePreviewHoverMarkdown(target, pruned.dataUri + dimensionSuffix);
    if (markdown.value.length >= VSCODE_MARKDOWN_VALUE_LIMIT) {
      return undefined;
    }
    this.output.appendLine(`Image hover preview removed ${pruned.removedImageCount} inline raster image node(s) after 1px compression so the final Markdown length stays below ${VSCODE_MARKDOWN_VALUE_LIMIT}.`);
    return markdown;
  }
}

/**
 * Builds the cache suffix for render options that change generated image data.
 *
 * @param options Optional render settings.
 */
function renderOptionsCacheSuffix(options: ImagePreviewRenderOptions) {
  return [
    `metafileMaxWidth=${options.metafile?.maxWidth ?? "default"}`,
    `metafileMaxHeight=${options.metafile?.maxHeight ?? "default"}`,
    `nestedRasterMaxDimension=${options.nestedRasterMaxDimension ?? "default"}`,
  ].join(",");
}

/**
 * Builds the Markdown body for a successful image preview.
 *
 * @param target Original image target.
 * @param imageSource Preview image data URI with optional Markdown dimensions.
 */
function createImagePreviewHoverMarkdown(target: string, imageSource: string) {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.appendMarkdown(t("**Image preview** `{0}`\n\n", formatImageTargetLabel(target)));
  markdown.appendMarkdown(t("![Rendered image preview]({0})", imageSource));
  return markdown;
}

/**
 * Fits SVG hovers to a compact viewport while retaining the original SVG data.
 *
 * @param dataUri Rendered hover image data URI.
 */
function getSvgHoverDimensionSuffix(dataUri: string): string {
  const dimensions = getSvgPreviewDimensions(dataUri);
  if (!dimensions) {
    return "";
  }
  const scale = Math.min(1, SVG_HOVER_MAX_WIDTH / dimensions.width, SVG_HOVER_MAX_HEIGHT / dimensions.height);
  if (scale === 1 && !dimensions.inferred) {
    return "";
  }

  // VS Code reads both dimensions from the same pipe-delimited field.
  const width = Math.max(1, Math.round(dimensions.width * scale));
  const height = Math.max(1, Math.round(dimensions.height * scale));
  return `|width=${width},height=${height}`;
}

// Try the existing 100px compression first, then progressively smaller bounds.
// The final 1px attempt is the smallest meaningful raster image and provides a
// deterministic failure boundary when SVG paths alone exceed VS Code's limit.
const HOVER_NESTED_RASTER_DIMENSIONS = [100, 80, 64, 48, 32, 24, 16, 12, 8, 4, 2, 1];

/**
 * Builds the Markdown body shown when preview rendering fails.
 *
 * @param target Original image target.
 */
function buildImagePreviewUnavailableHover(target: string) {
  const markdown = new vscode.MarkdownString(undefined, true);
  markdown.appendMarkdown(t("**Image preview** `{0}`\n\n", formatImageTargetLabel(target)));
  markdown.appendMarkdown(t("$(warning) Preview could not render. See the Papper Tools output for details."));
  return markdown;
}

/**
 * Builds a compact hover label for a file path or embedded data URI.
 *
 * @param target Original image target.
 */
function formatImageTargetLabel(target: string) {
  const mimeType = getDataUriMimeType(target);
  if (mimeType) {
    return `embedded ${mimeType}`;
  }

  return path.basename(target);
}

/**
 * Formats an unknown error for the output channel.
 *
 * @param error Error-like value.
 */
function formatError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}



import * as vscode from "vscode";
import * as fs from "node:fs/promises";
import { parsePandocDocument } from "../parser";
import { importMarkdownGroup, type ImportedGroup } from "./markdown";
import { t } from "../localization";
import { findImageTokenAtPosition } from "../imagePreview/imageTokenParser";
import { resolveLocalPath } from "../imagePreview/pathResolver";
import { parseFigureSvg } from "./document";
import { AsyncLruCache } from "../asyncLruCache";
import type { HoverActionSource, HoverContribution } from "../hoverActions";

/** Finds an editable group at its source or through a local parent/child citation. */
export function findHoveredGroup(text: string, offset: number): ImportedGroup | undefined {
  const parsed = parsePandocDocument(text);
  const reference = parsed.references.find((entry) => entry.fullOffset <= offset && offset < entry.fullEndOffset);
  const target = reference ? parsed.labels.find((entry) => entry.label === reference.label)?.fullOffset : offset;
  if (target === undefined) return undefined;
  try { return importMarkdownGroup(text, target); }
  catch { return undefined; } // Unsupported groups have no editing action because import cannot preserve them.
}

/** Offers one trusted editing action tied to the hovered document rather than the active cursor. */
export class SubfigureHoverProvider implements HoverActionSource {
  private readonly recognized = new AsyncLruCache<boolean>(64, 32_768, () => 1);

  /** Uses explicit commands for importing Markdown groups and opening existing layout SVGs. */
  constructor(private readonly command: string, private readonly editCommand: string) {}

  /** Checks actual editable metadata, caching only recognition results against the file's current version. */
  private async isCombinationSvg(filename: string): Promise<boolean> {
    const stat = await fs.stat(filename), key = JSON.stringify([filename, stat.mtimeMs, stat.ctimeMs, stat.size]);
    return this.recognized.getOrCreate(key, async () => {
      const source = await fs.readFile(filename, "utf8");
      try { parseFigureSvg(source); return true; }
      catch { return false; } // Ordinary or invalid SVG metadata must never offer the structured editor.
    });
  }

  /** Shows editing actions on supported groups, their citations, and recognized local SVG image tokens. */
  async contribute(document: vscode.TextDocument, position: vscode.Position, token?: vscode.CancellationToken): Promise<HoverContribution | undefined> {
    if (document.uri.scheme !== "file") return undefined;
    const version = document.version;
    const group = findHoveredGroup(document.getText(), document.offsetAt(position));
    if (group) return this.editLink(this.command, [document.uri.toString(), group.start, version], document.lineAt(position.line).range);
    const image = findImageTokenAtPosition(document, position);
    if (image?.extension !== ".svg" || token?.isCancellationRequested) return undefined;
    const filename = resolveLocalPath(document, image.target);
    if (!filename) return undefined;
    try {
      if (!await this.isCombinationSvg(filename) || token?.isCancellationRequested || document.version !== version) return undefined;
      return this.editLink(this.editCommand, [vscode.Uri.file(filename).toString()], image.range);
    } catch { return undefined; } // Missing or unreadable images should not break the other image hover actions.
  }

  /** Binds the shared row's editing action to the hovered image or group. */
  private editLink(command: string, args: unknown[], range: vscode.Range): HoverContribution {
    return { range, actions: [{ command, args, label: t("Edit subfigure layout"), icon: "layout" }] };
  }
}

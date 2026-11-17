import * as vscode from "vscode";
import { parsePandocDocument } from "../parser";
import { importMarkdownGroup, type ImportedGroup } from "./markdown";
import { t } from "../localization";

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
export class SubfigureHoverProvider implements vscode.HoverProvider {
  /** Uses the registered conversion command to open the existing group as an editable draft. */
  constructor(private readonly command: string) {}

  /** Shows an edit link on the group and its local parent/child references. */
  provideHover(document: vscode.TextDocument, position: vscode.Position): vscode.Hover | undefined {
    if (document.uri.scheme !== "file") return undefined;
    const group = findHoveredGroup(document.getText(), document.offsetAt(position));
    if (!group) return undefined;
    const args = encodeURIComponent(JSON.stringify([document.uri.toString(), group.start, document.version]));
    const markdown = new vscode.MarkdownString(undefined, true);
    markdown.isTrusted = { enabledCommands: [this.command] };
    markdown.appendMarkdown(`[$(layout) ${t("Edit subfigure layout")}](command:${this.command}?${args})`);
    return new vscode.Hover(markdown, document.lineAt(position.line).range);
  }
}

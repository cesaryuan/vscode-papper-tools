import { t } from "../../localization";
import * as path from "node:path";
import * as vscode from "vscode";
import { isAlias, isMap, isScalar, parseDocument, Scalar, YAMLMap } from "yaml";
import { getYamlHeader } from "../../manuscriptStyle/document";
import { SET_CSL_STYLE_COMMAND } from "../commands";

const STYLE_NAMES = new Set(["style.yml", "style.yaml", "style-project.yml", "style-project.yaml"]);

/** Recognizes supported local project style files without depending on the configuration hover provider. */
export function isCslStyleDocument(document: vscode.TextDocument): boolean {
  return document.uri.scheme === "file" && STYLE_NAMES.has(path.basename(document.uri.fsPath).toLowerCase());
}

/** Validates the metadata scope using exact public field names. */
export function getCslSettingPath(document: vscode.TextDocument, requested?: unknown): string[] {
  const style = isCslStyleDocument(document);
  if (!style && !["markdown", "mdx"].includes(document.languageId)) throw new Error(t("Open a manuscript or style.yml before setting the citation style"));
  const keys = requested === undefined ? (style ? ["pandocMetadata", "csl"] : ["csl"]) : requested;
  if (!Array.isArray(keys) || !keys.every((key) => typeof key === "string")) throw new Error(t("Invalid citation style field"));
  const settingPath = keys.join(".");
  const valid = style ? /^(reply\.)?pandocMetadata\.csl$/ : /^(csl|papperSettings\.(reply\.)?pandocMetadata\.csl)$/;
  if (!valid.test(settingPath)) throw new Error(t("Invalid citation style configuration scope"));
  return keys;
}

/** Captures just frontmatter for manuscript edits, and the full YAML document for project style edits. */
export function getCslConfigurationContent(document: vscode.TextDocument): string | undefined {
  return isCslStyleDocument(document) ? document.getText() : getYamlHeader(document.getText())?.content;
}

/** Parses a writable CSL scope and rejects shared YAML nodes that could change unrelated settings. */
function parseCslConfiguration(document: vscode.TextDocument, keys: string[]) {
  const text = document.getText();
  const header = isCslStyleDocument(document) ? undefined : getYamlHeader(text);
  const yaml = parseDocument(isCslStyleDocument(document) ? text : header?.content ?? "");
  if (yaml.errors.length) throw new Error(t("Could not parse the citation style configuration: {0}", yaml.errors[0].message));
  if (!yaml.contents || (isScalar(yaml.contents) && yaml.contents.value === null)) yaml.contents = yaml.createNode({}) as YAMLMap.Parsed;
  let node: unknown = yaml.contents;
  for (let index = 0; index <= keys.length; index++) {
    if (isAlias(node) || ((isMap(node) || isScalar(node)) && node.anchor)) throw new Error(t("Expand YAML anchors or aliases before editing the citation style configuration"));
    if (index === keys.length) {
      if (node !== undefined && !(isScalar(node) && (node.value === null || typeof node.value === "string"))) throw new Error(t("csl must be a file path string"));
    } else if (node !== undefined && !isMap(node)) throw new Error(t("The parent citation style configuration must be an object"));
    node = isMap(node) ? node.get(keys[index], true) : undefined;
  }
  return { text, header, yaml };
}

/** Validates configuration before opening the search page or downloading anything. */
export function validateCslConfiguration(document: vscode.TextDocument, keys: string[]): void {
  parseCslConfiguration(document, keys);
}

/** Updates the selected YAML scope as one undoable edit, preserving comments and revealing its new path. */
export async function applyCslConfiguration(document: vscode.TextDocument, keys: string[], value: string,
  original: string | undefined, output: vscode.OutputChannel): Promise<void> {
  const sourceEditor = vscode.window.visibleTextEditors.find((editor) => editor.document.uri.toString() === document.uri.toString());
  const editor = await vscode.window.showTextDocument(document, { viewColumn: sourceEditor?.viewColumn ?? vscode.ViewColumn.One, preserveFocus: false, preview: false });
  if (original !== getCslConfigurationContent(document)) throw new Error(t("The citation style configuration changed while editing. Try again"));
  const { text, header, yaml } = parseCslConfiguration(document, keys);
  const previous = yaml.getIn(keys, true);
  if (!isScalar(previous) || previous.value !== value) {
    const replacement = yaml.createNode(value) as Scalar;
    replacement.type = Scalar.QUOTE_DOUBLE;
    if (isScalar(previous)) {
      replacement.comment = previous.comment;
      replacement.commentBefore = previous.commentBefore;
      replacement.spaceBefore = previous.spaceBefore;
    }
    yaml.setIn(keys, replacement);
    const newline = text.includes("\r\n") ? "\r\n" : "\n";
    const serialized = yaml.toString({ lineWidth: 0 }).replace(/\n/g, newline);
    const style = isCslStyleDocument(document);
    const start = header?.start ?? (style || !text.startsWith("\uFEFF") ? 0 : 1);
    const end = header?.end ?? (style ? text.length : start);
    // A command can target an absent manuscript header; insert frontmatter rather than replacing its body.
    const content = style || header ? serialized : `---${newline}${serialized}---${newline}`;
    const range = new vscode.Range(document.positionAt(start), document.positionAt(end));
    const applied = await editor.edit(
      /** Groups the chosen scope's change into one Undo operation. */
      (builder) => builder.replace(range, content), { undoStopBefore: true, undoStopAfter: true });
    if (!applied) throw new Error(t("VS Code rejected the citation style configuration edit"));
    output.appendLine(`[CSL] Updated ${keys.join(".")} in ${document.uri.fsPath}`);
  }
  const updated = parseCslConfiguration(document, keys);
  const node = updated.yaml.getIn(keys, true);
  if (isScalar(node) && node.range) {
    const offset = updated.header?.start ?? 0;
    editor.selection = new vscode.Selection(document.positionAt(offset + node.range[0]), document.positionAt(offset + node.range[1]));
    editor.revealRange(editor.selection, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }
}

/** Adds a trusted action for the exact hovered metadata field, with no network work until clicked. */
export function appendCslConfigurationAction(markdown: vscode.MarkdownString, document: vscode.TextDocument, keys: string[]): void {
  if (document.uri.scheme !== "file") return;
  try { getCslSettingPath(document, keys); } catch { return; }
  const args = encodeURIComponent(JSON.stringify([document.uri.toString(), keys]));
  markdown.isTrusted = { enabledCommands: [SET_CSL_STYLE_COMMAND] };
  markdown.appendMarkdown(`\n\nPapper Tools: [${t("Set Citation Style")}](command:${SET_CSL_STYLE_COMMAND}?${args})`);
}

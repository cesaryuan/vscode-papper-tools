import * as vscode from "vscode";

/** A command offered at a hover target. Labels are plain text, including user-defined style names. */
export interface HoverAction {
  label: string;
  command: string;
  args: unknown[];
  /** Optional VS Code theme icon name supplied by the feature. */
  icon?: string;
}

/** Optional field help stays separate from the trusted command links. */
export interface HoverContribution {
  range: vscode.Range;
  actions: HoverAction[];
  help?: vscode.MarkdownString;
}

/** Features report applicable actions; registration order determines their order on the row. */
export interface HoverActionSource {
  contribute(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken):
    vscode.ProviderResult<HoverContribution>;
}

/** Writes the single command row shared by source hovers and VS Code's separate inlay tooltips. */
export function appendHoverActions(markdown: vscode.MarkdownString, actions: HoverAction[]): void {
  const links = new Map<string, string>(), commands = new Set<string>();
  for (const { command, args, label, icon } of actions) {
    // encodeURIComponent leaves parentheses intact; Markdown can otherwise truncate a local file URI.
    const encoded = encodeURIComponent(JSON.stringify(args)).replace(/\(/g, "%28").replace(/\)/g, "%29");
    const href = `command:${command}?${encoded}`;
    if (links.has(href)) continue;
    commands.add(command);
    const title = label.replace(/[\\`*_[\]<>$]/g, "\\$&").replace(/[\r\n]+/g, " ");
    links.set(href, `[${icon ? `$(${icon}) ` : ""}${title}](${href})`);
  }
  if (!links.size) return;
  markdown.isTrusted = { enabledCommands: [...commands] };
  markdown.appendMarkdown(`${markdown.value ? "\n\n" : ""}Papper Tools: ${[...links.values()].join(" | ")}`);
}

/** Renders one action row, scoped to the overlap so a narrow action cannot persist outside its target. */
export function renderHover(contributions: HoverContribution[]): vscode.Hover | undefined {
  if (!contributions.length) return undefined;
  const contents = contributions.flatMap(item => item.help ? [item.help] : []);
  const row = new vscode.MarkdownString(undefined, true);
  appendHoverActions(row, contributions.flatMap(item => item.actions));
  if (row.value) contents.push(row);
  const range = contributions.slice(1).reduce<vscode.Range | undefined>((overlap, item) => overlap?.intersection(item.range), contributions[0].range);
  return contents.length && range ? new vscode.Hover(contents, range) : undefined;
}

/** Owns the action-bearing Hover for one document selector, including asynchronous file recognition. */
export class PapperActionHoverProvider implements vscode.HoverProvider {
  /** Takes sources in display order and reports failures without hiding unrelated actions. */
  constructor(private readonly sources: HoverActionSource[], private readonly output: vscode.OutputChannel) {}

  /** Drops stale results when the cursor moves or the document changes during an asynchronous lookup. */
  async provideHover(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken): Promise<vscode.Hover | undefined> {
    if (token.isCancellationRequested) return undefined;
    const version = document.version;
    const results = await Promise.all(this.sources.map(async source => {
      try { return await source.contribute(document, position, token); }
      catch (error) {
        if (!token.isCancellationRequested) this.output.appendLine(`[Hover] ${source.constructor.name}: ${String(error)}`);
        return undefined;
      }
    }));
    if (token.isCancellationRequested || version !== document.version) return undefined;
    return renderHover(results.filter((item): item is HoverContribution => item != null));
  }
}

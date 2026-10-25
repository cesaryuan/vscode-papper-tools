import assert from "node:assert/strict";
import test from "node:test";
import type * as vscode from "vscode";
import type { PandocWorkspaceIndex } from "../src/workspaceIndex";
import type { MathJaxRenderer } from "../src/mathJaxRenderer";
import type { ParagraphTranslator } from "../src/paragraphTranslator";
import { parsePandocDocument } from "../src/parser";
import { prepareReferenceSource } from "../src/inlayHints/sourceReferences";
import { SourceModuleFixture } from "./helpers/sourceModule";

/** Models editor ranges while letting production code handle paragraph selection and translation. */
class Range {
  readonly start: vscode.Position;
  readonly end: vscode.Position;

  /** Supports the line/column overload used for paragraph ranges. */
  constructor(startLine: number, startCharacter: number, endLine: number, endCharacter: number) {
    this.start = { line: startLine, character: startCharacter } as vscode.Position;
    this.end = { line: endLine, character: endCharacter } as vscode.Position;
  }
}

/** Provides a buffer with independently editable version and standard UTF-16 offsets. */
function documentFixture(text: string): vscode.TextDocument {
  const lines = text.split("\n");
  const document = {
    uri: { scheme: "file", fsPath: "/article.md", /** Supplies one stable cache key. */ toString: () => "file:///article.md" },
    languageId: "markdown", version: 1, lineCount: lines.length,
    /** Maps paragraph coordinates into source offsets. */
    offsetAt: (position: vscode.Position) => lines.slice(0, position.line).reduce((sum, line) => sum + line.length + 1, 0) + position.character,
    /** Reads complete or ranged source without modifying the buffer. */
    getText: (range?: vscode.Range) => range ? text.slice(document.offsetAt(range.start), document.offsetAt(range.end)) : text,
    /** Supplies line text for paragraph boundary detection. */
    lineAt: (line: number) => ({ text: lines[line] }),
  };
  return document as unknown as vscode.TextDocument;
}

/** Exercises the real cache and hover pipeline, replacing only the editor host, Papper process, and translator. */
async function hoverFixture(text: string, buildFails = false, diff?: { original: string; discardMarkers: boolean }) {
  const document = documentFixture(text);
  const original = diff ? documentFixture(diff.original) : undefined;
  if (original) Object.assign(original, { uri: { /** Models a historical snapshot with no processed AST. */ toString: () => "git:///article.md" } });
  const requests: string[] = [];
  let refreshed: (() => void) | undefined;
  /** Supplies the active comparison input consumed by the real diff resolver. */
  class TabInputTextDiff {
    original = original?.uri;
    modified = document.uri;
  }
  const modules = new SourceModuleFixture({
    vscode: {
      Range, TabInputTextDiff,
      window: {
        tabGroups: { activeTabGroup: { activeTab: { input: diff ? new TabInputTextDiff() : undefined } } },
        visibleTextEditors: diff ? [{ diffInformation: [{
          documentVersion: 1, original: original!.uri, modified: document.uri, isStale: false,
          changes: [{ original: { startLineNumber: 1, endLineNumberExclusive: 2 },
            modified: { startLineNumber: 1, endLineNumberExclusive: 2 }, kind: 2 }],
        }] }] : [],
      },
      workspace: { /** Opens the comparison counterpart without supplying a rendered reference cache. */
        openTextDocument: async () => original },
      Position: class {
        /** Stores UTF-16 coordinates for generated reference hints. */
        constructor(public line: number, public character: number) {}
        /** Sorts public hints in source order as the editor does. */
        compareTo(other: { line: number; character: number }) { return this.line - other.line || this.character - other.character; }
      },
      EventEmitter: class {
        /** Allows the fixture to wait for the public refresh notification. */
        event(listener: () => void) { refreshed = listener; }
        /** Publishes completion of a processed document snapshot. */
        fire() { refreshed?.(); }
        /** Matches the host's disposable interface. */
        dispose() {}
      },
      InlayHint: class {
        /** Retains the actual source coordinate and rendered label. */
        constructor(public position: unknown, public label: string) {}
      },
      MarkdownString: class {
        value = "";
        /** Accumulates the user-visible hover contents. */
        appendMarkdown(value: string) { this.value += value; }
      },
      Hover: class {
        /** Retains the rendered hover so failures cannot silently count as successful translation. */
        constructor(public contents: { value: string }, public range: unknown) {}
      },
    },
    "src/configuration.ts": {
      /** Translation remains enabled while editor inlay hints are hidden. */
      getConfiguration: () => ({ /** Returns normal defaults except the features selected for this regression. */
        get: (key: string, fallback: unknown) => ({ enableNumberInlayHints: false, enableParagraphHoverTranslation: true,
          enableDiffAwareParagraphHoverTranslation: Boolean(diff) }[key] ?? fallback) }),
    },
    "src/inlayHints/actions.ts": { /** Metadata links are unrelated to translation text. */ appendInlayMetadataActions() {} },
    "src/inlayHints/build.ts": { InlayHintBuilder: class {
      /** Returns the independently built occurrence text at the process boundary. */
      async build() {
        if (buildFails) throw new Error("Papper unavailable");
        const references = prepareReferenceSource(text).references.map((reference) => ({ ...reference, displayText: "Figure 7" }));
        return { ast: { blocks: [] as unknown[] }, references };
      }
    } },
  });
  const { PandocInlayHints } = modules.load<typeof import("../src/inlayHints/provider")>("src/inlayHints/provider.ts");
  const { PandocHoverProvider } = modules.load<typeof import("../src/providers")>("src/providers.ts");
  const output = { /** Keeps a failed hover visible to assertions below through missing contents/requests. */ appendLine() {} } as unknown as vscode.OutputChannel;
  const references = new PandocInlayHints(output);
  const index = { /** Parses the actual source for token and paragraph selection. */
    getParsedDocument: () => parsePandocDocument(text, document.uri.toString()) } as unknown as PandocWorkspaceIndex;
  const translator = { /** Records exactly what the hover sends to translation and preserves structured input. */
    translateText: async (source: string) => {
      requests.push(source);
      return { text: diff?.discardMarkers ? source.replace(/<span\b[^>]*>|<\/span>/g, "") : source, engine: "google" };
    },
    /** Preserves sentence boundaries when the provider discards word markers. */
    translateTextSegments: async (texts: string[]) => { requests.push(...texts); return { texts, engine: "google" }; },
  } as unknown as ParagraphTranslator;
  const hover = new PandocHoverProvider(index, {} as MathJaxRenderer, translator, output, references);
  return { document, requests, references,
    /** Waits for the public cache refresh without inspecting private state. */
    build: () => new Promise<void>((resolve) => { references.onDidChangeInlayHints(resolve); references.scheduleRefresh(document, 0); }),
    /** Requests a prose hover away from the reference token itself. */
    translate: () => hover.provideHover(document, { line: 0, character: 0 } as vscode.Position,
      { isCancellationRequested: false } as vscode.CancellationToken),
  };
}

/** Paragraphs, lists, and tables must all send the visible reference wording to translation. */
async function translatesRenderedReferences(): Promise<void> {
  for (const source of [
    "The experimental results are shown in @fig:one.",
    "- The experimental results are shown in @fig:one.\n- Another result is consistent.",
    "| Experimental results | Reference |\n| --- | --- |\n| The result is consistent | @fig:one |",
  ]) {
    const fixture = await hoverFixture(source);
    try {
      await fixture.build();
      assert.ok(await fixture.translate());
      assert.ok(fixture.requests.some((request) => request.includes("Figure 7")));
      assert.ok(fixture.requests.every((request) => !request.includes("@fig:one")));
      assert.equal(fixture.document.getText(), source);
    } finally {
      fixture.references.dispose();
    }
  }
}

/** Pending, failed, and stale snapshots must keep authored references instead of showing the wrong number. */
async function preservesReferencesWithoutCurrentBuild(): Promise<void> {
  for (const buildFails of [false, true]) {
    const source = "The experimental results are shown in @fig:one.";
    const fixture = await hoverFixture(source, buildFails);
    try {
      assert.ok(await fixture.translate());
      assert.equal(fixture.requests.at(-1), source);
      await fixture.build();
      if (!buildFails) Object.assign(fixture.document, { version: 2 });
      assert.ok(await fixture.translate());
      assert.equal(fixture.requests.at(-1), source);
    } finally {
      fixture.references.dispose();
    }
  }
}

test("hover translates rendered references in prose, lists and tables with inlay display disabled", translatesRenderedReferences);
test("hover preserves source references while the build is pending, failed or stale", preservesReferencesWithoutCurrentBuild);

/** Both diff translation routes resolve references without inventing a change for an unchanged label. */
async function translatesDiffReferences(): Promise<void> {
  for (const discardMarkers of [false, true]) {
    const fixture = await hoverFixture("The improved results are shown in @fig:one.", false,
      { original: "The previous results are shown in @fig:one.", discardMarkers });
    try {
      await fixture.build();
      const hover = await fixture.translate();
      assert.ok(hover);
      assert.ok((hover.contents as unknown as { value: string }).value.includes("diffEditor-insertedTextBackground"));
      assert.ok(fixture.requests.every((request) => !request.includes("@fig:one")));
      assert.ok(fixture.requests[0].includes('<span data-pmt-diff="added"> improved</span>'));
      assert.ok(fixture.requests[0].includes(" shown in Figure 7."));
      if (discardMarkers) assert.ok(fixture.requests.length > 1);
    } finally {
      fixture.references.dispose();
    }
  }
}

test("diff hover resolves references for word markers and sentence fallback", translatesDiffReferences);

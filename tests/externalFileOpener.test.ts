/** Exercises file selection and failed launches without starting desktop applications during tests. */
import assert from "node:assert/strict";
import test from "node:test";
import type { Uri } from "vscode";
import { SourceModuleFixture } from "./helpers/sourceModule";

/** Models tabs backed by a saved file, including binary and custom editors. */
class FileTab {
  /** Keeps the resource selected in the editor group. */
  constructor(readonly uri: Uri) {}
}

/** Models a diff whose modified file is the external-open target. */
class DiffTab {
  /** Retains both sides to detect accidental opening of the original file. */
  constructor(readonly original: Uri, readonly modified: Uri) {}
}

/** Creates a minimal URI without loading VS Code outside its extension host. */
function fileUri(fsPath: string, scheme = "file"): Uri {
  return { fsPath, scheme } as Uri;
}

/** Loads the command with observable host boundaries and real resource-selection logic. */
function openerFixture(input?: unknown) {
  const opened: Uri[] = [];
  const windowsPaths: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const logs: string[] = [];
  const state = { launchResult: true, launchError: undefined as Error | undefined, fileType: 1 };
  const window = {
    tabGroups: { activeTabGroup: { activeTab: input ? { input } : undefined } },
    activeTextEditor: { document: { uri: fileUri("C:/previous.md") } },
    /** Records actionable warnings instead of displaying UI. */
    showWarningMessage(message: string) { warnings.push(message); },
    /** Records failures that must be visible to the user. */
    showErrorMessage(message: string) { errors.push(message); },
  };
  const fixture = new SourceModuleFixture({
    vscode: {
      window,
      env: {
        /** Models both rejection and a false result from the external launcher. */
        async openExternal(uri: Uri) {
          opened.push(uri);
          if (state.launchError) throw state.launchError;
          return state.launchResult;
        },
      },
      workspace: { fs: {
        /** Allows a file to become a directory before the command executes. */
        async stat() { return { type: state.fileType }; },
      } },
      FileType: { Directory: 2 },
      TabInputText: FileTab,
      TabInputCustom: FileTab,
      TabInputNotebook: FileTab,
      TabInputTextDiff: DiffTab,
      TabInputNotebookDiff: DiffTab,
    },
    "src/windowsFileOpener.ts": {
      /** Captures the original Unicode path without invoking PowerShell. */
      async openWindowsFile(path: string) { windowsPaths.push(path); },
    },
  });
  const { openFileWithDefaultApplication } = fixture.load<typeof import("../src/externalFileOpener")>("src/externalFileOpener.ts");
  /** Invokes the actual command with the chosen explicit resource or current tab. */
  const open = (uri?: Uri) => openFileWithDefaultApplication(uri, {
    /** Captures diagnostic details without an OutputChannel implementation. */
    appendLine(line: string) { logs.push(line); },
  } as any);
  return { open, opened, windowsPaths, warnings, errors, logs, state };
}

/** Binary tabs must win over a previously focused text editor, and explicit menu resources win over both. */
async function opensTheSelectedFile() {
  const binary = fileUri("C:/slides.pptx");
  const fixture = openerFixture(new FileTab(binary));
  await fixture.open();
  const contextFile = fileUri("C:/other.docx");
  await fixture.open(contextFile);
  assert.deepEqual(fixture.opened, [binary, contextFile]);
  assert.deepEqual(fixture.errors, []);
}
test("opens binary tabs and explicit menu files instead of a stale text editor", opensTheSelectedFile);

/** A diff opens its modified file; command invocation without a tab can use the active text editor. */
async function opensDiffAndTextFiles() {
  const modified = fileUri("C:/updated.docx");
  const diff = openerFixture(new DiffTab(fileUri("C:/old.docx"), modified));
  await diff.open();
  assert.deepEqual(diff.opened, [modified]);
  const text = openerFixture();
  await text.open();
  assert.equal(text.opened[0].fsPath, "C:/previous.md");
}
test("resolves modified diff files and active text files", opensDiffAndTextFiles);

/** Unsupported tabs and unsaved files must never silently launch an unrelated previous file. */
async function rejectsUnavailableFiles() {
  const webview = openerFixture({ viewType: "preview" });
  await webview.open();
  assert.equal(webview.opened.length, 0);
  assert.equal(webview.warnings.length, 1);
  for (const scheme of ["untitled", "git", "vscode-remote"]) {
    const fixture = openerFixture(new FileTab(fileUri("draft.docx", scheme)));
    await fixture.open();
    assert.equal(fixture.opened.length, 0);
    assert.equal(fixture.warnings.length, 1);
  }
  const directory = openerFixture(new FileTab(fileUri("C:/folder")));
  directory.state.fileType = 2;
  await directory.open();
  assert.equal(directory.opened.length, 0);
  assert.equal(directory.warnings.length, 1);
}
test("rejects unsupported tabs, virtual documents and folders", rejectsUnavailableFiles);

/** A rejected launch or false result must produce a visible failure with diagnostic context. */
async function reportsLaunchFailures() {
  for (const launchError of [undefined, new Error("No application associated")]) {
    const fixture = openerFixture(new FileTab(fileUri("C:/slides.pptx")));
    fixture.state.launchResult = false;
    fixture.state.launchError = launchError;
    await fixture.open();
    assert.equal(fixture.errors.length, 1);
    assert.match(fixture.errors[0], /slides\.pptx/);
    assert(fixture.logs.some(line => line.includes("Could not open")));
  }
}
test("reports failed default-application launches", reportsLaunchFailures);

/** Chinese names and shell metacharacters must reach the launcher unchanged. */
async function preservesUnicodePaths() {
  const uri = fileUri("C:/研究/答辩 ' & $稿件.pptx");
  const fixture = openerFixture(new FileTab(uri));
  await fixture.open();
  if (process.platform === "win32") {
    assert.deepEqual(fixture.windowsPaths, [uri.fsPath]);
    assert.deepEqual(fixture.opened, []);
  } else {
    assert.deepEqual(fixture.opened, [uri]);
  }
  assert.deepEqual(fixture.errors, []);
}
test("preserves Unicode and literal special characters in file paths", preservesUnicodePaths);

import * as vscode from "vscode";
import { t } from "./localization";
import { openWindowsFile } from "./windowsFileOpener";

/** Resolves binary/custom tabs before text editors, which can still point at an older file. */
function getActiveFileUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  if (input instanceof vscode.TabInputText || input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputNotebook) {
    return input.uri;
  }
  if (input instanceof vscode.TabInputTextDiff || input instanceof vscode.TabInputNotebookDiff) {
    return input.modified;
  }
  // A webview or other unsupported tab must not open a previously focused text file.
  return input ? undefined : vscode.window.activeTextEditor?.document.uri;
}

/** Opens the menu resource or active saved file with the system association and reports failures. */
export async function openFileWithDefaultApplication(resource: vscode.Uri | undefined, output: vscode.OutputChannel): Promise<void> {
  const uri = resource ?? getActiveFileUri();
  if (!uri || uri.scheme !== "file") {
    void vscode.window.showWarningMessage(t("Select a saved local file to open with the default application"));
    return;
  }

  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type & vscode.FileType.Directory) {
      void vscode.window.showWarningMessage(t("Select a saved local file to open with the default application"));
      return;
    }
    output.appendLine(`[Open External] Opening with the default application: ${uri.fsPath}`);
    // Reuse the Unicode-path workaround needed by Word and other Windows file associations.
    if (process.platform === "win32" && !vscode.env.remoteName && /[^\x00-\x7F]/.test(uri.fsPath)) {
      await openWindowsFile(uri.fsPath);
    } else if (!await vscode.env.openExternal(uri)) {
      throw new Error(t("The system could not open the file with its default application"));
    }
  } catch (error) {
    output.appendLine(`[Open External] Could not open ${uri.fsPath}: ${String(error)}`);
    void vscode.window.showErrorMessage(t("Could not open {0} with the default application: {1}", uri.fsPath,
      error instanceof Error ? error.message : String(error)));
  }
}

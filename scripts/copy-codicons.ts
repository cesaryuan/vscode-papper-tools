/**
 * Stages the official VS Code Codicons font, stylesheet and license for offline
 * combination-editor toolbars. Run through npm run bundle before packaging.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Copies matching CSS and font assets so Webviews never depend on an online icon service. */
async function copyCodicons(): Promise<void> {
  const source = path.resolve(__dirname, "../node_modules/@vscode/codicons");
  const target = path.resolve(__dirname, "../dist/codicons");
  await fs.mkdir(target, { recursive: true });
  for (const file of ["codicon.css", "codicon.ttf"]) await fs.copyFile(path.join(source, "dist", file), path.join(target, file));
  await fs.copyFile(path.join(source, "LICENSE"), path.join(target, "LICENSE"));
  console.log("[build] Copied Codicons font, stylesheet and license");
}

void copyCodicons();

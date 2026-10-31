/**
 * Stage PDF.js resources for offline DOCX preview Webviews.
 * Copies the matching legacy module worker, fonts, CMaps, WASM decoders and
 * license from the pinned npm dependency into dist/pdfjs before packaging.
 * Run with `tsx scripts/copy-pdfjs-assets.ts` or the normal bundle command.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";

/** Keeps the viewer and worker on the same pinned PDF.js version and retains upstream attribution. */
async function copyPdfJsAssets(): Promise<void> {
  const source = path.resolve(__dirname, "../node_modules/pdfjs-dist");
  const target = path.resolve(__dirname, "../dist/pdfjs");
  await fs.mkdir(target, { recursive: true });
  for (const directory of ["cmaps", "standard_fonts", "wasm", "iccs"]) {
    await fs.cp(path.join(source, directory), path.join(target, directory), { recursive: true });
  }
  await fs.copyFile(path.join(source, "legacy/build/pdf.worker.mjs"), path.join(target, "pdf.worker.mjs"));
  await fs.copyFile(path.join(source, "LICENSE"), path.join(target, "LICENSE"));
  console.log("[build] Copied PDF.js worker, fonts, decoders and license");
}

void copyPdfJsAssets();

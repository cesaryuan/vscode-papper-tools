# Development

[README](README.md) · [Editor guide](docs/editor-guide.md) · [Implementation notes](docs/editor-internals.md)

Use this page for source development, checks, packaging, and publication. The README covers installation and everyday manuscript work.

## Run the extension locally

Install the locked dependencies, then open this repository in VS Code:

```powershell
npm ci
```

Press **F5** and select **Run Papper Tools** to launch an Extension Development Host. The launch task bundles the extension first. Set the manuscript folder argument in `.vscode/launch.json` to a folder on your machine; use `test_project/` for the focused editing examples. Check references, formula hovers, Outline, configuration completion, settings, and previews in that window.

Run `npm run check` for the existing type checks, tests, and bundle validation before a code release.

## Papper configuration contract

Configuration definitions are owned by Papper. After building the Papper CLI,
regenerate this extension's offline contract and readable example with:

```powershell
npm run sync:papper-config -- ..\papper\target\debug\papper.exe
```

The command validates the export before replacing `assets/papper-configuration.json`
and `assets/style-project.yml`. The JSON is bundled into the extension. Runtime
queries share one cache, use a 10-second deadline, and retry when the executable's
path, size or timestamp changes; installation/update explicitly refreshes it.
Hover caches also track contract revisions. Unsupported contract versions and
failed exports keep the last working definitions.

Do not add hand-maintained configuration field lists in the extension. Papper's
contract supplies field types, descriptions, canonical enumerations, suggestions,
aliases, navigation sections and mutual-exclusion rules. UI labels and grouping
remain extension presentation data. This integration does not implement a full
JSON Schema validator or resolve manuscript configuration precedence.

## Build and Package

The editable extension sources live in `src/` as TypeScript. Helper scripts in `scripts/` are also TypeScript and run through `tsx`.

Markdown scanning is split between `src/markdownSyntax.ts` (source context and delimiter/attribute recognition) and `src/parser.ts` (editor entries and indexes). Reference inlays, style targets and element-attribute help reuse the scanner; the completion reader still handles unfinished keys and embedded page-story attributes. Preserve UTF-16 offsets and end-exclusive ranges when changing either layer. Inline constructs can cross soft breaks, but blank lines and explicit block boundaries stop recovery of unfinished input. Block indentation currently covers ordinary paragraph/list continuations and quoted fences, rather than the full Pandoc container grammar.

Keep parser regression coverage focused on observable behavior: literal examples must not generate diagnostics or highlights, quoted attributes must not truncate ranges, and text after a malformed construct must recover. Use local Pandoc AST output to investigate grammar discrepancies, retaining Papper's equation-label extensions where plain Pandoc differs. Long-line regression fixtures assert the surviving real tokens without machine-dependent timing thresholds.

For performance work, compare warmed medians on both real manuscripts and code-heavy/unfinished-input long lines. The October 2026 scanner revision reduced 4,000 code spans (48,000 characters) from about 102 ms to 3 ms, 4,000 unfinished attribute candidates (40,000 characters) from about 359 ms to 2 ms, and 16,000 backslashes from about 289 ms to 1 ms in a same-process baseline comparison. Expanded syntax handling took about 3–4 ms on 62,000–78,000-character real manuscripts, compared with about 1 ms previously. These are local measurements, not guarantees or test limits; full editor costs also include diagnostics, decorations and downstream features.

Type-check the TypeScript sources without emitting files:

```powershell
npm run typecheck
```

Bundle `src/extension.ts` and runtime dependencies into `dist/extension.js`:

```powershell
npm run bundle
```

Create an installable VSIX package with:

```powershell
npm run package:vsix
```

That command runs the repository checks, rebuilds and validates the bundle, then calls `vsce package`. Install the generated `.vsix` locally through **Extensions: Install from VSIX...** in VS Code.

## Publish to VS Code Marketplace

Marketplace publishing uses Microsoft's `vsce` CLI. This repository's publisher is `cesaryuan`; authenticate with the account authorized to publish that extension.

1. Create or open a publisher at <https://marketplace.visualstudio.com/manage/publishers/>.
2. Create an Azure DevOps Personal Access Token that can publish Marketplace extensions.
3. Log in locally:

   ```powershell
   npx vsce login <publisher-id>
   ```

4. Publish the current version:

   ```powershell
   npm run publish:marketplace
   ```

For quick patch releases, update the Marketplace package with:

```powershell
npm run publish:patch
```

`vsce publish patch` increments the patch version and publishes in one step, so use it only after the current working tree is ready to release.

The repository URL in `package.json` supplies Marketplace source links. Keep README and documentation links relative to the repository so packaging can resolve them correctly.


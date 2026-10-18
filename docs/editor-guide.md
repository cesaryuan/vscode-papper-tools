# Editor guide

[English README](../README.md) · [中文 README](../README.zh-CN.md)

Use this guide for configuration editing, reference hints, previews, and extension settings. For Papper manuscript syntax and Word output options, see the [Papper documentation](https://github.com/cesaryuan/papper#documentation).

## Style configuration editing

In table captions such as `: Results {#tbl:results cell_margin="0.1cm"}`, complete
attribute names and choices (for example `alignment="center"` or `autofit="window"`).
In `[]{t="..."}`, complete `t` first; subsequent help follows that exact type:
`toc` offers `title` and `depth`, `pageNum` offers page-number `format` values,
and `sectionBreak` offers section/header/footer options. Hover a key or value
to see its description, examples, accepted aliases and output formats. Attribute
names, descriptions and choices come from Papper's `elementAttributes` export,
including legitimate table aliases such as `cell-margin`; they are independent
of the strict camelCase spelling of YAML configuration fields.

Completion supports unfinished blocks, single/double quotes, attributes after
the cursor, and nested empty spans in quoted section stories. It preserves
existing labels and surrounding source text, suppresses already-present keys,
and ignores literal examples in frontmatter, code, comments and math. Local
Markdown/MDX files and unsaved buffers are supported. Use **Ctrl+Space** to
request suggestions explicitly. Older Papper exports lacking `elementAttributes`
retain the bundled attribute help.

Page layout settings include `docxFooter` and `docxPageWidth`. New formatting
fields without a known navigation section appear under **其他设置**. Bundled
language defaults are exported for tools; the settings window continues to show
explicit local and project values rather than claiming to resolve all build defaults.

Hover over a heading, body text, a pipe/grid table cell, or an image in a local Markdown/MDX document to see the **Papper: 设置 标题 N / 正文文本 / Table Text / Image Caption 的样式** button. Image hovers show both **设置 Image Caption 的样式** and **设置 Figure 的样式** in the same action row, allowing caption and figure formatting to be configured separately. Click the action to read the actual reference defaults, add the corresponding style under the document's YAML `papperSettings.docxStyle`, and jump to it for editing. Newly inserted fields include Chinese descriptions as inline YAML comments; existing values and comments are retained. A missing YAML header is created automatically, the manuscript body is retained, and the edit can be undone in one step. English built-in names already in YAML are reused instead of adding duplicate Chinese aliases. Table captions use their separate `Table Caption` style.

Pandoc spans such as `[revised text]{custom-style="Revision Char"}` and fenced Divs such as `::: {custom-style="Quote"}` add a **设置 Revision Char / Quote 的样式** button alongside the usual source-element action. Nested styled spans and Divs each contribute their own action. Hover contains only a single row of actions, separated by ` | ` and sharing one `Papper:` prefix. Span actions look up character styles and insert only font family, font size, font color and bold formatting; unspecified character properties continue inheriting from the surrounding paragraph. Div actions look up paragraph styles and can also insert alignment, indentation and paragraph spacing. Reference styles are matched by both name and type. If a style is absent from the reference, the action fills its configuration using actual Body Text defaults, falling back to Normal when Body Text is unavailable. Span actions still insert only supported character fields. Existing settings are preserved, including when filling previously empty style entries.

Open `style.yml`, `style.yaml`, `style-project.yml` or `style-project.yaml` in a YAML editor. Type a configuration key, or press `Ctrl+Space`, to see Papper settings with Chinese descriptions. Value suggestions include booleans, MathType backends, line numbering, table autofit and DOCX text formatting. Nested suggestions follow `pandocMetadata`, `reply`, named `docxStyle` entries and their font, indentation and paragraph-spacing blocks. Arbitrary Word style names are supported. Existing canonical keys are omitted from new-key suggestions. Papper-owned keys require exact camelCase names, such as `docxPageWidth`; kebab-case, snake_case and case variations are rejected by Papper. Pandoc metadata keeps its native spelling, such as `link-citations`.

Hover over an existing field name or value to view its Chinese description and value hints. Hover help follows nested blocks, inline mappings and custom Word style names. Comments and unknown fields do not show Papper configuration help. This uses VS Code's normal editor hover and requires `editor.hover.enabled` to be enabled.

The same completion and hover help is available in the leading YAML header of Markdown/MDX documents, including unsaved buffers. Top-level suggestions cover manuscript metadata (`title`, `authors`, `abstract`, `keywords`, `bibliography`, `reply`), Pandoc cross-reference/citation settings. Author mappings inside `authors` or `author` lists have their own field suggestions. Put local formatting/build overrides under `papperSettings`; this block supports the same nested configuration as `style.yml`, including `reply.docxStyle` and `pandocMetadata`. Top-level `reply` denotes the manuscript path for reviewer replies. Header language help accepts `---` or `...` as a closing delimiter and remains available before that delimiter is typed. YAML examples in body code fences do not receive header configuration help.

Click **Papper: 合并示例配置** above the first line to merge the bundled Papper project starter into the current editor buffer. This action requires VS Code's `editor.codeLens` setting to be enabled; the same action is available as `Papper Tools: Merge Style Example` in the Command Palette. The starter is bundled from Papper's `template/style-project.yml`, so editing does not require Papper to be installed or its repository to be available.

The merge adds missing settings recursively. Existing values, including `false`, `null`, arrays and scalar font overrides, take priority. Commented optional examples remain comments and are not enabled. Existing comments and YAML anchors are retained, although YAML indentation and spacing may be normalized. The edit is not automatically saved and can be reversed with one Undo. Applying the same starter again makes no changes. Invalid YAML, duplicate keys, multiple YAML documents and a non-mapping root are rejected before editing.

## Extension settings

In VS Code Settings, search for `@ext:cesaryuan.pandoc-manuscript-tools`. The identifiers below can also be used in `settings.json`.

- `pandocManuscriptTools.enableDiagnostics`: report undefined references and duplicate labels.
- `pandocManuscriptTools.enableNumberInlayHints`: show definition numbers and actual bibliography/cross-reference text after a short editing pause. Hints appear after each reference expression; grouped citations get one hint containing their full rendered text, including collapsed ranges and page locators. Citation styles, reference prefixes, chapter separators and subfigure references follow the build output. Hints are generated from the current buffer through one `papper build json` snapshot; `style.yml` is optional, and this background feature uses an installed Papper executable without installing one automatically. Enable `editor.inlayHints.enabled` for Markdown to display them.
- `pandocManuscriptTools.includeWorkspaceReferences`: preload workspace Markdown files for the index cache; reference lookups stay scoped to the active document except for the built-in `reply_to_reviewers.md` → `manuscript.md` definition link.
- `pandocManuscriptTools.includeLabelSymbols`: show equation, figure, and table labels in the Outline.
- `pandocManuscriptTools.highlightFencedDivs`: highlight Pandoc `fenced_divs` blocks with whole-line background colors.
- `pandocManuscriptTools.highlightBracketedSpans`: highlight Pandoc bracketed spans with inline background colors.
- `pandocManuscriptTools.foldLineExcerptCodeSpans`: fold the quoted code span in annotations such as ``(Line `quoted text`)`` until the cursor enters it.
- `pandocManuscriptTools.foldRevisionCharSpanAttributes`: fold `{...}` only when the span's `custom-style` value is exactly `Revision Char`.
- `pandocManuscriptTools.enableInlineMathParagraphHover`: show a paragraph-level hover preview for Markdown paragraphs that contain inline math.
- `pandocManuscriptTools.inlineMathParagraphHoverMaxCharacters`: maximum paragraph length, in characters, that can show an inline-math paragraph hover preview.
- `pandocManuscriptTools.enableParagraphHoverTranslation`: show a translation for eligible English Markdown paragraphs and code comments, using Google Translate when available and Microsoft Translator as a fallback.
- `pandocManuscriptTools.paragraphHoverTranslationMaxCharacters`: maximum English paragraph length, in characters, that can request a paragraph hover translation.
- `pandocManuscriptTools.paragraphHoverTranslationTargetLanguage`: target language code for paragraph hover translations, for example `zh` or `zh-TW`.
- `pandocManuscriptTools.debugParagraphHoverTranslation`: log complete translation requests and responses for debugging. Defaults to `false`; normal logs show the engine, character counts, timing, and failures.
- `pandocManuscriptTools.imageDirectoryPreviewScanDepth`: maximum subfolder depth for Image Directory Preview. `-1` (default) scans all nested folders, `0` scans only the selected folder, and a positive integer scans that many subfolder levels.
- `pandocManuscriptTools.imageDirectoryPreviewIncludedFolderKeywords`: optional case-insensitive keywords; when set, only image folders whose root-relative path contains one of these keywords are included.
- `pandocManuscriptTools.imageDirectoryPreviewExcludedFolderKeywords`: optional case-insensitive keywords; matching folders are skipped, and exclusion takes precedence over inclusion.

- `pandocManuscriptTools.enableDiffAwareParagraphHoverTranslation`: mark added or removed sentences in translation hovers when VS Code exposes diff information. Enabled by default.

## Writing, previews, and translation

Hover over an equation to see its rendered form. Paragraph-level math previews can be enabled separately with `pandocManuscriptTools.enableInlineMathParagraphHover`. Translation hovers show the service used for the current result.

Hover over a cross-reference hint and click **设置图引用 prefix** (or the equivalent table, section or equation action) to change its type's reference prefix. Hover over a figure/table definition hint to set its caption title, meaning the label before the number such as `Figure` or `Table`; the caption body is edited directly in Markdown. Mixed reference groups offer one action for each relevant type. These actions write `figPrefix`, `tblPrefix`, `secPrefix`, `eqnPrefix`, `figureTitle` or `tableTitle` at the top level of the current manuscript's YAML header, which Papper gives precedence over project style settings. They apply throughout that manuscript, work without `style.yml`, preserve existing singular/plural prefix lists, and allow empty text to remove a prefix. The edit is not automatically saved. Ordinary bibliography citation formatting continues to follow CSL.

Run **Papper: 打开设置** to open the shared settings window for the active local manuscript or project style file. The page has sections for MathType conversion and fonts, table autofit, named DOCX styles (including custom Word style names), bibliography, SVG images, margins and line/page numbers, and cross-reference prefixes/numbering. Choose the main settings scope or reply overrides. Field controls show explicit values separately from inherited project values; **应用** writes one undoable source edit and **恢复继承** removes the selected override. Manuscript formatting is written under `papperSettings`, while main Pandoc metadata uses the manuscript's top-level header fields. Project formatting is written directly to its style file. Configuration comments, manuscript prose and line endings are preserved. Settings paths use exact canonical field names, including `pandocMetadata`. Use **查看源配置** to return to YAML, and save the source document before the next build. A changed source configuration requires refresh before applying stale inputs. Reopening a source's settings reuses its existing window.

Run **Papper: 设置参考文献样式** from the Command Palette, or click the same action on a bibliography citation hint or a YAML `csl` key/value, to navigate to the shared settings window's bibliography section. Search the [Zotero Style Repository](https://www.zotero.org/styles) and [Zotero Chinese community styles](https://zotero-chinese.com/styles/) together by journal name, abbreviation, university or style name. Results label their library; Chinese community summaries and tags are searchable too. A failed library shows a warning while the other remains available, and later searches retry the failed source. The command uses the active document: a manuscript sets its top-level `csl`, while `style.yml`, `style.yaml` and the corresponding `style-project` files set `pandocMetadata.csl`. A YAML hover action retains the exact hovered scope, including per-manuscript `papperSettings.pandocMetadata` and `reply` overrides. Visiting the section loads the repository index, which is reused for later searches; opening settings or previewing a journal does not download a CSL or change configuration. After confirmation, the style is downloaded to `pandoc/csl/<style-name>.csl` in the source workspace (or beside the source when it has no workspace). Dependent journal styles are resolved into independent CSL formatting locally, retaining their overriding locale. Existing customized files are preserved by saving a numbered filename; identical files are reused. Paths resolve relative to Papper's discovered manuscript project root, or the style file's directory for project settings. The source editor selects the updated YAML value and the settings window stays open. Cancelling downloads or closing the settings page cancels pending download work. Network/download errors leave the configuration unchanged, and concurrent configuration edits are preserved.

The bibliography section displays matching journals beside a formatted preview, using each library's own sample citations and bibliography. Chinese community styles use the community's generated bilingual previews and downloadable CSL files; source identity is retained even when two libraries share a style name. Click a result or use the Up/Down arrow keys to update both preview sections; hovering or moving keyboard focus does not switch previews. Enter on a focused result selects it for preview; superscripts, italic/bold text, numbering and hanging indents are retained. Preview requests are debounced, cached and cancelled when switching results, so outdated responses cannot replace the current journal. A preview failure is shown inline and still allows using the style. Click **使用此样式** or press Enter while searching to confirm; **清空搜索** or Escape while searching clears the query. Results are limited to the first 100 matches with exact names ranked first; enter a more specific query to narrow a broad search. The current CSL path is shown at the top, and additional bibliography options are under **更多参考文献设置**.

Image hovers resolve local Markdown and HTML image references for `.svg`, `.emf`, and `.wmf` files. SVG previews are embedded as self-contained data URIs so nested local `<image href>` references can use relative paths, absolute paths, or `file://` URLs. EMF and WMF previews use the bundled libemf2svg renderer and are returned as SVG so hover and side-preview rendering use the same inline-SVG display path. Metafile previews may differ from Windows GDI for complex clipping, raster operations, gradients, or unavailable fonts.

In an SVG diff, reopen the editor with **SVG Preview**, then click **Highlight changed areas** in the preview toolbar. The button outlines changed SVG elements on each available side; click it again to hide the outlines. The comparison uses the two SVG revisions and ignores XML whitespace, so it does not require VS Code's proposed text diff API. Changes to shared definitions or styles may outline a larger area because their visual effects can extend beyond one element.

The **Synchronize zoom** button in the SVG diff preview links both panes at the current pane's zoom level and scroll position. Zoom in, zoom out, actual size, fit to window, Ctrl+mouse wheel, both scrollbars, and drag-to-pan then move both sides together. Click the button again to let each side zoom and scroll independently.

If installation through the CERNET mirror fails, the extension retries `uv tool install papper` once without a custom index.

Run **Papper Tools: Install or Update Papper** from the Command Palette (`Ctrl+Shift+P`) to install Papper with uv when it is missing or update the uv-managed Papper installation. The command is available without an open Markdown file and requires `uv` on PATH. Progress appears in a notification and the **Papper Tools** output channel. On Simplified Chinese systems in UTC+8, the command first uses the CERNET PyPI mirror and falls back to the normal index if the mirror fails. If the active Papper executable is managed by another package manager, the command asks you to update it with that manager.

## HTML preview

Save the Markdown file once, then use **Papper Tools: Preview Markdown (Papper HTML)**. The side preview includes current unsaved changes, follows source scrolling and cursor navigation, and lets you double-click an image to zoom it. Separate manuscript projects use their own local preview service.

Keep Papper up to date if preview startup reports missing editor-buffer support. Closing the preview does not stop its local service. HTML is useful for checking manuscript content; inspect final pagination in Word.

## DOCX builds

**Papper Tools: Build DOCX and Open in Word** saves the current Markdown file, builds a Word document, and opens it. Each build uses a separate temporary directory, so it does not overwrite a document already open in Word. Use Word's **Save As** to keep the result, or run `papper build docx` in the manuscript project to create the normal project output.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Hover cards do not appear | Enable `editor.hover.enabled` |
| Reference numbers or citation text are missing | Install Papper and enable `editor.inlayHints.enabled` for Markdown |
| Configuration merge action is missing above YAML | Enable `editor.codeLens` or use **Papper Tools: Merge Style Example** |
| Build or preview cannot find Papper | Install Papper, or install uv and use **Papper Tools: Install or Update Papper** |
| A reference is unresolved | Check its label and the active manuscript; normal lookups are scoped to the current document |
| Reply references cannot find manuscript labels | The built-in editor link expects `reply_to_reviewers.md` and the workspace-root `manuscript.md` |
| Need diagnostic output | Open **View → Output** and select **Papper Tools** |

Paragraph translation sends eligible text to Google Translate or Microsoft Translator. Turn off `pandocManuscriptTools.enableParagraphHoverTranslation` when you do not want to use that service.

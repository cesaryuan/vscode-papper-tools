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

Hover over a heading, body text, a pipe/grid table cell, or an image in a local Markdown/MDX document to see the **Papper Tools: Set Heading N / Body Text / Table Text / Image Caption Style** button. Image hovers show both **Set Image Caption Style** and **Set Figure Style** in the same action row, allowing caption and figure formatting to be configured separately. Click the action to read the actual reference defaults, add the corresponding style under the document's YAML `papperSettings.docxStyle`, and jump to it for editing. Newly inserted fields include Chinese descriptions as inline YAML comments; existing values and comments are retained. A missing YAML header is created automatically, the manuscript body is retained, and the edit can be undone in one step. English built-in names already in YAML are reused instead of adding duplicate Chinese aliases. Table captions use their separate `Table Caption` style.

Pandoc spans such as `[revised text]{custom-style="Revision Char"}` and fenced Divs such as `::: {custom-style="Quote"}` add a **Set Revision Char / Quote Style** button alongside the usual source-element action. Nested styled spans and Divs each contribute their own action. Hover contains only a single row of actions, separated by ` | ` and sharing one `Papper Tools:` prefix. Span actions look up character styles and insert only font family, font size, font color and bold formatting; unspecified character properties continue inheriting from the surrounding paragraph. Div actions look up paragraph styles and can also insert alignment, indentation and paragraph spacing. Reference styles are matched by both name and type. If a style is absent from the reference, the action fills its configuration using actual Body Text defaults, falling back to Normal when Body Text is unavailable. Span actions still insert only supported character fields. Existing settings are preserved, including when filling previously empty style entries.

Open `style.yml`, `style.yaml`, `style-project.yml` or `style-project.yaml` in a YAML editor. Type a configuration key, or press `Ctrl+Space`, to see Papper settings with Chinese descriptions. Value suggestions include booleans, MathType backends, line numbering, table autofit and DOCX text formatting. Nested suggestions follow `pandocMetadata`, `reply`, named `docxStyle` entries and their font, indentation and paragraph-spacing blocks. Arbitrary Word style names are supported. Existing canonical keys are omitted from new-key suggestions. Papper-owned keys require exact camelCase names, such as `docxPageWidth`; kebab-case, snake_case and case variations are rejected by Papper. Pandoc metadata keeps its native spelling, such as `link-citations`.

Hover over an existing field name or value to view its Chinese description and value hints. Hover help follows nested blocks, inline mappings and custom Word style names. Comments and unknown fields do not show Papper configuration help. This uses VS Code's normal editor hover and requires `editor.hover.enabled` to be enabled.

The same completion and hover help is available in the leading YAML header of Markdown/MDX documents, including unsaved buffers. Top-level suggestions cover manuscript metadata (`title`, `authors`, `abstract`, `keywords`, `bibliography`, `reply`), Pandoc cross-reference/citation settings. Author mappings inside `authors` or `author` lists have their own field suggestions. Put local formatting/build overrides under `papperSettings`; this block supports the same nested configuration as `style.yml`, including `reply.docxStyle` and `pandocMetadata`. Top-level `reply` denotes the manuscript path for reviewer replies. Header language help accepts `---` or `...` as a closing delimiter and remains available before that delimiter is typed. YAML examples in body code fences do not receive header configuration help.

Click **Papper Tools: Merge Style Example** above the first line to merge the bundled Papper project starter into the current editor buffer. This action requires VS Code's `editor.codeLens` setting to be enabled; the same action is available as `Papper Tools: Merge Style Example` in the Command Palette. The starter is bundled from Papper's `template/style-project.yml`, so editing does not require Papper to be installed or its repository to be available.

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

Run **Papper Tools: Open Settings** to open the shared settings window for the active local manuscript or project style file. The page has sections for MathType conversion and fonts, table autofit, named DOCX styles (including custom Word style names), bibliography, SVG images, margins and line/page numbers, and cross-reference prefixes/numbering. Choose the main settings scope or reply overrides. Field controls show explicit values separately from inherited project values; **应用** writes one undoable source edit and **恢复继承** removes the selected override. Manuscript formatting is written under `papperSettings`, while main Pandoc metadata uses the manuscript's top-level header fields. Project formatting is written directly to its style file. Configuration comments, manuscript prose and line endings are preserved. Settings paths use exact canonical field names, including `pandocMetadata`. Use **查看源配置** to return to YAML, and save the source document before the next build. A changed source configuration requires refresh before applying stale inputs. Reopening a source's settings reuses its existing window.

Run **Papper Tools: Set Citation Style** from the Command Palette, or click the same action on a bibliography citation hint or a YAML `csl` key/value, to navigate to the shared settings window's bibliography section. Search the [Zotero Style Repository](https://www.zotero.org/styles) and [Zotero Chinese community styles](https://zotero-chinese.com/styles/) together by journal name, abbreviation, university or style name. Results label their library; Chinese community summaries and tags are searchable too. A failed library shows a warning while the other remains available, and later searches retry the failed source. The command uses the active document: a manuscript sets its top-level `csl`, while `style.yml`, `style.yaml` and the corresponding `style-project` files set `pandocMetadata.csl`. A YAML hover action retains the exact hovered scope, including per-manuscript `papperSettings.pandocMetadata` and `reply` overrides. Visiting the section loads the repository index, which is reused for later searches; opening settings or previewing a journal does not download a CSL or change configuration. After confirmation, the style is downloaded to `pandoc/csl/<style-name>.csl` in the source workspace (or beside the source when it has no workspace). Dependent journal styles are resolved into independent CSL formatting locally, retaining their overriding locale. Existing customized files are preserved by saving a numbered filename; identical files are reused. Paths resolve relative to Papper's discovered manuscript project root, or the style file's directory for project settings. The source editor selects the updated YAML value and the settings window stays open. Cancelling downloads or closing the settings page cancels pending download work. Network/download errors leave the configuration unchanged, and concurrent configuration edits are preserved.

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

Run **Papper Tools: DOCX Paginated Preview (Experimental)** for an independent side panel.
Use a Papper build with embedded PDF preview support; a separate Docxide executable
is no longer required. For Remote SSH/WSL, Papper and the manuscript fonts must be
available on the extension host.

The preview reads the current editor buffer without saving it. Editing refreshes
an open preview after a 700 ms pause; configure `docxPreview.editDelay` or disable
`pandocManuscriptTools.docxPreview.refreshOnEdit` to stop edit-triggered refreshes.
Saving refreshes immediately by default. For manual refresh only, also disable
`pandocManuscriptTools.docxPreview.refreshOnSave`. **Refresh preview** uses the
current buffer immediately. Builds run serially and combine pending edits.
The viewer shares the image preview's compact, theme-aware icon toolbar, with fit
width, actual size, 50–300% zoom and physical page navigation. Hold **Ctrl** and turn
the mouse wheel over the document to zoom around the pointer; ordinary wheel input
scrolls the pages. Existing page images stay visible while zoomed pages are redrawn.
The previous/next and zoom buttons disable at their respective boundaries. It preserves
the page and relative offset across refresh, clamps the position when a document gets
shorter, and retains the last successful document when a new build or PDF load fails.
Closing the panel stops its owned service and removes its private generated files.

The build uses normal Papper DOCX settings, including configured MathType conversion,
but always resolves cross-references to static numbers instead of enabling
`docxNativeCrossref`. Ordinary Word exports still follow that setting. SVG PNG
fallbacks remain enabled so the renderer can display the pictures.
Enabled MathType equations use the Rust backend in this preview, without requiring
a MathType installation. Disabling MathType keeps native Word equations. Normal
exports keep the selected formula backend; preview formula fonts and sizes can differ.
This experimental view uses Docxide's pagination and field support, which can differ
from Word. It does not synchronize the source cursor/scroll.
Check final layout and updated table-of-contents fields in Word.

**Papper Tools: Build DOCX and Open in Word** saves the current Markdown file, builds a Word document, and opens it. Each build uses a separate temporary directory, so it does not overwrite a document already open in Word. Use Word's **Save As** to keep the result, or run `papper build docx` in the manuscript project to create the normal project output.

## Combination figures

Create a figure with **Papper Tools: Create Combination Figure**, or select local
images in Explorer and use the same command from its context menu. From a saved
Markdown manuscript, the command records the insertion point and inserts the
figure reference on first save. **Papper Tools: Edit Combination Figure** opens
an editable SVG selected in Explorer or referenced under the Markdown cursor.
Hover over a Markdown image referencing a saved combination SVG and choose
**Edit subfigure layout** to reopen that exact image, regardless of cursor position.
The action checks the file's editable layout data; ordinary SVG images do not offer it.
Ordinary SVGs remain source images; this editor only edits its own structured
combination figures.

Use **Add images** for PNG, JPEG, WebP, SVG and other supported browser image
formats. Dropping image files onto the canvas also works; dropped file bytes
without a usable local path are embedded. Local images use relative SVG links
by default. **Embed image assets** produces a self-contained SVG; toggle it off
to restore links for images originally imported from files. Keep linked images
with the SVG when moving a project. Save As recalculates relative paths.

**Panel layout** supports nested horizontal and vertical splits. Drop near a
panel's left, right, top or bottom to divide that panel's region. For example,
put A beside B, then drop C below B to obtain one image on the left and two
stacked images on the right. Drop at the figure's outer edge or anywhere in
the surrounding A4 paper whitespace to add an entire row or column around the
existing layout: below/above adds a bottom/top row, and left/right adds a column.
The side whitespace beyond the figure's left/right boundary adds a column
throughout the full paper height, including the top and bottom corners.
Between those side strips, the bottom of the A4 sheet adds a row even when
the figure occupies only the top portion of the paper.
Drop a single image on another image's centre to swap their positions. Drop
in a highlighted gap to insert between the two rows or columns, including
nested groups. During a drag the original panels stay still: a translucent
copy follows the pointer and a highlight marks the target. An edge highlight
means place beside the named image; a whole-panel highlight means swap.
Returning to the original panel or releasing without a highlight makes no edit.
Release to apply the layout as one undoable edit, or press Escape to cancel.
Captions and crops stay with their panels; labels follow the automatic numbering setting.

Drag gray dashed vertical or horizontal dividers to change adjacent regions'
relative widths or heights. Side-by-side images use equal image heights by
default; nested groups account for captions and gaps. Regions align while
images keep their aspect ratios, with unused space where needed.
With **Snap** enabled, dividers snap to 1/4, 1/3, 1/2, 2/3 and 3/4 of the
figure width or height, equal adjacent regions, cropped-image heights for
side-by-side images, and other parallel dividers. A temporary guide names the captured position.
Snapping uses a screen-sized tolerance at every zoom level; move further to
release it, hold Alt to bypass it, or turn off **Snap** for continuous resizing.
The figure width, unrelated split proportions and physical text sizes stay
unchanged. Select several panels with Shift-click to move them together.
Panels can also be dragged from the element list onto the canvas. Quick presets
on the left offer one, two or three panels per row, or a full-width first panel
followed by pairs. **Left 1 · Right 2** and **Left 2 · Right 1** create common
three-image asymmetric arrangements; remaining images go in rows below them.

Choose **Free positioning** for independent coordinates and corner resizing.
**Align and distribute** aligns the edges or centres of selected elements, or
gives them equal gaps; it does not create rows. These actions need at least two
selected elements and are disabled for panels controlled by the structured layout. In free positioning,
Arrow keys move by 1pt, Shift+Arrow by 10pt, and Alt temporarily bypasses snapping.
While moving, the selection's edges and centres snap to the canvas or other
elements, with horizontal and vertical guides showing each captured alignment.
A multiple selection snaps as one group. Guides disappear on release or
cancellation and are excluded from saved SVGs and PNG exports. The **Snap**
checkbox and Alt bypass apply to both divider resizing and free movement.
Existing SVGs without a saved layout mode open in free positioning to preserve
their manual placement. Existing row-layout SVGs keep their geometry on opening;
docking upgrades them to nested layouts. Switching to Panel layout restores its
saved structure, or starts from the row settings when no structure is saved.

**Advanced grid settings** holds the numeric controls. **Default panels per row**
(formerly Columns) is the fallback when custom counts are absent; **Custom row
counts** specifies successive rows, such as `2, 1, 3`. Row presets provide the
same arrangement visually. Changing the
default count clears custom counts. **Width weights** gives relative widths in
panel order; leave weights empty for equal image heights. Changing counts or
width weights replaces nested splits with a row arrangement. Gap and padding
changes preserve the structure. In Panel layout these changes apply immediately
and **Auto arrange** is disabled.
In Free positioning, **Auto arrange** applies the grid settings to reset manual
panel positions. Existing explicit width weights remain in use.
**Auto renumber** is enabled by default: edits assign a, b, c… from top to bottom
and left to right. Turn it off to keep existing or custom labels while moving,
adding or deleting panels. The SVG saves this choice. **Renumber** also works
as a one-time action when automatic numbering is off. Turn automatic numbering
off before editing an individual panel label.

The right inspector controls panel labels, text, typeface, point size, bold,
italic, superscript, subscript, colour and alignment. Captions wrap at the panel
width. Independent text boxes provide shared row and column titles. Crop values
are percentages removed from the original image's edges; they change the visible
area without rewriting the source image.

Select one image to show its floating **Crop image** button. In crop mode, drag
the black edge or corner handles to change the visible frame; the removed areas
remain visible under dark shading. Drag inside the frame to reposition the
image. Choose **Done** or press Enter to apply the whole crop as one undoable
edit; **Cancel** or Escape discards the session. **Reset crop** reveals the full
source again, then Done applies the reset. Clicking elsewhere on the canvas also
applies the crop. In Panel layout, regions reflow after completion; in Free
positioning, the crop frame becomes the image's new physical bounds. Captions
stay attached. Numeric crop fields remain available for precise adjustments.

**Trim whitespace**, beside **Crop image** and inside crop mode, detects uniform
outer background or transparent margins in the full source image and previews
a crop around all detected content, with a small safety margin. This includes
fine text, axes and isolated data points; internal empty areas remain intact.
Choose **Done** to apply, adjust the handles first if needed, or cancel to discard.
Detection uses a preview up to 2048 pixels on its longest side; it does not resample
the saved source. Blank sources and images without a clear uniform border leave
the crop unchanged. Cropping remains reversible through **Reset crop** and undo.

Set figure width in mm or inches. Changing it preserves manually positioned
panel proportions while keeping caption and label sizes in points. **A4 paper
reference** shows a 210 × 297mm page and the figure's width as a percentage of
A4 width; this reference is never exported and does not imply manuscript margins
or column width. **Fit** fits the page or figure in the viewport. Hold Ctrl and
scroll over the canvas to zoom around the pointer, or enter a zoom percentage.
Toolbar actions include the standard VS Code Codicons beside their labels. Screen zoom
does not change saved dimensions. Further resizing the whole image in Word,
including automatic reduction to fit the manuscript column, scales its text
too. Keep the authored width within the target column width to preserve its
point sizes. Text already inside a source image is not changed by the
layout editor.

Save the SVG to keep both visible graphics and editable layout data. The total
figure caption stays in Markdown, where Papper supplies numbering. **Export PNG**
uses the selected DPI, writes physical resolution metadata and retains the same
layout; it does not add the A4 reference or selection handles.

Every button provides a hover description. Toolbar **Undo** and **Redo** use the
same figure history as Ctrl+Z and Ctrl+Y; unavailable history actions are disabled.

To convert an existing `pandoc-crossref` group, put the cursor inside its
`::: {#fig:...}` or `<div id="fig:...">` block and run
**Papper Tools: Convert Subfigure Group to SVG**. Alternatively, hover over the
group or its parent/child citation in the current manuscript and choose
**Edit subfigure layout**. The action opens the hovered group even if the text
cursor is elsewhere. This opens an unsaved draft.
First save creates the SVG, replaces the original group with a normal SVG image
and preserves the main identifier and total caption. In the current manuscript,
simple child references become main-figure references followed by their panel
letter. Save the updated Markdown before building. One workspace undo reverses
the initial conversion, including creation of its new SVG.

Conversion supports inline Markdown images, percentage widths, basic rich
subcaptions and crop attributes. Unsupported group content, mixed reference
citations, explicit child links, unsupported attributes, conflicting output
filenames or source edits during the session stop replacement and leave the
original manuscript intact. Reopen conversion after updating the source, or
create an independent figure. References from other manuscript files are not
rewritten.

Nested SVG source images remain whole assets. Papper may rasterize a composed
SVG for DOCX compatibility; a saved SVG is not a guarantee that every Word
renderer preserves its vectors.

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

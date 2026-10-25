import assert from "node:assert/strict";
import test from "node:test";
import { prepareReferenceSource, type SourceReference } from "../src/inlayHints/sourceReferences";
import { collectRenderedReferences, replaceRenderedReferences, replaceRenderedReferenceParts } from "../src/inlayHints/references";
import { diffParagraphWords, formatDiffTranslationInput } from "../src/paragraphTranslationDiff";

/** Checks citation cluster/locator boundaries and original UTF-16 positions rather than guessed rendered numbers. */
function marksCompleteReferenceExpressions(): void {
  const text = "😀参见 @fig:one，式 @eq:x。\r\n[see @alpha; -@beta, p. 7]\r\n@alpha [pp. 3–5] 和 @alpha。\r\n[@fig:one; @fig:two]";
  const prepared = prepareReferenceSource(text);
  assert.deepEqual(prepared.references.map(({ sourceText, labels, line, character }) => ({ sourceText, labels, line, character })), [
    { sourceText: "@fig:one", labels: ["fig:one"], line: 0, character: 13 },
    { sourceText: "@eq:x", labels: ["eq:x"], line: 0, character: 21 },
    { sourceText: "[see @alpha; -@beta, p. 7]", labels: ["alpha", "beta"], line: 1, character: 26 },
    { sourceText: "@alpha [pp. 3–5]", labels: ["alpha"], line: 2, character: 16 },
    { sourceText: "@alpha", labels: ["alpha"], line: 2, character: 25 },
    { sourceText: "[@fig:one; @fig:two]", labels: ["fig:one", "fig:two"], line: 3, character: 20 },
  ]);
  assert.equal(prepared.markdown.replace(/<span data-pmt-inlay-reference="[^"]+">|<\/span>/g, ""), text);
}

/** Literal @examples must neither trigger hints nor perturb source-order matching for real references. */
function ignoresLiteralReferenceExamples(): void {
  const text = [
    "\uFEFF---", "title: '@yaml'", "...", "", "````markdown", "@fenced", "```", "@still-fenced", "````", "",
    "    @indented", "<!-- @comment", "@multiline -->", "`@code` and ``@longcode``", "\\@escaped and a@domain.example",
    '<a title="@attribute">link</a>', "[link](https://example.com/@path)", "[url]: https://example.com/@definition",
    "$@inline$", "$$", "@math", "$$", "![caption](plot.png){#fig:plot note=\"@attr\"}", "正文 @fig:real。 @paper",
  ].join("\n");
  assert.deepEqual(prepareReferenceSource(text).references.map(({ sourceText }) => sourceText), ["@fig:real", "@paper"]);
}

/** A styled span or unrelated bracketed prose must not become part of a reference's displayed text. */
function isolatesReferencesInsideStyledSpans(): void {
  const text = '[revised @fig:one]{custom-style="Revision Char"} and @paper [unrelated text]';
  assert.deepEqual(prepareReferenceSource(text).references.map(({ sourceText }) => sourceText), ["@fig:one", "@paper"]);
}

/** Constructs an independently processed AST span with no dependency on citation style or prefix settings. */
function renderedSpan(reference: SourceReference, inlines: unknown[]): unknown {
  return { t: "Span", c: [["", [], [["data-pmt-inlay-reference", reference.marker]]], inlines] };
}

/** Actual AST text can differ at each occurrence and grouped bibliography/crossrefs must remain one hint. */
function readsActualBuiltReferenceText(): void {
  const source = "[@alpha; @beta]\n@alpha\n@alpha\n[@fig:a; @fig:b]\n@eq:x\n@fig:missing";
  const prepared = prepareReferenceSource(source);
  const references = prepared.references;
  const ast = { blocks: [
    renderedSpan(references[0], [{ t: "Cite", c: [[{ citationId: "alpha", citationSuffix: [{ t: "Str", c: "must not leak" }] }], [
      { t: "Superscript", c: [{ t: "Str", c: "[" }, { t: "Link", c: [["", [], []], [{ t: "Str", c: "2–4" }], ["#ref-alpha", ""]] }, { t: "Str", c: "]" }] },
    ]] }]),
    renderedSpan(references[1], [{ t: "Str", c: "Smith" }, { t: "Space" }, { t: "Str", c: "(2024)" }]),
    renderedSpan(references[2], [{ t: "Str", c: "(Smith," }, { t: "Space" }, { t: "Str", c: "2024," }, { t: "Space" }, { t: "Str", c: "p. 7)" }]),
    renderedSpan(references[3], [{ t: "Strong", c: [{ t: "Str", c: "图 " }] }, { t: "Link", c: [["", [], []], [{ t: "Str", c: "3-3 (a–b)" }], ["#fig:a", ""]] }]),
    // linkReferences=false still produces complete plain-text reference output.
    renderedSpan(references[4], [{ t: "Str", c: "式 (2-1)" }]),
    renderedSpan(references[5], [{ t: "Str", c: "@fig:missing" }]),
  ] };
  assert.deepEqual(collectRenderedReferences(ast, references).map(({ displayText, line, character }) => ({ displayText, line, character })), [
    { displayText: "[2–4]", line: 0, character: 15 },
    { displayText: "Smith (2024)", line: 1, character: 6 },
    { displayText: "(Smith, 2024, p. 7)", line: 2, character: 6 },
    { displayText: "图 3-3 (a–b)", line: 3, character: 16 },
    { displayText: "式 (2-1)", line: 4, character: 5 },
  ]);
  assert.deepEqual(collectRenderedReferences(undefined, references), []);
}

test("marks complete reference expressions at original source positions", marksCompleteReferenceExpressions);
test("ignores reference-shaped text in metadata, code, comments, math and URLs", ignoresLiteralReferenceExamples);
test("keeps styled-span content and unrelated brackets outside reference hints", isolatesReferencesInsideStyledSpans);
test("uses actual built citation and cross-reference text per occurrence", readsActualBuiltReferenceText);

/** Quoted page stories remain attribute values even after an embedded page-number closing brace. */
function excludesNestedPageStoryAttributes(): void {
  const text = `[]{t="sectionBreak" footer='Page []{t="pageNum"} @fig:hidden @paper'}\n[see @fig:real]{title="A } B"}`;
  const prepared = prepareReferenceSource(text);
  assert.deepEqual(prepared.references.map((entry) => entry.labels), [["fig:real"]]);
  assert.equal(prepared.markdown.replace(/<span data-pmt-inlay-reference="[^"]+">|<\/span>/g, ""), text);
}

test("nested page stories cannot leak references into inlay hints", excludesNestedPageStoryAttributes);

/** Replacements use complete source occurrences so repeated citations retain their own rendered forms. */
function replacesParagraphReferences(): void {
  const paragraph = "😀 See @fig:a, [@fig:a;\r\n@fig:b], @paper [p. 7], and @paper. Keep `@fig:a` and @fig:missing.";
  const text = `---\r\ntitle: References\r\n---\r\n\r\n${paragraph}`;
  const prepared = prepareReferenceSource(text);
  const outputs = ["Fig. 2", "Figs. 2–3", "Smith (2024, p. 7)", "Smith (2024)"];
  const ast = { blocks: prepared.references.map((reference, index) =>
    renderedSpan(reference, [{ t: "Str", c: outputs[index] ?? reference.sourceText }])) };
  const references = collectRenderedReferences(ast, prepared.references);
  assert.equal(replaceRenderedReferences(paragraph, { line: 4, character: 0 }, references),
    "😀 See Fig. 2, Figs. 2–3, Smith (2024, p. 7), and Smith (2024). Keep `@fig:a` and @fig:missing.");
  const begin = paragraph.indexOf("@paper [p.");
  assert.equal(replaceRenderedReferences(paragraph.slice(begin), { line: 5, character: begin - paragraph.indexOf("\n") - 1 }, references),
    "Smith (2024, p. 7), and Smith (2024). Keep `@fig:a` and @fig:missing.");
}

/** A paragraph range cannot consume a clipped reference or substitute another expression at the same position. */
function preservesUnmatchedReferences(): void {
  const text = "See [@fig:a;\n@fig:b] and @fig:c.";
  const prepared = prepareReferenceSource(text);
  const ast = { blocks: prepared.references.map((reference) => renderedSpan(reference, [{ t: "Str", c: "Figs. 1–2" }])) };
  const references = collectRenderedReferences(ast, prepared.references);
  assert.equal(replaceRenderedReferences("See [@fig:a;", { line: 0, character: 0 }, references), "See [@fig:a;");
  assert.equal(replaceRenderedReferences("@fig:b] and @fig:x.", { line: 1, character: 0 }, references), "@fig:b] and @fig:x.");
  assert.equal(replaceRenderedReferences(text, { line: 0, character: 0 }, []), text);
}

test("replaces built paragraph references per occurrence with CRLF and UTF-16 positions", replacesParagraphReferences);
test("keeps unresolved, clipped, and mismatched reference source intact", preservesUnmatchedReferences);

/** Resolving an unchanged reference must not highlight it merely because the historical side has no built AST. */
function preservesAuthoredDiffStates(): void {
  const original = "The previous results in [@fig:a; @fig:b] are consistent.";
  const modified = "  The improved results\r\nin [@fig:a;\r\n@fig:c] are consistent.  ";
  const prepared = prepareReferenceSource(modified);
  const references = collectRenderedReferences({ blocks: [renderedSpan(prepared.references[0], [{ t: "Str", c: "Figs. 1–3" }])] }, prepared.references);
  const parts = replaceRenderedReferenceParts(diffParagraphWords(original, modified).modified, modified, { line: 0, character: 0 }, references);
  const input = formatDiffTranslationInput(parts);
  assert.ok(input.includes('<span data-pmt-diff="added"> improved</span>'));
  assert.ok(input.includes('<span data-pmt-diff="added">Figs. 1–3</span>'));
  assert.ok(!input.includes("@fig:"));

  const unchanged = modified.replace("@fig:c", "@fig:b");
  const source = prepareReferenceSource(unchanged).references[0];
  const unchangedReferences = collectRenderedReferences({ blocks: [renderedSpan(source, [{ t: "Str", c: "Figs. 1–2" }])] }, [source]);
  const unchangedParts = replaceRenderedReferenceParts(diffParagraphWords(original, unchanged).modified, unchanged, { line: 0, character: 0 }, unchangedReferences);
  assert.deepEqual(unchangedParts.filter((part) => part.kind !== "equal").map((part) => part.text), [" improved"]);
  assert.equal(unchangedParts.find((part) => part.text.includes("Figs. 1–2"))?.kind, "equal");
}

test("replaces full references after diff alignment without inventing reference changes", preservesAuthoredDiffStates);

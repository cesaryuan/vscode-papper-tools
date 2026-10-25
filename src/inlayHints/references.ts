import { asArray, asRecord, flattenAstText, normalizeWhitespace, walkAst } from "./ast";
import type { SourceReference } from "./sourceReferences";

export type ReferenceHint = { labels: string[]; sourceText: string; displayText: string; line: number; character: number };

/** Reads each marked reference's actual processed text, including citeproc clusters and unlinked crossrefs. */
export function collectRenderedReferences(ast: unknown, references: SourceReference[]): ReferenceHint[] {
  const sources = new Map(references.map((reference) => [reference.marker, reference]));
  const hints: ReferenceHint[] = [];
  walkAst(asRecord(ast)?.blocks, undefined, (node) => {
    if (node.t !== "Span") return;
    const content = asArray(node.c);
    const attributes = asArray(asArray(content?.[0])?.[2]);
    const marker = attributes?.map(asArray).find((attribute) => attribute?.[0] === "data-pmt-inlay-reference")?.[1];
    if (typeof marker !== "string") return;
    const source = sources.get(marker);
    if (!source) return;
    const displayText = normalizeWhitespace(flattenAstText(content?.[1])).trim();
    // Failed/disabled resolution must not echo the authored @token as a misleading hint.
    if (!displayText || displayText === normalizeWhitespace(source.sourceText).trim()
      || source.labels.some((label) => displayText.includes(`@${label}`))) return;
    hints.push({ labels: source.labels, sourceText: source.sourceText, displayText, line: source.line, character: source.character });
    sources.delete(marker);
  });
  return hints.sort((left, right) => left.line - right.line || left.character - right.character);
}

/** Replaces complete built reference occurrences inside a paragraph, preserving literal examples and unresolved references. */
export function replaceRenderedReferences(text: string, start: { line: number; character: number }, references: readonly ReferenceHint[]): string {
  let result = text;
  for (const edit of collectReferenceEdits(text, start, references).reverse()) {
    result = result.slice(0, edit.start) + edit.text + result.slice(edit.end);
  }
  return result;
}

type ReferenceTextPart = { text: string; kind: "equal" | "added" | "removed" };

/** Replaces complete references after source diffing, so unresolved historical snapshots cannot create false changes. */
export function replaceRenderedReferenceParts(parts: readonly ReferenceTextPart[], text: string, start: { line: number; character: number }, references: readonly ReferenceHint[]): ReferenceTextPart[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (parts.map((part) => part.text).join("") !== normalized) return [...parts];
  let offset = 0;
  const ranges = parts.map((part) => {
    const range = { ...part, start: offset, end: offset + part.text.length };
    offset = range.end;
    return range;
  });
  const result: ReferenceTextPart[] = [];
  let cursor = 0;
  /** Keeps contiguous sentence context together when a reference replacement splits its source range. */
  const appendPart = (text: string, kind: ReferenceTextPart["kind"]): void => {
    const previous = result[result.length - 1];
    if (previous?.kind === kind) previous.text += text;
    else result.push({ text, kind });
  };
  /** Copies source diff states outside each replaced reference. */
  const appendSource = (end: number): void => {
    for (const range of ranges) {
      const begin = Math.max(cursor, range.start);
      const limit = Math.min(end, range.end);
      if (begin < limit) appendPart(normalized.slice(begin, limit), range.kind);
    }
  };
  for (const edit of collectReferenceEdits(text, start, references)) {
    const begin = text.slice(0, edit.start).replace(/\s+/g, " ").trimStart().length;
    const end = begin + text.slice(edit.start, edit.end).replace(/\s+/g, " ").length;
    appendSource(begin);
    // A changed label/locator may span several diff tokens; render its complete wording with that change state.
    const changed = ranges.find((range) => range.start < end && range.end > begin && range.kind !== "equal");
    appendPart(edit.text, changed?.kind ?? "equal");
    cursor = end;
  }
  appendSource(normalized.length);
  return result;
}

/** Finds exact complete reference ranges before any translation normalization changes their offsets. */
function collectReferenceEdits(text: string, start: { line: number; character: number }, references: readonly ReferenceHint[]): { start: number; end: number; text: string }[] {
  const lines = [0];
  for (let index = 0; index < text.length; index++) if (text[index] === "\n") lines.push(index + 1);
  const edits: { start: number; end: number; text: string }[] = [];
  for (const reference of references) {
    const line = reference.line - start.line;
    if (line < 0 || line >= lines.length) continue;
    const end = lines[line] + reference.character - (line === 0 ? start.character : 0);
    const begin = end - reference.sourceText.length;
    // A range may clip a grouped/multiline citation; never replace only part of its source.
    if (begin < 0 || end > text.length || text.slice(begin, end) !== reference.sourceText) continue;
    edits.push({ start: begin, end, text: reference.displayText });
  }
  return edits.sort((left, right) => left.start - right.start);
}

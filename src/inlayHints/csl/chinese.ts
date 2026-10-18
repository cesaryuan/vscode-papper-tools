import { t } from "../../localization";
import type { ZoteroPreview, ZoteroStyle } from "./zotero";

export const CHINESE_STYLES_ORIGIN = "https://zotero-chinese.com";
type ReadResource = (url: string, signal?: AbortSignal) => Promise<string>;

/** Allows Unicode repository filenames while rejecting paths, Windows reserved names and traversal segments. */
export function isCommunityPathSegment(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length < 240
    && !/[<>:"/\\|?*\u0000-\u001f]/.test(value) && !/[. ]$/.test(value) && value !== "." && value !== ".."
    && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);
}

/** Decodes a published JSON string literal as data; remote JavaScript is never evaluated. */
function readJsonLiteral(source: string, start: number): unknown {
  const quote = source[start];
  let value = "";
  for (let index = start + 1; index < source.length; index++) {
    const char = source[index];
    if (char === quote) return JSON.parse(value);
    if (quote === "`" && char === "$" && source[index + 1] === "{") throw new Error(t("The Chinese community style index contains non-JSON content"));
    if (char !== "\\") { value += char; continue; }
    const escape = source[++index];
    const simple: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" };
    if (escape === "u" || escape === "x") {
      const length = escape === "u" ? 4 : 2;
      const digits = source.slice(index + 1, index + 1 + length);
      if (!new RegExp(`^[a-f0-9]{${length}}$`, "i").test(digits)) throw new Error(t("Invalid character escape in the Chinese community style index"));
      value += String.fromCharCode(parseInt(digits, 16)); index += length;
    } else if (escape === "\n" || escape === "\r") {
      if (escape === "\r" && source[index + 1] === "\n") index++;
    } else value += simple[escape] ?? escape;
  }
  throw new Error(t("The Chinese community style index is incomplete"));
}

/** Reads the site's generated summary array without depending on its changing variable names or asset hashes. */
export function parseCommunityIndex(source: string): ZoteroStyle[] {
  for (const match of source.matchAll(/JSON\.parse\(\s*(['"`])/g)) {
    let data: unknown;
    try { data = readJsonLiteral(source, match.index + match[0].length - 1); } catch { continue; }
    if (!Array.isArray(data)) continue;
    const styles: ZoteroStyle[] = [];
    for (const entry of data) {
      if (!entry || typeof entry !== "object" || typeof entry.title !== "string"
        || !isCommunityPathSegment(entry.dir) || !isCommunityPathSegment(entry.file) || !entry.file.endsWith(".csl")
        || typeof entry.key !== "string" || !/^[a-f0-9]{1,16}$/.test(entry.key)) continue;
      styles.push({ name: `zotero-chinese-${entry.key}`, title: entry.title, source: "chinese",
        format: typeof entry.citation_format === "string" ? entry.citation_format : undefined,
        searchText: [entry.dir, entry.summary, ...(Array.isArray(entry.tags) ? entry.tags : [])].filter(value => typeof value === "string").join(" "),
        community: { directory: entry.dir, file: entry.file, previewKey: entry.key } });
    }
    if (styles.length) return styles;
  }
  throw new Error(t("The Chinese community style index format has changed and cannot be read"));
}

/** Discovers the site's current assets because the community publishes its summary index in a hashed bundle. */
export async function loadCommunityStyles(read: ReadResource): Promise<ZoteroStyle[]> {
  const page = await read(`${CHINESE_STYLES_ORIGIN}/styles/`);
  const theme = page.match(/(?:\/?assets\/chunks\/theme\.[a-zA-Z0-9_-]+\.js)/)?.[0];
  if (!theme) throw new Error(t("Could not find the Chinese community style index entry point"));
  const themeSource = await read(`${CHINESE_STYLES_ORIGIN}/${theme.replace(/^\//, "")}`);
  const cards = themeSource.match(/StyleCards\.[a-zA-Z0-9_-]+\.js/)?.[0];
  if (!cards) throw new Error(t("Could not find the Chinese community style list"));
  return parseCommunityIndex(await read(`${CHINESE_STYLES_ORIGIN}/assets/chunks/${cards}`));
}

/** Adapts community-generated sample HTML to the existing sanitized citation/bibliography preview. */
export function parseCommunityPreview(text: string): ZoteroPreview {
  const data: unknown = JSON.parse(text);
  const record = data as Record<string, unknown>;
  if (!record || typeof record.citations !== "string" || typeof record.bibliography !== "string") throw new Error(t("Invalid Chinese community style preview format"));
  return { citations: [record.citations], bibliography: record.bibliography };
}

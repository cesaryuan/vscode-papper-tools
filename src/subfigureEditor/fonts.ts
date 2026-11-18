import type { TextStyle } from "./model";

export const DEFAULT_CHINESE_FONT = "SimSun";
// Use the same ranges in editable HTML and exported SVG, including full-width punctuation and supplementary Han.
const ranges = ["2E80-303F", "3100-312F", "31A0-31BF", "31C0-31EF", "3400-4DBF", "4E00-9FFF", "F900-FAFF",
  "FE10-FE1F", "FE30-FE4F", "FF01-FF60", "20000-2FA1F", "30000-323AF"];
export const chineseUnicodeRange = ranges.map(range => `U+${range}`).join(",");
const characterClass = ranges.map(range => range.split("-").map(hex => `\\u{${hex}}`).join("-")).join("");
const chunks = new RegExp(`([${characterClass}]+)|[^${characterClass}]+`, "gu");

/** Groups consecutive characters using the same face without splitting the user's rich-text runs in metadata. */
export function fontSegments(text: string, style: TextStyle): { text: string; family: string }[] {
  return Array.from(text.matchAll(chunks), match => ({ text: match[0], family: match[1] ? style.cjkFamily || DEFAULT_CHINESE_FONT : style.family }));
}

/** Quotes an installed font as one CSS string, including names with spaces or punctuation. */
export function quotedFont(family: string): string {
  return `"${family.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/[\r\n\f]/g, " ")}"`;
}

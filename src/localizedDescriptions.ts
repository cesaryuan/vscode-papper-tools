import descriptions from "./schemaDescriptions.json";
import { t } from "./localization";

/** Localizes known Papper export descriptions, preserving help from newer or custom contracts verbatim. */
export function localizeDescription(description: string): string {
  return t((descriptions as Record<string, string>)[description] ?? description);
}

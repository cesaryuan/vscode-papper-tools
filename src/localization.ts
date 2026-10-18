type TranslationBundle = Record<string, string | { message: string }>;
type Translator = (message: string, ...args: (string | number | boolean)[]) => string;

let messages: TranslationBundle = {};
let language = "en";
let hostTranslator: Translator | undefined;

/** Shares VS Code's selected language and bundle with host code and standalone webviews. */
export function configureLocalization(bundle: TranslationBundle = {}, locale = "en", translator?: Translator): void {
  messages = bundle;
  language = locale;
  hostTranslator = translator;
}

/** Translates complete messages and substitutes arguments once, preserving braces in user content. */
export function t(message: string, ...args: (string | number | boolean)[]): string {
  if (hostTranslator) return hostTranslator(message, ...args);
  const translation = messages[message];
  return (typeof translation === "string" ? translation : translation?.message ?? message)
    .replace(/\{(\d+)\}/g, (placeholder, index: string) => Number(index) < args.length ? String(args[Number(index)]) : placeholder);
}

/** Returns the editor language for webview accessibility and locale-sensitive formatting. */
export function getLanguage(): string { return language; }

/** Escapes translated text for HTML content and attributes, including translated quote characters. */
export function htmlMessage(message: string, ...args: (string | number | boolean)[]): string {
  return t(message, ...args).replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Escapes serialized data so paths or translations cannot terminate an HTML script element. */
export function serializeLocalization(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/** Supplies the same translations to a browser without importing the VS Code host API. */
export function getWebviewLocalization(): string { return serializeLocalization({ messages, language }); }

/** Builds the small translator used by existing inline webview controllers. */
export function getWebviewLocalizationScript(): string {
  return `const localization = ${getWebviewLocalization()};
/** Translates UI messages without interpreting user arguments as markup or placeholders. */
function t(message, ...args) {
  const translation = localization.messages[message];
  return (typeof translation === 'string' ? translation : translation?.message ?? message)
    .replace(/\\{(\\d+)\\}/g, (placeholder, index) => Number(index) < args.length ? String(args[Number(index)]) : placeholder);
}`;
}

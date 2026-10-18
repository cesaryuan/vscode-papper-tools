/** Exercises language fallback, safe Webview rendering and source edits through the production localization paths. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { runInNewContext, Script } from "node:vm";
import { SourceModuleFixture } from "./helpers/sourceModule";

const chinese = JSON.parse(readFileSync("l10n/bundle.l10n.zh-cn.json", "utf8")) as Record<string, string>;

/** Loads an isolated language state so one locale cannot leak into another test. */
function localizedFixture(bundle: Record<string, string> = {}, language = "en") {
  const fixture = new SourceModuleFixture({ vscode: {} });
  const localization = fixture.load<typeof import("../src/localization")>("src/localization.ts");
  localization.configureLocalization(bundle, language);
  return { fixture, localization };
}

test("host and browser translators preserve arguments, reorder placeholders and fall back to English", () => {
  const { localization } = localizedFixture({ "Move {0} to {1}": "{1} ← {0}; {0}" }, "zh-cn");
  const path = 'C:\\研究\\{1} & "figure".svg';
  const expected = `archive ← ${path}; ${path}`;
  assert.equal(localization.t("Move {0} to {1}", path, "archive"), expected);
  assert.equal(localization.t("Missing {0}", path), `Missing ${path}`);
  assert.equal(localization.t("Unfilled {1}", "first"), "Unfilled {1}");
  const browser = `${localization.getWebviewLocalizationScript()}\nt('Move {0} to {1}', input, 'archive')`;
  assert.equal(runInNewContext(browser, { input: path }), expected);
  assert.equal(runInNewContext(`${localization.getWebviewLocalizationScript()}\nt('Missing {0}', input)`, { input: path }), `Missing ${path}`);
  const calls: unknown[][] = [];
  /** Models VS Code's translator and verifies the wrapper delegates original messages and arguments unchanged. */
  const host = (message: string, ...args: (string | number | boolean)[]) => {
    calls.push([message, ...args]);
    return "host result";
  };
  localization.configureLocalization({}, "en", host);
  assert.equal(localization.t("Move {0} to {1}", path, "archive"), "host result");
  assert.deepEqual(calls, [["Move {0} to {1}", path, "archive"]]);
});

test("translations and file names cannot break HTML attributes or terminate Webview scripts", () => {
  const unsafe = '</script><img src=x onerror="alert(1)"> & \u2028\u2029';
  const { fixture, localization } = localizedFixture({ ...chinese, "Papper Tools Settings": unsafe, "Apply": unsafe }, "zh-cn");
  const escaped = localization.htmlMessage("Missing: {0}", unsafe);
  assert(!escaped.includes("<") && !escaped.includes('"'));
  assert(escaped.includes("&lt;/script&gt;") && escaped.includes("&quot;"));
  const serialized = localization.getWebviewLocalization();
  assert(!serialized.includes("</script>") && !serialized.includes("\u2028"));
  assert.equal(JSON.parse(serialized).messages.Apply, unsafe);
  assert.equal(runInNewContext(`${localization.getWebviewLocalizationScript()}\nt('Apply')`), unsafe);
  const { buildPapperSettingsHtml } = fixture.load<typeof import("../src/papperSettings/html")>("src/papperSettings/html.ts");
  const html = buildPapperSettingsHtml();
  assert(!html.includes('<img src=x onerror='));
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/g)];
  assert.equal(scripts.length, 1);
  new Script(scripts[0][1]);
});

test("English and Chinese settings pages deliver working dynamic translations", () => {
  for (const [language, bundle] of [["en", {}], ["zh-cn", chinese]] as const) {
    const { fixture, localization } = localizedFixture(bundle, language);
    const { buildPapperSettingsHtml } = fixture.load<typeof import("../src/papperSettings/html")>("src/papperSettings/html.ts");
    const html = buildPapperSettingsHtml();
    assert(html.includes(`lang="${language}"`));
    assert(html.includes(localization.htmlMessage("Math and MathType")));
    const script = html.match(/<script\b[^>]*>([\s\S]*?)<\/script>/)?.[1];
    assert(script);
    new Script(script);
    const browser = runInNewContext(`${localization.getWebviewLocalizationScript()}\nt('Inherited value: {0}', '自定义 {0}')`);
    assert.equal(browser, localization.t("Inherited value: {0}", "自定义 {0}"));
  }
});

test("locale changes preserve source edits, custom Word style names and hover command arguments", () => {
  const source = '\uFEFF---\r\ntitle: 研究 # keep\r\n---\r\n正文 with $x$ and @fig:研究\r\n';
  const results: Array<{ edit: unknown; commands: unknown[]; error: string }> = [];
  for (const [language, bundle] of [["en", {}], ["zh-cn", chinese]] as const) {
    const { fixture } = localizedFixture(bundle, language);
    const model = fixture.load<typeof import("../src/papperSettings/model")>("src/papperSettings/model.ts");
    const edit = model.createSettingsEdit(source, false, ["papperSettings", "docxStyle", "自定义 {0}", "fontSize"], "10.5pt");
    const actions = fixture.load<typeof import("../src/inlayHints/actions")>("src/inlayHints/actions.ts");
    const tooltip = { value: "", isTrusted: undefined as unknown,
      /** Collects real Markdown so the test checks the command payload emitted to VS Code. */
      appendMarkdown(text: string) { this.value += text; return this; },
    };
    actions.appendInlayMetadataActions(tooltip as any, "file:///研究.md", ["figPrefix", "csl"], {});
    const commands = [...tooltip.value.matchAll(/\]\(command:([^?]+)\?([^)]+)\)/g)]
      .map((match) => [match[1], JSON.parse(decodeURIComponent(match[2]))]);
    assert.equal(commands.length, 2);
    let error = "";
    try { model.createSettingsEdit(source, false, ["papperSettings", "mathtype"], "invalid"); }
    catch (caught) { error = (caught as Error).message; }
    assert(error);
    results.push({ edit, commands, error });
  }
  assert.deepEqual(results[0].edit, results[1].edit);
  assert.deepEqual(results[0].commands, results[1].commands);
  assert.notEqual(results[0].error, results[1].error);
  const edit = results[0].edit as { start: number; end: number; text: string };
  const updated = source.slice(0, edit.start) + edit.text + source.slice(edit.end);
  assert(updated.includes("自定义 {0}") && updated.endsWith("正文 with $x$ and @fig:研究\r\n"));
});

import { t, htmlMessage, getLanguage, getWebviewLocalizationScript } from "../../localization";
import { randomBytes } from "node:crypto";

export type PickerShell = { styles: string; before: string; after: string; script: string };

/** Builds the CSL search page; the extension supplies results and safe previews through the webview message bridge. */
export function buildCslPickerHtml(shell?: PickerShell): string {
  const nonce = randomBytes(18).toString("base64");
  return `<!DOCTYPE html><html lang="${htmlMessage(getLanguage())}"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<title>${htmlMessage(shell ? "Papper Tools Settings" : "Set Citation Style")}</title>
<style>
* { box-sizing: border-box; } body { margin:0; color:var(--vscode-foreground); background:var(--vscode-editor-background); font:var(--vscode-font-size,13px) var(--vscode-font-family,sans-serif); }
.page { display:flex; flex-direction:column; height:100vh; padding:24px; gap:18px; }
header h1 { margin:0 0 6px; font-size:21px; font-weight:600; } .muted { color:var(--vscode-descriptionForeground); } header p { margin:0; }
.toolbar { display:flex; gap:10px; } input { flex:1; min-width:0; border:1px solid var(--vscode-input-border,transparent); background:var(--vscode-input-background); color:var(--vscode-input-foreground); padding:10px 12px; font:inherit; border-radius:3px; }
.sources-warning { color:var(--vscode-descriptionForeground); font-size:12px; } .sources-warning:empty { display:none; }
input:focus { outline:1px solid var(--vscode-focusBorder); } button { font:inherit; cursor:pointer; border:0; border-radius:3px; padding:9px 14px; background:var(--vscode-button-background); color:var(--vscode-button-foreground); }
button:hover { background:var(--vscode-button-hoverBackground); } button:focus-visible { outline:1px solid var(--vscode-focusBorder); outline-offset:2px; } button:disabled { opacity:.5; cursor:default; }
.secondary { background:var(--vscode-button-secondaryBackground); color:var(--vscode-button-secondaryForeground); }
.content { display:grid; grid-template-columns:minmax(220px,34%) minmax(0,1fr); gap:24px; min-height:0; flex:1; }
.results { display:flex; flex-direction:column; min-height:0; } #count { padding-bottom:10px; } #list { overflow:auto; flex:1; border:1px solid var(--vscode-panel-border); border-radius:4px; }
.item { width:100%; display:block; text-align:left; border-radius:0; color:var(--vscode-foreground); background:transparent; padding:11px 13px; border-bottom:1px solid var(--vscode-panel-border); }
.item:hover { background:var(--vscode-list-hoverBackground); } .item[aria-selected="true"] { background:var(--vscode-list-activeSelectionBackground); color:var(--vscode-list-activeSelectionForeground); }
.name { display:block; font-weight:500; line-height:1.4; } .format { display:block; opacity:.75; font-size:12px; margin-top:4px; }
.preview { overflow:auto; border:1px solid var(--vscode-panel-border); padding:20px 24px; border-radius:4px; }
#style-title { font-size:18px; line-height:1.4; margin:0 0 6px; } #style-format { margin:0 0 20px; }
#sample h2 { font-family:var(--vscode-font-family,sans-serif); font-size:15px; margin:22px 0 12px; font-weight:600; }
#sample { font:16px/1.65 "Times New Roman",serif; overflow-wrap:anywhere; } #sample .csl-entry { margin-bottom:14px; } #sample .csl-bib-body::after { content:""; display:block; clear:both; }
/* Zotero's fixed float widths can wrap or overlap longer labels; size the number column to its contents. */
#sample .csl-entry:has(> .csl-left-margin) { display:grid; grid-template-columns:minmax(3ch,max-content) minmax(0,1fr); column-gap:.65em; }
#sample .csl-entry > .csl-left-margin { float:none !important; width:auto !important; white-space:nowrap; overflow-wrap:normal; }
#sample .csl-entry > .csl-right-inline { float:none !important; width:auto !important; margin-left:0 !important; }
.notice { font:var(--vscode-font-size,13px) var(--vscode-font-family,sans-serif); color:var(--vscode-descriptionForeground); } footer { display:flex; justify-content:space-between; gap:12px; align-items:center; }
@media(max-width:650px) { .page { padding:14px; } .content { grid-template-columns:1fr; grid-template-rows:minmax(140px,38%) minmax(0,1fr); gap:14px; } .preview { padding:14px; } footer { align-items:flex-start; } }
${shell?.styles ?? ""}
</style></head><body>${shell?.before ?? ""}<main class="page" id="bibliography">
<header><h1>${htmlMessage("Set Citation Style")}</h1><p class="muted">${htmlMessage("Search journals, institutions or style names · Zotero official and Chinese community libraries")}</p></header>
<div id="csl-config"></div>
<div class="toolbar"><input id="search" type="search" aria-label="${htmlMessage("Search journals, institutions or style names")}" placeholder="${htmlMessage("For example Nature, GB/T 7714, Peking University")}" autocomplete="off"><button id="cancel" class="secondary">${htmlMessage(shell ? "Clear Search" : "Cancel")}</button></div>
<div id="sources-warning" class="sources-warning" role="status"></div>
<div class="content"><div class="results"><div id="count" class="muted" role="status">${htmlMessage("Loading citation style libraries…")}</div><div id="list" role="listbox" aria-label="${htmlMessage("Citation Styles")}"></div></div>
<article class="preview" aria-label="${htmlMessage("Style Preview")}"><h2 id="style-title">${htmlMessage("Style Preview")}</h2><p id="style-format" class="muted"></p><div id="sample" aria-live="polite"><p class="notice">${htmlMessage("Select a style or use the arrow keys to preview citations and bibliography")}</p></div></article></div>
<footer><span class="muted">${htmlMessage("Library sample references · Apply to download the style and update the citation configuration")}</span><button id="apply" disabled>${htmlMessage("Use This Style")}</button></footer>
</main>${shell?.after ?? ""}<script nonce="${nonce}">
${getWebviewLocalizationScript()}
const vscode = acquireVsCodeApi();
const search = document.getElementById('search');
const list = document.getElementById('list');
const count = document.getElementById('count');
const title = document.getElementById('style-title');
const format = document.getElementById('style-format');
const sample = document.getElementById('sample');
const apply = document.getElementById('apply');
let active;
let results = [];
let revision = 0;
let searchTimer;
/** Displays loading/error text without interpreting it as remote HTML. */
function notice(text) { const node = document.createElement('p'); node.className = 'notice'; node.textContent = text; sample.replaceChildren(node); }
/** Activates a row for preview without downloading a CSL or changing manuscript settings. */
function activate(style, scroll = false) {
  if (active?.name === style.name) return;
  active = style;
  title.textContent = style.title;
  format.textContent = style.description;
  apply.disabled = false;
  for (const row of list.children) { const selected = row.dataset.name === style.name; row.setAttribute('aria-selected', String(selected)); if (selected && scroll) row.scrollIntoView({block:'nearest'}); }
  notice(t("Loading preview…"));
  vscode.postMessage({type:'preview', name:style.name});
}
/** Sends an explicit confirmation only for the currently previewed journal. */
function accept() { if (active) vscode.postMessage({type:'select', name:active.name}); }
/** Requests results with a revision so late messages cannot replace a newer search. */
function requestSearch() { revision++; vscode.postMessage({type:'search', query:search.value, revision}); }
search.addEventListener('input', () => { clearTimeout(searchTimer); active = undefined; results = []; apply.disabled = true; count.textContent = t("Searching…"); list.replaceChildren(); notice(t("Select a journal after searching to see a preview")); revision++; searchTimer = setTimeout(requestSearch, 120); });
document.addEventListener('keydown', (event) => {
  if (document.getElementById('bibliography').hidden) return;
  if (!document.getElementById('search').contains(event.target) && !list.contains(event.target) && event.target !== apply && event.target !== document.getElementById('cancel')) return;
  if (event.key === 'Escape') { event.preventDefault(); ${shell ? "search.value = ''; requestSearch();" : "vscode.postMessage({type:'cancel'});"} }
  // Tab focus no longer switches previews; Enter on a result must select that row rather than apply the previous style.
  if (event.key === 'Enter' && list.contains(event.target)) { event.preventDefault(); event.target.closest('.item')?.click(); return; }
  if (event.key === 'Enter' && event.target !== document.getElementById('cancel')) { event.preventDefault(); accept(); }
  if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && results.length) {
    event.preventDefault(); const current = results.findIndex(style => style.name === active?.name); const next = Math.max(0, Math.min(results.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1))); activate(results[next], true);
  }
});
document.getElementById('cancel').addEventListener('click', () => { ${shell ? "search.value = ''; requestSearch(); search.focus();" : "vscode.postMessage({type:'cancel'});"} });
apply.addEventListener('click', accept);
window.addEventListener('message', (event) => {
  const message = event.data;
  if (message.type === 'results' && message.revision === revision) {
    results = message.styles;
    count.textContent = message.count ? t("{0} styles", message.count.toLocaleString(localization.language)) + (message.count > results.length ? t(" (showing the first {0}; narrow your search)", results.length) : '') : t("No matching styles. Try the full journal name or other keywords");
    const nodes = results.map(style => { const row = document.createElement('button'); row.className = 'item'; row.dataset.name = style.name; row.setAttribute('role','option'); row.setAttribute('aria-selected','false'); const name = document.createElement('span'); name.className = 'name'; name.textContent = style.title; const description = document.createElement('span'); description.className = 'format'; description.textContent = style.description; row.append(name, description); row.addEventListener('click', () => activate(style)); return row; });
    list.replaceChildren(...nodes);
    if (results.length) activate(results[0]);
  } else if (message.type === 'preview' && message.name === active?.name) { sample.innerHTML = message.html; }
  else if (message.type === 'previewError' && message.name === active?.name) { notice(message.error + t(". You can still use this style or select another")); }
  else if (message.type === 'ready') { requestSearch(); }
  else if (message.type === 'indexError') { count.textContent = message.error + t(". Change the search query to retry"); }
  else if (message.type === 'styleSourcesWarning') { document.getElementById('sources-warning').textContent = message.warnings.join('; ') + (message.warnings.length ? t(". Loaded styles remain available. Change the search query to retry") : ''); }
  else if (message.type === 'cslBusy') { apply.disabled = message.busy || !active; }
});
${shell ? shell.script : "search.focus(); vscode.postMessage({type:'ready'});"}
</script></body></html>`;
}

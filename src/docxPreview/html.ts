import * as crypto from "node:crypto";
import * as vscode from "vscode";
import { getLanguage, getWebviewLocalization, htmlMessage, serializeLocalization } from "../localization";

/** Builds an accessible icon button using the same dimensions and strokes as image previews. */
function toolbarButton(id: string, label: string, paths: string, disabled = false): string {
  const title = htmlMessage(label);
  return `<button type="button" id="${id}" title="${title}" aria-label="${title}"${disabled ? " disabled" : ""}><svg class="toolbarIcon" viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths}</svg></button>`;
}

/** Builds an offline viewer shell whose scripts and resources are restricted to packaged assets. */
export function buildDocxPreviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, source: string): string {
  const nonce = crypto.randomBytes(18).toString("base64");
  /** Restricts resource URLs to the packaged viewer and its matching PDF.js assets. */
  const resource = (name: string) => webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", name)).toString();
  const config = serializeLocalization({ source, worker: resource("pdfjs/pdf.worker.mjs"), assets: resource("pdfjs") + "/",
    localization: JSON.parse(getWebviewLocalization()) });
  return `<!doctype html>
<html lang="${getLanguage()}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'nonce-${nonce}' 'wasm-unsafe-eval'; style-src 'nonce-${nonce}'; worker-src blob:; connect-src ${webview.cspSource}; img-src blob: data:; font-src blob:;">
<title>${htmlMessage("DOCX Paginated Preview (Experimental)")}</title>
<style nonce="${nonce}">
body{box-sizing:border-box;padding:16px;margin:0;color:var(--vscode-foreground,#ddd);background:var(--vscode-editor-background,#222);font:var(--vscode-font-size,13px) var(--vscode-font-family,system-ui);height:100vh;display:flex;flex-direction:column;overflow:hidden}
.previewHeader{display:flex;align-items:center;justify-content:flex-end;gap:12px;flex-wrap:wrap;margin-bottom:12px;flex-shrink:0}
.toolbar{display:flex;align-items:center;gap:4px;flex-wrap:wrap;padding:3px 5px;border:1px solid var(--vscode-widget-border,transparent);border-radius:6px;background:var(--vscode-editorWidget-background,transparent);box-shadow:0 1px 0 #ffffff08 inset}
.controlGroup{display:inline-flex;align-items:center;gap:4px;white-space:nowrap}
.toolbarSeparator{width:1px;height:16px;margin:0 2px;background:var(--vscode-widget-border,rgba(128,128,128,.35))}
button{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;padding:0;border:1px solid transparent;border-radius:4px;color:var(--vscode-icon-foreground,var(--vscode-descriptionForeground,#aaa));background:transparent;font:inherit;cursor:pointer;transition:background-color 80ms linear,color 80ms linear}
button:hover:not(:disabled){color:var(--vscode-foreground);background:var(--vscode-toolbar-hoverBackground,rgba(128,128,128,.16))}
button:active:not(:disabled){background:var(--vscode-toolbar-activeBackground,rgba(128,128,128,.22))}
button[aria-pressed="true"]{color:var(--vscode-textLink-foreground,var(--vscode-focusBorder));background:var(--vscode-toolbar-hoverBackground,rgba(128,128,128,.16))}
.toolbarIcon{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round;pointer-events:none}
select,input{box-sizing:border-box;height:26px;min-width:0;padding:2px 5px;border:1px solid var(--vscode-input-border,transparent);border-radius:4px;font:inherit;font-size:12px;color:var(--vscode-input-foreground,#ddd);background:var(--vscode-input-background,#333);font-variant-numeric:tabular-nums}
button:focus-visible,select:focus-visible,input:focus-visible,#viewport:focus-visible{outline:1px solid var(--vscode-focusBorder,#08f);outline-offset:1px}
button:disabled,input:disabled,select:disabled{opacity:.4;cursor:default}
#page{width:48px;text-align:center;appearance:textfield}#page::-webkit-inner-spin-button,#page::-webkit-outer-spin-button{appearance:none;margin:0}
.pageCount{color:var(--vscode-descriptionForeground,#aaa);font-size:12px;font-variant-numeric:tabular-nums;padding:0 3px}#zoom{width:104px}
.statusGroup{display:flex;align-items:center;gap:7px;flex:1 1 160px;min-width:0;color:var(--vscode-descriptionForeground,#aaa);font-size:12px}
.statusIndicator{width:6px;height:6px;flex-shrink:0;border-radius:50%;background:currentColor;opacity:.65}
.statusGroup.busy .statusIndicator{width:10px;height:10px;box-sizing:border-box;border:1.5px solid currentColor;border-right-color:transparent;background:none;animation:spin 1s linear infinite}
.statusGroup.error{color:var(--vscode-errorForeground,#f88)}#status{overflow-wrap:anywhere}
.previewFooter{display:flex;flex-wrap:wrap;align-items:center;gap:4px 16px;padding-top:10px;flex-shrink:0;color:var(--vscode-descriptionForeground,#aaa);font-size:11px;line-height:1.5}
.notice{flex:1 1 260px}.zoomHint{white-space:nowrap}
#viewport{overflow:auto;flex:1;min-height:0;position:relative;overflow-anchor:none;scrollbar-gutter:stable}
#pages{box-sizing:border-box;display:flex;flex-direction:column;align-items:center;gap:16px;padding:16px;min-height:100%}
.page{flex-shrink:0;position:relative;background:white;box-shadow:0 16px 42px var(--vscode-widget-shadow,rgba(0,0,0,.26)),0 4px 14px #0000002e;color:#777}
.page-label{position:absolute;inset:8px 0 auto;text-align:center;font:12px system-ui}.page canvas{position:absolute;inset:0;width:100%;height:100%}
@keyframes spin{to{transform:rotate(360deg)}}
@media(prefers-reduced-motion:reduce){.statusGroup.busy .statusIndicator{animation:none}button{transition:none}}
@media(max-width:600px){body{padding:10px}.previewHeader{gap:8px}.statusGroup{flex-basis:100%}.toolbar{margin-left:auto}.previewFooter{padding-top:8px}}
@media(max-width:420px){.toolbar{width:100%;justify-content:center;row-gap:6px}.toolbarSeparator{display:none}}
</style></head><body>
<header class="previewHeader">
<div id="status-group" class="statusGroup busy"><span class="statusIndicator" aria-hidden="true"></span><span id="status" role="status" aria-live="polite" aria-busy="true">${htmlMessage("Preparing DOCX preview…")}</span></div>
<div class="toolbar" role="toolbar" aria-label="${htmlMessage("DOCX preview controls")}">
${toolbarButton("refresh", "Refresh preview", '<path d="M19 10a7 7 0 1 0-1.5 7.5M19 4v6h-6"/>')}
<span class="toolbarSeparator" aria-hidden="true"></span>
<div class="controlGroup">
${toolbarButton("previous", "Previous page", '<path d="m14 6-6 6 6 6"/>', true)}
<input id="page" type="number" min="1" value="1" disabled title="${htmlMessage("Page number")}" aria-label="${htmlMessage("Page number")}"><span class="pageCount">/ <span id="total">0</span></span>
${toolbarButton("next", "Next page", '<path d="m10 6 6 6-6 6"/>', true)}
</div>
<span class="toolbarSeparator" aria-hidden="true"></span>
<div class="controlGroup">
${toolbarButton("zoom-out", "Zoom out", '<circle cx="9.5" cy="9.5" r="5.25"/><path d="M6.75 9.5h5.5m1.15 3.9 5.1 5.1"/>', true)}
${toolbarButton("zoom-in", "Zoom in", '<circle cx="9.5" cy="9.5" r="5.25"/><path d="M9.5 6.75v5.5M6.75 9.5h5.5m1.15 3.9 5.1 5.1"/>', true)}
${toolbarButton("actual", "Actual size", '<path d="M5 5h14v14H5zM8.5 8.75v6.5m7-6.5v6.5"/><circle cx="12" cy="10.6" r=".85" fill="currentColor" stroke="none"/><circle cx="12" cy="13.4" r=".85" fill="currentColor" stroke="none"/>', true)}
${toolbarButton("fit", "Fit width", '<path d="M5 5v14M19 5v14M8 12h8m-5-3-3 3 3 3m2-6 3 3-3 3"/>', true)}
<select id="zoom" disabled title="${htmlMessage("Zoom")}" aria-label="${htmlMessage("Zoom")}"><option value="fit">${htmlMessage("Fit width")}</option>${[50, 75, 100, 125, 150, 200, 300].map(value => `<option value="${value / 100}">${value}%</option>`).join("")}</select>
</div>
</div>
</header>
<main id="viewport" tabindex="0" aria-label="${htmlMessage("Document pages")}"><div id="pages"></div></main>
<footer class="previewFooter"><span class="notice">${htmlMessage("Experimental: pagination may differ from Word. Preview uses the current editor buffer with static cross-references.")}</span><span class="zoomHint">${htmlMessage("Ctrl + mouse wheel to zoom")}</span></footer>
<script nonce="${nonce}" id="preview-config" type="application/json">${config}</script>
<script nonce="${nonce}" type="module" src="${resource("docx-preview.mjs")}"></script>
</body></html>`;
}

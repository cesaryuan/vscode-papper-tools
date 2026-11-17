import { htmlMessage, getLanguage, getWebviewLocalization, serializeLocalization } from "../localization";
import { escapeXml } from "./svg";

/** Creates the editor shell; the bundled browser controller owns all figure interactions. */
export function buildSubfigureHtml(script: string, csp: string, icons = ""): string {
  const toolbarIcons: Record<string, string> = { save: "save", saveAs: "save-as", undo: "discard", redo: "redo",
    addImages: "file-media", addText: "text-size", arrange: "layout", renumber: "list-ordered", refresh: "refresh", export: "export" };
  /** Creates a translated toolbar button without mixing manuscript content into HTML. */
  const button = (action: string, label: string): string => `<button data-action="${action}">${toolbarIcons[action] ? `<span class="codicon codicon-${toolbarIcons[action]}" aria-hidden="true"></span>` : ""}<span>${htmlMessage(label)}</span></button>`;
  return `<!doctype html><html lang="${escapeXml(getLanguage())}"><head><meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: blob:; style-src ${escapeXml(csp)} 'unsafe-inline'; script-src ${escapeXml(csp)}; font-src ${escapeXml(csp)} data:;">
  <meta name="viewport" content="width=device-width,initial-scale=1"><title>${htmlMessage("Combination Figure Editor")}</title>
  ${icons ? `<link rel="stylesheet" href="${escapeXml(icons)}">` : ""}<style>
  *{box-sizing:border-box}body{margin:0;height:100vh;display:grid;grid-template-rows:auto minmax(0,1fr) auto;color:var(--vscode-foreground,#d4d4d4);background:var(--vscode-editor-background,#1e1e1e);font:13px var(--vscode-font-family,system-ui)}
  button,input,select,textarea{font:inherit}button{border:1px solid transparent;background:var(--vscode-button-secondaryBackground,#383838);color:var(--vscode-button-secondaryForeground,#eee);border-radius:4px;padding:5px 9px;cursor:pointer}
  button:hover{background:var(--vscode-button-secondaryHoverBackground,#505050)}button:focus-visible,input:focus-visible,select:focus-visible,[contenteditable]:focus-visible{outline:1px solid var(--vscode-focusBorder,#007acc)}
  button.primary{background:var(--vscode-button-background,#007acc);color:var(--vscode-button-foreground,white)}button:disabled{opacity:.45;cursor:default}
  input,select,textarea{min-width:0;width:100%;border:1px solid var(--vscode-input-border,#555);background:var(--vscode-input-background,#333);color:var(--vscode-input-foreground,#eee);padding:4px 6px;border-radius:3px}
  input[type=checkbox]{width:auto}input[type=color]{height:28px;padding:2px}header{display:flex;align-items:center;flex-wrap:wrap;gap:6px;padding:8px 12px;border-bottom:1px solid var(--vscode-panel-border,#444)}
  header button{display:inline-flex;align-items:center;gap:5px}header .codicon{font-size:16px}
  .brand{font-weight:600;margin-right:8px}.separator{height:20px;width:1px;background:var(--vscode-panel-border,#444);margin:0 3px}
  main{min-height:0;display:grid;grid-template-columns:180px minmax(180px,1fr) 254px}
  aside{overflow:auto;background:var(--vscode-sideBar-background,#252526);padding:12px;border-right:1px solid var(--vscode-panel-border,#444)}aside:last-child{border-left:1px solid var(--vscode-panel-border,#444);border-right:0}
  h2{margin:0 0 12px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--vscode-descriptionForeground,#aaa)}
  h3{font-size:12px;margin:18px 0 8px}.field{display:grid;gap:5px;margin-bottom:9px}.field>span{font-size:12px;color:var(--vscode-descriptionForeground,#aaa)}.pair{display:grid;grid-template-columns:1fr 1fr;gap:8px}
  .check{display:flex;align-items:center;gap:6px;margin:10px 0;font-size:12px}.muted{color:var(--vscode-descriptionForeground,#aaa);font-size:12px;line-height:1.5}
  #viewport{overflow:auto;position:relative;background-color:var(--vscode-editorGroupHeader-tabsBackground,#171717);padding:28px;touch-action:none}
  #board{display:block;overflow:visible;box-shadow:0 4px 22px #0005;user-select:none}#board [data-element-id]{cursor:move}#board .resize{cursor:nwse-resize;fill:#fff;stroke:#007acc;vector-effect:non-scaling-stroke}
  .selection{fill:none;stroke:#007acc;stroke-width:1;vector-effect:non-scaling-stroke;pointer-events:none}
  .item{display:flex;align-items:center;gap:6px;max-width:100%;width:100%;margin-bottom:5px;text-align:left;background:transparent;border:1px solid transparent;padding:7px 6px}
  .item.selected{background:var(--vscode-list-activeSelectionBackground,#094771);color:var(--vscode-list-activeSelectionForeground,#fff)}.item .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.badge{font-size:11px;opacity:.7}
  .tools{display:flex;flex-wrap:wrap;gap:4px}.tools button{font-size:12px;padding:4px 7px}.rich{min-height:78px;max-height:220px;overflow:auto;border:1px solid var(--vscode-input-border,#555);background:var(--vscode-input-background,#333);padding:7px;white-space:pre-wrap;line-height:1.5;user-select:text}
  #notice{position:fixed;bottom:36px;left:195px;right:270px;background:var(--vscode-inputValidation-errorBackground,#522);border:1px solid var(--vscode-inputValidation-errorBorder,#b44);padding:8px 12px;z-index:10;white-space:pre-wrap}#notice:empty{display:none}
  footer{height:34px;display:flex;align-items:center;justify-content:space-between;padding:0 12px;gap:8px;border-top:1px solid var(--vscode-panel-border,#444);font-size:12px}footer .controls{display:flex;align-items:center;gap:8px}#zoom{width:75px}
  .empty{fill:#777;font-family:system-ui;font-size:10px;pointer-events:none}.hidden{display:none!important}.full{width:100%;margin-top:6px}
  @media(max-width:850px){main{grid-template-columns:132px minmax(160px,1fr) 218px}aside{padding:9px}.brand{display:none}#notice{left:145px;right:230px}}
  </style></head><body>
  <header><span class="brand">${htmlMessage("Combination Figure")}</span>
  ${button("save", "Save")}${button("saveAs", "Save As")}${button("undo", "Undo")}${button("redo", "Redo")}<span class="separator"></span>
  ${button("addImages", "Add images")}${button("addText", "Add text")}${button("arrange", "Auto arrange")}${button("renumber", "Renumber")}<span class="separator"></span>
  ${button("refresh", "Refresh images")}<input id="dpi" type="number" value="300" min="1" max="2400" style="width:65px" aria-label="${htmlMessage("PNG resolution (DPI)")}"><span>DPI</span>${button("export", "Export PNG")}</header>
  <main><aside><h2>${htmlMessage("Elements")}</h2><div id="elements"></div><p class="muted">${htmlMessage("Drag to reorder. Shift-click to select multiple elements.")}</p>
  <h3>${htmlMessage("Arrange selection")}</h3><div class="tools">
  ${button("align:left", "Left")}${button("align:center", "Center")}${button("align:right", "Right")}${button("align:top", "Top")}${button("align:middle", "Middle")}${button("align:bottom", "Bottom")}
  ${button("align:horizontal", "Horizontal spacing")}${button("align:vertical", "Vertical spacing")}</div>
  <div class="tools" style="margin-top:12px">${button("duplicate", "Duplicate")}${button("delete", "Delete")}</div></aside>
  <section id="viewport" aria-label="${htmlMessage("Figure canvas")}"><svg id="board" xmlns="http://www.w3.org/2000/svg" tabindex="0"></svg></section>
  <aside><h2>${htmlMessage("Figure size")}</h2>
  <div class="pair"><label class="field"><span>${htmlMessage("Width")}</span><input id="figure-width" type="number" min="1" step="1"></label><label class="field"><span>${htmlMessage("Unit")}</span><select id="unit"><option>mm</option><option>in</option></select></label></div>
  <label class="field"><span>${htmlMessage("Height")}</span><input id="figure-height" type="number" min="1" step="1"></label>
  <label class="check"><input id="auto-height" type="checkbox">${htmlMessage("Fit height to content")}</label>
  <label class="check"><input id="a4" type="checkbox" checked>${htmlMessage("A4 paper reference")}</label>
  <div id="paper-info" class="muted"></div>
  <p class="muted">${htmlMessage("Keep the figure within the manuscript column width to preserve its text size in Word.")}</p>
  <label class="check"><input id="transparent" type="checkbox">${htmlMessage("Transparent background")}</label>
  <label class="check"><input id="embedded" type="checkbox">${htmlMessage("Embed image assets")}</label>
  <hr><div id="inspector"></div><hr>
  <h3>${htmlMessage("Automatic layout")}</h3><div class="pair"><label class="field"><span>${htmlMessage("Columns")}</span><input id="columns" type="number" min="1" max="30"></label>
  <label class="field"><span>${htmlMessage("Gap (pt)")}</span><input id="gap" type="number" min="0"></label></div>
  <label class="field"><span>${htmlMessage("Panels per row")}</span><input id="rows" placeholder="2, 3, 2"></label>
  <label class="field"><span>${htmlMessage("Width weights")}</span><input id="weights" placeholder="1, 2, 1"></label>
  <div class="pair"><label class="field"><span>${htmlMessage("Row gap (pt)")}</span><input id="row-gap" type="number" min="0"></label>
  <label class="field"><span>${htmlMessage("Padding (pt)")}</span><input id="padding" type="number" min="0"></label></div>
  <h3>${htmlMessage("Default text")}</h3><label class="field"><span>${htmlMessage("Font family")}</span><input id="default-family" list="fonts"></label>
  <label class="field"><span>${htmlMessage("Font size (pt)")}</span><input id="default-size" type="number" min="1" step=".5"></label>
  ${button("applyFont", "Apply default text to all")}
  <datalist id="fonts"><option>Times New Roman</option><option>Arial</option><option>Cambria</option><option>SimSun</option><option>Microsoft YaHei</option></datalist>
  </aside></main><div id="notice" role="status"></div>
  <footer><span id="status">${htmlMessage("Loading combination figure…")}</span><div class="controls">
  <label class="check"><input id="snap" type="checkbox" checked>${htmlMessage("Snap")}</label>
  <span class="muted">${htmlMessage("Ctrl + wheel to zoom")}</span><button data-action="fit">${htmlMessage("Fit")}</button><input id="zoom" type="number" value="100" min="10" max="500" aria-label="${htmlMessage("Zoom percent")}"><span>%</span></div></footer>
  <script id="localization" type="application/json">${getWebviewLocalization()}</script>
  <script id="editor-options" type="application/json">${serializeLocalization({})}</script><script defer src="${escapeXml(script)}"></script>
  </body></html>`;
}

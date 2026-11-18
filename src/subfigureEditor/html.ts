import { htmlMessage, getLanguage, getWebviewLocalization, serializeLocalization } from "../localization";
import { escapeXml } from "./svg";
import { BUTTON_HELP } from "./help";

/** Creates the editor shell; the bundled browser controller owns all figure interactions. */
export function buildSubfigureHtml(script: string, csp: string, icons = ""): string {
  const toolbarIcons: Record<string, string> = { save: "save", saveAs: "save-as", undo: "discard", redo: "redo",
    addImages: "file-media", addText: "text-size", arrange: "layout", renumber: "list-ordered", refresh: "refresh", export: "export" };
  /** Creates a translated toolbar button without mixing manuscript content into HTML. */
  const button = (action: string, label: string): string => `<button data-action="${action}" title="${htmlMessage(BUTTON_HELP[action] ?? label)}">${toolbarIcons[action] ? `<span class="codicon codicon-${toolbarIcons[action]}" aria-hidden="true"></span>` : ""}<span>${htmlMessage(label)}</span></button>`;
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
  main{--properties-width:192px;min-height:0;display:grid;grid-template-columns:180px minmax(180px,1fr) var(--properties-width)}
  aside{overflow:auto;background:var(--vscode-sideBar-background,#252526);padding:12px;border-right:1px solid var(--vscode-panel-border,#444)}aside:last-child{border-left:1px solid var(--vscode-panel-border,#444);border-right:0}
  h2{margin:0 0 12px;font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--vscode-descriptionForeground,#aaa)}
  h3{font-size:12px;margin:18px 0 8px}.field{display:grid;min-width:0;gap:5px;margin-bottom:9px}.field>span{font-size:12px;color:var(--vscode-descriptionForeground,#aaa)}.pair{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px}
  .check{display:flex;align-items:center;gap:6px;margin:10px 0;font-size:12px}.muted{color:var(--vscode-descriptionForeground,#aaa);font-size:12px;line-height:1.5}
  #viewport{overflow:auto;position:relative;background-color:var(--vscode-editorGroupHeader-tabsBackground,#171717);padding:28px;touch-action:none}
  #board{display:block;overflow:visible;box-shadow:0 4px 22px #0005;user-select:none}#board [data-element-id]{cursor:move}#board .resize{cursor:nwse-resize;fill:#fff;stroke:#007acc;vector-effect:non-scaling-stroke}
  #artwork [data-element-id]>text,#artwork .empty-text-target{cursor:text}
  #canvas-text{position:absolute;z-index:5;user-select:text;cursor:text;white-space:pre-wrap;overflow-wrap:anywhere;background:white;outline:1px solid var(--vscode-focusBorder,#007acc);padding:0;border:0;line-height:1.25}
  #canvas-text::before{content:attr(data-prefix)}
  .selection{fill:none;stroke:#007acc;stroke-width:1;vector-effect:non-scaling-stroke;pointer-events:none}
  #board .divider{cursor:col-resize;fill:transparent;stroke:none}#board .divider-line{stroke:#888;stroke-width:1;stroke-dasharray:4 4;pointer-events:none;vector-effect:non-scaling-stroke}
  #board .divider.horizontal{cursor:row-resize}
  .panel-tools{position:fixed;z-index:6;display:flex;flex-wrap:wrap;gap:4px;padding:4px;background:var(--vscode-editorWidget-background,#252526);border:1px solid var(--vscode-widget-border,#666);border-radius:5px;box-shadow:0 2px 8px #0005}
  .panel-tools button{display:inline-flex;gap:5px;align-items:center}
  #format-bar{flex-wrap:nowrap;gap:2px}#format-bar button{min-width:26px;justify-content:center;padding:3px 5px}
  #format-bar [aria-pressed=true]{outline:1px solid var(--vscode-focusBorder,#007acc);background:var(--vscode-list-activeSelectionBackground,#094771)}
  .crop-feedback{flex-basis:100%;max-width:320px}header .check{margin:0}
  #board .crop-frame{fill:transparent;stroke:white;stroke-width:1;vector-effect:non-scaling-stroke;cursor:move}
  #board .crop-handle{fill:none;stroke:#111;stroke-width:4;paint-order:stroke;pointer-events:none;vector-effect:non-scaling-stroke}
  #board .drag-ghost{opacity:.32;pointer-events:none}#board.dragging{cursor:grabbing}#board.dragging [data-element-id]{cursor:grabbing}
  #board .snap-guide{pointer-events:none}#board .snap-guide line{stroke:var(--vscode-focusBorder,#007acc);stroke-width:1;stroke-dasharray:3 3;vector-effect:non-scaling-stroke}
  #board .snap-guide text{fill:var(--vscode-focusBorder,#007acc);font:9px var(--vscode-font-family,system-ui);paint-order:stroke;stroke:white;stroke-width:3;stroke-linejoin:round}
  .dock-preview{fill:var(--vscode-list-dropBackground,#76baff);fill-opacity:.45;stroke:var(--vscode-focusBorder,#007acc);stroke-width:2;pointer-events:none;vector-effect:non-scaling-stroke}
  #drop-hint{position:absolute;top:10px;left:16px;right:16px;padding:7px 10px;z-index:4;pointer-events:none;background:var(--vscode-editorHoverWidget-background,#252526);border:1px solid var(--vscode-focusBorder,#007acc)}
  #drop-hint:empty{display:none}.presets{display:flex;gap:4px;flex-wrap:wrap;margin:10px 0}.presets button{padding:6px 7px}
  .layout-help{margin:8px 0 14px}details>summary{cursor:pointer;font-size:12px;margin:14px 0 10px}input:disabled{opacity:.6}
  .item{display:flex;align-items:center;gap:6px;max-width:100%;width:100%;margin-bottom:5px;text-align:left;background:transparent;border:1px solid transparent;padding:7px 6px}
  .item.selected{background:var(--vscode-list-activeSelectionBackground,#094771);color:var(--vscode-list-activeSelectionForeground,#fff)}.item .name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}.badge{font-size:11px;opacity:.7}
  .tools{display:flex;flex-wrap:wrap;gap:4px}.tools button{font-size:12px;padding:4px 7px}.rich{min-height:78px;max-height:220px;overflow:auto;border:1px solid var(--vscode-input-border,#555);background:var(--vscode-input-background,#333);padding:7px;white-space:pre-wrap;line-height:1.5;user-select:text}
  #notice{position:fixed;bottom:36px;left:195px;right:270px;background:var(--vscode-inputValidation-errorBackground,#522);border:1px solid var(--vscode-inputValidation-errorBorder,#b44);padding:8px 12px;z-index:10;white-space:pre-wrap}#notice:empty{display:none}
  footer{height:34px;display:flex;align-items:center;justify-content:space-between;padding:0 12px;gap:8px;border-top:1px solid var(--vscode-panel-border,#444);font-size:12px}footer .controls{display:flex;align-items:center;gap:8px}#zoom{width:75px}
  .empty{fill:#777;font-family:system-ui;font-size:10px;pointer-events:none}.hidden{display:none!important}.full{width:100%;margin-top:6px}
  body{grid-template-columns:minmax(0,1fr)}#viewport{min-width:0;scrollbar-gutter:stable}main{position:relative}#properties-toggle{display:none}
  @media(max-width:850px){main{grid-template-columns:124px minmax(0,1fr)}aside{padding:9px}.brand{display:none}#notice{left:8px;right:8px}
    #properties-toggle{display:inline-flex}#properties-panel{display:none;position:absolute;right:0;top:0;bottom:0;width:min(var(--properties-width),80%);z-index:8;box-shadow:-3px 0 12px #0005}
    #properties-panel.open{display:block}#viewport{padding:16px}}
  @media(max-width:480px){main{grid-template-columns:94px minmax(0,1fr)}#viewport{padding:8px}header{gap:3px;padding:4px}header button{padding:3px 5px}footer .muted{display:none}#status{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}}
  </style></head><body>
  <header><span class="brand">${htmlMessage("Combination Figure")}</span>
  ${button("save", "Save")}${button("saveAs", "Save As")}${button("undo", "Undo")}${button("redo", "Redo")}<span class="separator"></span>
  ${button("addImages", "Add images")}${button("addText", "Add text")}${button("arrange", "Auto arrange")}${button("renumber", "Renumber")}
  <label class="check" title="${htmlMessage("Automatically assign a, b, c… in visual order after edits. Turn off to keep custom labels.")}"><input id="auto-renumber" type="checkbox" checked>${htmlMessage("Auto renumber")}</label><span class="separator"></span>
  ${button("refresh", "Refresh images")}<input id="dpi" type="number" value="300" min="1" max="2400" style="width:65px" aria-label="${htmlMessage("PNG resolution (DPI)")}"><span>DPI</span>${button("export", "Export PNG")}
  <button id="properties-toggle" aria-expanded="false" aria-controls="properties-panel" title="${htmlMessage("Show or hide figure properties")}"><span class="codicon codicon-settings-gear"></span>${htmlMessage("Properties")}</button></header>
  <main><aside><h2>${htmlMessage("Layout")}</h2><select id="layout-mode" aria-label="${htmlMessage("Layout mode")}"><option value="panels">${htmlMessage("Panel layout")}</option><option value="free">${htmlMessage("Free positioning")}</option></select>
  <p id="layout-help" class="muted layout-help"></p><div class="presets" aria-label="${htmlMessage("Layout presets")}">
  ${button("preset:1", "1 per row")}${button("preset:2", "2 per row")}${button("preset:3", "3 per row")}${button("preset:1,2", "1 + 2")}${button("preset:2,1", "2 + 1")}${button("nested:1,2", "Left 1 · Right 2")}${button("nested:2,1", "Left 2 · Right 1")}</div>
  <h2>${htmlMessage("Elements")}</h2><div id="elements"></div><p class="muted">${htmlMessage("Drag to reorder. Shift-click to select multiple elements.")}</p>
  <h3>${htmlMessage("Align and distribute")}</h3><p class="muted">${htmlMessage("For multiple selected elements in free positioning mode.")}</p><div class="tools">
  ${button("align:left", "Left")}${button("align:center", "Center")}${button("align:right", "Right")}${button("align:top", "Top")}${button("align:middle", "Middle")}${button("align:bottom", "Bottom")}
  ${button("align:horizontal", "Horizontal spacing")}${button("align:vertical", "Vertical spacing")}</div>
  <div class="tools" style="margin-top:12px">${button("duplicate", "Duplicate")}${button("delete", "Delete")}</div></aside>
  <section id="viewport" aria-label="${htmlMessage("Figure canvas")}"><div id="drop-hint" role="status"></div><svg id="board" xmlns="http://www.w3.org/2000/svg" tabindex="0"></svg><div id="canvas-text" class="hidden" contenteditable="true" role="textbox" aria-multiline="true"></div></section>
  <aside id="properties-panel"><h2>${htmlMessage("Figure size")}</h2>
  <div class="pair"><label class="field"><span>${htmlMessage("Width")}</span><input id="figure-width" type="number" min="1" step="1"></label><label class="field"><span>${htmlMessage("Unit")}</span><select id="unit"><option>mm</option><option>in</option></select></label></div>
  <label class="field"><span>${htmlMessage("Height")}</span><input id="figure-height" type="number" min="1" step="1"></label>
  <label class="check"><input id="auto-height" type="checkbox">${htmlMessage("Fit height to content")}</label>
  <label class="check"><input id="a4" type="checkbox" checked>${htmlMessage("A4 paper reference")}</label>
  <div id="paper-info" class="muted"></div>
  <p class="muted">${htmlMessage("Keep the figure within the manuscript column width to preserve its text size in Word.")}</p>
  <label class="check"><input id="transparent" type="checkbox">${htmlMessage("Transparent background")}</label>
  <label class="check"><input id="embedded" type="checkbox">${htmlMessage("Embed image assets")}</label>
  <hr><div id="inspector"></div><hr>
  <details><summary>${htmlMessage("Advanced grid settings")}</summary><p class="muted">${htmlMessage("Row settings create row-based presets. Use panel docking for nested layouts.")}</p>
  <p class="muted">${htmlMessage("Changing row counts or width weights replaces nested splits with a row layout. Gap and padding changes keep the current structure.")}</p>
  <div class="pair"><label class="field"><span>${htmlMessage("Default panels per row")}</span><input id="columns" type="number" min="1" max="30"></label>
  <label class="field"><span>${htmlMessage("Gap (pt)")}</span><input id="gap" type="number" min="0"></label></div>
  <label class="field"><span>${htmlMessage("Custom row counts")}</span><input id="rows" placeholder="2, 3, 2"></label>
  <label class="field"><span>${htmlMessage("Width weights")}</span><input id="weights" placeholder="1, 2, 1"></label>
  <div class="pair"><label class="field"><span>${htmlMessage("Row gap (pt)")}</span><input id="row-gap" type="number" min="0"></label>
  <label class="field"><span>${htmlMessage("Padding (pt)")}</span><input id="padding" type="number" min="0"></label></div></details>
  <h3>${htmlMessage("Default text")}</h3><label class="field"><span>${htmlMessage("Western font")}</span><input id="default-family" list="fonts"></label>
  <label class="field"><span>${htmlMessage("Chinese font")}</span><input id="default-cjk" list="chinese-fonts"></label>
  <label class="field"><span>${htmlMessage("Font size (pt)")}</span><input id="default-size" type="number" min="1" step=".5"></label>
  ${button("applyFont", "Apply default text to all")}
  <datalist id="fonts"><option>Times New Roman</option><option>Arial</option><option>Cambria</option><option>SimSun</option><option>Microsoft YaHei</option></datalist>
  <datalist id="chinese-fonts"><option value="SimSun">宋体</option><option value="Microsoft YaHei">微软雅黑</option><option value="SimHei">黑体</option><option value="KaiTi">楷体</option><option value="FangSong">仿宋</option></datalist>
  </aside></main><div id="notice" role="status"></div><div id="panel-tools" class="panel-tools hidden" role="toolbar" aria-label="${htmlMessage("Image tools")}"></div>
  <div id="format-bar" class="panel-tools hidden" role="toolbar" aria-label="${htmlMessage("Text formatting")}"></div>
  <footer><span id="status">${htmlMessage("Loading combination figure…")}</span><div class="controls">
  <label class="check"><input id="snap" type="checkbox" checked>${htmlMessage("Snap")}</label>
  <span class="muted">${htmlMessage("Ctrl + wheel to zoom")}</span>${button("fit", "Fit")}<input id="zoom" type="number" value="100" min="10" max="500" aria-label="${htmlMessage("Zoom percent")}"><span>%</span></div></footer>
  <script id="localization" type="application/json">${getWebviewLocalization()}</script>
  <script id="editor-options" type="application/json">${serializeLocalization({})}</script><script defer src="${escapeXml(script)}"></script>
  </body></html>`;
}

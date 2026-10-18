/** Display labels and groups for the settings page; configuration keys and values remain owned by the schema. */
export const SETTINGS_LABELS: Record<string, string> = {
  mathtype: "Editable MathType Equations", mathtypeConversionMethod: "Conversion Backend", mathtypeSvgBackend: "SVG Renderer",
  mathtypeTypstMathFont: "Typst Math Font", font: "Math Symbol Font", calligraphicFont: "Calligraphic Math Font",
  tableAutofit: "Default Table Layout", docxNativeCrossref: "Native Word Cross References",
  docxEmbedSvgImages: "Embed SVG Subimages", docxConvertSvgToPng: "Convert SVG to PNG",
  docxSvgToPngWidth: "Output Width", docxSvgToPngDpi: "Output DPI", docxSvgToPngScale: "Scale",
  docxShowLineNumbers: "Line Numbering", docxShowPageNumbers: "Footer Page Numbers", docxPageMargins: "Page Margins",
  docxFooter: "Footer Content and Alignment", content: "Markdown Content", docxPageWidth: "Page Width",
  top: "Top Margin", bottom: "Bottom Margin", left: "Left Margin", right: "Right Margin", inside: "Inside Margin", outside: "Outside Margin",
  fontFamily: "Font", western: "Western Font", chinese: "Chinese Font", fontName: "Legacy Font Name",
  fontSize: "Font Size", fontColor: "Font Color", bold: "Bold", lineSpacing: "Line Spacing", alignment: "Alignment",
  firstLineIndentChars: "First Line Indent (Characters)", indentation: "Paragraph Indentation", firstLine: "First Line Indent", hanging: "Hanging Indent",
  paragraphSpacing: "Paragraph Spacing", before: "Space Before", after: "Space After", family: "Legacy Font Name",
  csl: "Current Citation Style", "reference-section-title": "Bibliography Section Title", "link-citations": "Citation Links",
  citationNumberRangeDelimiter: "Citation Range Delimiter", figureTitle: "Figure Caption Prefix", tableTitle: "Table Caption Prefix",
  titleDelim: "Caption Delimiter", figPrefix: "Figure Reference Prefix", tblPrefix: "Table Reference Prefix", secPrefix: "Section Reference Prefix",
  eqnPrefix: "Equation Reference Prefix", linkReferences: "Cross Reference Links", autoSectionLabels: "Automatic Section Labels",
  autoEqnLabels: "Automatic Equation Numbers", numberSections: "Section Numbering", sectionsDepth: "Section Numbering Depth",
  chapters: "Number by Chapter", chaptersDepth: "Chapter Depth", chapDelim: "Chapter Number Delimiter",
  subfigGrid: "Subfigure Grid Layout", subfigureChildTemplate: "Subfigure Caption Template", subfigureTemplate: "Parent Figure Caption Template", lang: "Document Language",
};

export const SETTINGS_GROUPS: Record<string, Array<{ title: string; keys: string[]; collapsed?: boolean }>> = {
  math: [
    { title: "Conversion and Rendering", keys: ["mathtype", "mathtypeConversionMethod", "mathtypeSvgBackend"] },
    { title: "Math Fonts", keys: ["mathtypeTypstMathFont"] },
  ],
  tables: [{ title: "Table Layout", keys: ["tableAutofit"] }],
  docx: [
    { title: "Fonts and Text", keys: ["fontFamily", "fontSize", "fontColor", "bold"] },
    { title: "Paragraph Layout", keys: ["lineSpacing", "alignment", "firstLineIndentChars", "indentation", "paragraphSpacing"] },
    { title: "Legacy Compatibility Settings", keys: ["fontName", "font"], collapsed: true },
  ],
  images: [
    { title: "Image Processing", keys: ["docxEmbedSvgImages", "docxConvertSvgToPng"] },
    { title: "PNG Output Dimensions", keys: ["docxSvgToPngWidth", "docxSvgToPngDpi", "docxSvgToPngScale"] },
  ],
  layout: [
    { title: "Footers, Page Numbers and Line Numbers", keys: ["docxFooter", "docxShowLineNumbers", "docxShowPageNumbers"] },
    { title: "Page Size and Margins", keys: ["docxPageWidth", "docxPageMargins"] },
  ],
  references: [
    { title: "Caption and Reference Text", keys: ["figureTitle", "tableTitle", "titleDelim", "figPrefix", "tblPrefix", "secPrefix", "eqnPrefix"] },
    { title: "Links and Automatic Labels", keys: ["linkReferences", "autoSectionLabels", "autoEqnLabels", "docxNativeCrossref"] },
    { title: "Section Numbering", keys: ["numberSections", "sectionsDepth", "chapters", "chaptersDepth", "chapDelim"] },
    { title: "Subfigures and Document Language", keys: ["subfigGrid", "subfigureChildTemplate", "subfigureTemplate", "lang"] },
  ],
};

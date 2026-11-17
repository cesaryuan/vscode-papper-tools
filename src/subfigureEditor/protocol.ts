import type { FigureDocument } from "./model";

export type HostMessage =
  | { type: "state"; figure: FigureDocument; sources: Record<string, string>; revision: number; failures: string[] }
  | { type: "export"; sources: Record<string, string>; dpi: number }
  | { type: "error"; message: string };
export type EditorMessage =
  | { type: "ready" | "save" | "saveAs" | "undo" | "redo" | "refresh" | "addImages" }
  | { type: "change"; figure: FigureDocument; label: string; revision: number }
  | { type: "textLayout"; lines: Record<string, FigureDocument["elements"][number]["lines"]>; height: number }
  | { type: "embed"; enabled: boolean }
  | { type: "drop"; paths?: string[]; files?: Array<{ name: string; data: string }> }
  | { type: "exportPng"; dpi: number }
  | { type: "png"; data: string }
  | { type: "openSource"; id: string };

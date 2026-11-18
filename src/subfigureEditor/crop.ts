/** Converts drag-based non-destructive crop frames between source percentages and physical canvas coordinates. */
import type { Crop, Panel } from "./model";
import type { Box } from "./panelTree";

/** Recovers the full source bounds, including areas hidden by an existing crop and letterboxing. */
export function cropGeometry(panel: Panel): { source: Box; frame: Box } {
  const visibleWidth = (100 - panel.crop.left - panel.crop.right) / 100;
  const visibleHeight = (100 - panel.crop.top - panel.crop.bottom) / 100;
  const scale = Math.min(panel.width / visibleWidth, panel.height * panel.ratio / visibleHeight);
  const width = scale * visibleWidth, height = scale / panel.ratio * visibleHeight;
  const frame = { x: panel.x + (panel.width - width) / 2, y: panel.y + (panel.height - height) / 2, width, height };
  return { frame, source: { x: frame.x - scale * panel.crop.left / 100,
    y: frame.y - scale / panel.ratio * panel.crop.top / 100, width: scale, height: scale / panel.ratio } };
}

/** Moves crop edges without crossing the opposing edge or extending beyond the source image. */
export function dragCropFrame(source: Box, frame: Box, handle: string, dx: number, dy: number, minimum: number): Box {
  const minWidth = Math.min(minimum, frame.width), minHeight = Math.min(minimum, frame.height);
  let left = frame.x, top = frame.y, right = left + frame.width, bottom = top + frame.height;
  if (handle.includes("w")) left = Math.max(source.x, Math.min(right - minWidth, left + dx));
  if (handle.includes("e")) right = Math.min(source.x + source.width, Math.max(left + minWidth, right + dx));
  if (handle.includes("n")) top = Math.max(source.y, Math.min(bottom - minHeight, top + dy));
  if (handle.includes("s")) bottom = Math.min(source.y + source.height, Math.max(top + minHeight, bottom + dy));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

/** Repositions the source inside a fixed crop frame while keeping the frame fully covered. */
export function panCropSource(source: Box, frame: Box, dx: number, dy: number): Box {
  return { ...source, x: Math.max(frame.x + frame.width - source.width, Math.min(frame.x, source.x + dx)),
    y: Math.max(frame.y + frame.height - source.height, Math.min(frame.y, source.y + dy)) };
}

/** Stores the visible rectangle as reversible source-image percentages, never resampling image data. */
export function cropFromFrame(source: Box, frame: Box): Crop {
  return { left: Math.max(0, (frame.x - source.x) / source.width * 100),
    top: Math.max(0, (frame.y - source.y) / source.height * 100),
    right: Math.max(0, (source.x + source.width - frame.x - frame.width) / source.width * 100),
    bottom: Math.max(0, (source.y + source.height - frame.y - frame.height) / source.height * 100) };
}

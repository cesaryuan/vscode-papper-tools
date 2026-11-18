/** Converts reversible crop geometry and detects outer whitespace without rewriting source pixels. */
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

/** Finds all content against a dominant perimeter background, retaining fine marks and a small safety margin. */
export function whitespaceCrop(image: { width: number; height: number; data: ArrayLike<number> }): Crop | undefined {
  const { width, height, data } = image, buckets = new Map<string, { count: number; sums: number[] }>();
  const samples: number[][] = [];
  /** Premultiplies transparent pixels so hidden RGB values cannot be mistaken for visible content. */
  const color = (offset: number): number[] => {
    const alpha = data[offset + 3];
    return [data[offset] * alpha / 255, data[offset + 1] * alpha / 255, data[offset + 2] * alpha / 255, alpha];
  };
  /** Samples all four edges instead of assuming the top-left corner is free of axes or annotations. */
  const sample = (x: number, y: number): void => {
    const values = color((y * width + x) * 4), key = values.map((value) => Math.floor(value / 16)).join(",");
    const bucket = buckets.get(key) ?? { count: 0, sums: [0, 0, 0, 0] };
    bucket.count++; values.forEach((value, index) => { bucket.sums[index] += value; });
    buckets.set(key, bucket); samples.push(values);
  };
  for (let x = 0; x < width; x += Math.max(1, Math.ceil(width / 128))) { sample(x, 0); sample(x, height - 1); }
  for (let y = 0; y < height; y += Math.max(1, Math.ceil(height / 128))) { sample(0, y); sample(width - 1, y); }
  const dominant = [...buckets.values()].sort((a, b) => b.count - a.count)[0];
  const background = dominant.sums.map((sum) => sum / dominant.count), tolerance = 6;
  if (samples.filter((values) => values.every((value, index) => Math.abs(value - background[index]) <= tolerance)).length < samples.length * .6) return undefined;
  let left = width, top = height, right = -1, bottom = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const offset = (y * width + x) * 4, alpha = data[offset + 3];
      // Any visible contrast counts, including a one-pixel axis, pale annotation or isolated data point.
      if (Math.abs(alpha - background[3]) <= tolerance
        && Math.abs(data[offset] * alpha / 255 - background[0]) <= tolerance
        && Math.abs(data[offset + 1] * alpha / 255 - background[1]) <= tolerance
        && Math.abs(data[offset + 2] * alpha / 255 - background[2]) <= tolerance) continue;
      left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y); bottom = Math.max(bottom, y);
    }
  }
  if (right < left) return undefined; // A completely blank source has no meaningful content rectangle to crop.
  const padding = Math.max(2, Math.ceil(Math.min(width, height) * .005));
  const crop = { left: Math.max(0, left - padding) / width * 100, top: Math.max(0, top - padding) / height * 100,
    right: Math.max(0, width - 1 - right - padding) / width * 100, bottom: Math.max(0, height - 1 - bottom - padding) / height * 100 };
  return Object.values(crop).some((value) => value > 0) ? crop : undefined;
}

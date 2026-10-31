export type PreviewPosition = { page: number; fraction: number; horizontal: number };
export type PreviewState = { source: string; zoom: number | "fit"; position: PreviewPosition };
export type HostMessage =
  | { type: "invalidate"; revision: number }
  | { type: "document"; revision: number; source: string; url: string }
  | { type: "status"; text: string; busy: boolean; failed?: boolean };
export type ViewerMessage =
  | { type: "ready" }
  | { type: "refresh" }
  | { type: "loaded"; revision: number }
  | { type: "failed"; revision: number; message: string }
  | { type: "log"; message: string };

/** Restores bounded viewer state even after a shorter document replaces the previous PDF. */
export function normalizePreviewState(state: Partial<PreviewState> | undefined, source: string, pages = Number.MAX_SAFE_INTEGER): PreviewState {
  const sameSource = state?.source === source;
  const zoom = sameSource && typeof state.zoom === "number" && Number.isFinite(state.zoom) ? Math.min(3, Math.max(0.5, state.zoom)) : "fit";
  const position = sameSource ? state.position : undefined;
  return { source, zoom, position: {
    page: Math.min(Math.max(1, Number.isFinite(position?.page) ? Math.floor(position.page) : 1), Math.max(1, pages)),
    fraction: Math.min(1, Math.max(0, Number.isFinite(position?.fraction) ? position.fraction : 0)),
    horizontal: Math.max(0, Number.isFinite(position?.horizontal) ? position.horizontal : 0),
  } };
}

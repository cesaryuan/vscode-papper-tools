import { getLanguage, t } from "../localization";
/**
 * Display rules for image-card hover metadata.
 *
 * The Webview receives file timestamps and size only after a card is hovered,
 * while decoded dimensions arrive when its nearby bitmap finishes loading.
 */

export type ImageHoverMetadata = {
  relativePath: string;
  width?: number;
  height?: number;
  createdAt?: number;
  modifiedAt?: number;
  size?: number;
  filesystemMetadataLoaded: boolean;
};

export type ImageHoverDetail = {
  label: string;
  value: string;
};

/** Returns the ordered, user-visible metadata lines for one image-card hover surface. */
export function getImageHoverDetails(metadata: ImageHoverMetadata): ImageHoverDetail[] {
  return [
    { label: t("Path"), value: metadata.relativePath },
    { label: t("Resolution"), value: formatResolution(metadata.width, metadata.height) },
    { label: t("Created"), value: formatTimestamp(metadata.createdAt, metadata.filesystemMetadataLoaded) },
    { label: t("Modified"), value: formatTimestamp(metadata.modifiedAt, metadata.filesystemMetadataLoaded) },
    { label: t("Size"), value: formatFileSize(metadata.size, metadata.filesystemMetadataLoaded) },
  ];
}

/** Formats decoded image dimensions, retaining a loading state until the nearby bitmap is available. */
function formatResolution(width: number | undefined, height: number | undefined): string {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width === undefined || height === undefined || width <= 0 || height <= 0) {
    return t("Loading…");
  }
  return `${Math.round(width)} × ${Math.round(height)} px`;
}

/** Formats a filesystem timestamp or distinguishes a pending stat request from an unavailable value. */
function formatTimestamp(timestamp: number | undefined, filesystemMetadataLoaded: boolean): string {
  if (!filesystemMetadataLoaded) {
    return t("Loading…");
  }
  if (!Number.isFinite(timestamp) || timestamp === undefined || timestamp <= 0) {
    return t("Unavailable");
  }
  return new Intl.DateTimeFormat(getLanguage(), { dateStyle: "medium", timeStyle: "medium" }).format(new Date(timestamp));
}

/** Formats a file size using binary units or distinguishes a pending stat request from an unavailable value. */
function formatFileSize(size: number | undefined, filesystemMetadataLoaded: boolean): string {
  if (!filesystemMetadataLoaded) {
    return t("Loading…");
  }
  if (!Number.isFinite(size) || size === undefined || size < 0) {
    return t("Unavailable");
  }
  if (size < 1_024) {
    return `${Math.round(size)} B`;
  }
  if (size < 1_024 ** 2) {
    return `${formatOneDecimal(size / 1_024)} KB`;
  }
  if (size < 1_024 ** 3) {
    return `${formatOneDecimal(size / (1_024 ** 2))} MB`;
  }
  return `${formatOneDecimal(size / (1_024 ** 3))} GB`;
}

/** Keeps binary-size output concise without adding unnecessary trailing decimals. */
function formatOneDecimal(value: number): string {
  return (Math.round(value * 10) / 10).toString();
}

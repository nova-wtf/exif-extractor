/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */
import { findAllSegments } from "./core.js";
import { applyPatches } from "./patch.js";
import type { Patch, Segment } from "./types.js";

async function removeSegments(
  input: Blob,
  filter: (s: Segment) => boolean,
): Promise<Blob> {
  const { format, segments } = await findAllSegments(input);

  const patches: Patch[] = segments.filter(filter).map((s) => ({
    offset: s.offset,
    length: s.length,
    bytes: new Uint8Array(0), // cut; formats that can't be cut turn this into a filler block
    kind: s.kind,
  }));

  if (patches.length === 0) {
    return input;
  }

  return applyPatches(input, patches, format);
}

/** Removes only EXIF data. XMP, comments and other metadata are kept. */
export function removeExif(input: Blob): Promise<Blob> {
  return removeSegments(input, (s) => s.kind === "exif");
}

/** Removes all metadata the handlers find: EXIF, XMP, IPTC, comments, vendor data, … */
export function removeMetadata(input: Blob): Promise<Blob> {
  return removeSegments(input, () => true);
}

/** Lists the metadata in a file without changing anything. */
export async function inspect(
  input: Blob,
): Promise<{ format: string; segments: Segment[] }> {
  return findAllSegments(input);
}

export {
  CorruptFileError,
  ExifExtractorError,
  UnsupportedFormatError,
} from "./errors.js";

export type { Patch, Segment, SegmentType } from "./types.js";

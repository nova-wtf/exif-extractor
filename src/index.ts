/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */
import { analyze } from "./core.js";
import { applyPatches } from "./patch.js";
import type { Format, RemoveOptions, Segment } from "./types.js";

async function removeSegments(
  input: Blob,
  filter: (s: Segment) => boolean,
  { keepOrientation = true }: RemoveOptions,
): Promise<Blob> {
  const { handler, reader, items } = await analyze(input);

  const selected = items.filter(filter);
  if (selected.length === 0) {
    return input;
  }

  const patches = await handler.toPatches(reader, selected, {
    keepOrientation,
  });

  return applyPatches(input, patches, handler.name);
}

/** Removes only EXIF data. XMP, comments and other metadata are kept. */
export function removeExif(
  input: Blob,
  options: RemoveOptions = {},
): Promise<Blob> {
  return removeSegments(input, (s) => s.kind === "exif", options);
}

/** Removes all metadata the handlers find: EXIF, XMP, IPTC, comments, vendor data, … */
export function removeMetadata(
  input: Blob,
  options: RemoveOptions = {},
): Promise<Blob> {
  return removeSegments(input, () => true, options);
}

/** Lists the metadata in a file without changing anything. */
export async function inspect(
  input: Blob,
): Promise<{ format: Format; segments: Segment[] }> {
  const { handler, items } = await analyze(input);

  const segments = items.map(
    ({ kind, offset, length, dataOffset, dataLength }) => ({
      kind,
      offset,
      length,
      ...(dataOffset !== undefined && { dataOffset }),
      ...(dataLength !== undefined && { dataLength }),
    }),
  );
  return { format: handler.name, segments };
}

export {
  CorruptFileError,
  ExifExtractorError,
  UnsupportedFormatError,
} from "./errors.js";

export type {
  Format,
  Patch,
  RemoveOptions,
  Segment,
  SegmentType,
} from "./types.js";

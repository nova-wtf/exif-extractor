/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */
import { CorruptFileError } from "../errors.js";
import type { FormatHandler, Segment } from "../types.js";
import { checkPrefix, readUint32LE } from "../utils.js";

const prefixSignature = [0x52, 0x49, 0x46, 0x46];
const suffixSignature = [0x57, 0x45, 0x42, 0x50];

const encoder = new TextEncoder();
const exifPrefix = encoder.encode("Exif\0\0");

const headers = {
  exif: [encoder.encode("EXIF")],
  xmp: [encoder.encode("XMP ")],
  keep: [
    encoder.encode("VP8X"),
    encoder.encode("VP8 "),
    encoder.encode("VP8L"),
    encoder.encode("ALPH"),
    encoder.encode("ANIM"),
    encoder.encode("ANMF"),
    encoder.encode("ICCP"),
  ],
};

export const webp: FormatHandler = {
  name: "webp",
  detect: (h) =>
    h.length >= 12 &&
    prefixSignature.every((v, i) => h[i] == v) &&
    suffixSignature.every((v, i) => h[i + 8] == v),
  async findSegments(r) {
    const segments: Segment[] = [];

    const riffHeader = await r.read(0, 12);
    if (riffHeader.length < 12) {
      throw new CorruptFileError("truncated file", "webp", 0);
    }

    const end = 8 + readUint32LE(riffHeader, 4);
    if (end > r.size) {
      throw new CorruptFileError("truncated file", "webp", 0);
    }

    let pos = 12;
    for (let i = 0; i < 100_000; i++) {
      // End of metadata
      if (pos >= end) {
        return segments;
      }

      const header = await r.read(pos, 8);
      if (header.length < 8) {
        throw new CorruptFileError("truncated file", "webp", pos);
      }

      const length = readUint32LE(header, 4);

      const padding = length % 2;
      const chunkSize = 8 + length + padding;

      if (pos + chunkSize > end) {
        throw new CorruptFileError("invalid chunk size", "webp", pos);
      }

      const type = header.subarray(0, 4);
      const kind = findKind(type);
      if (kind === "exif") {
        const start = await r.read(
          pos + 8,
          Math.min(exifPrefix.length, length),
        );
        const skip = checkPrefix(start, exifPrefix) ? exifPrefix.length : 0;

        segments.push({
          offset: pos,
          length: chunkSize,
          kind: "exif",
          dataOffset: pos + 8 + skip,
          dataLength: length - skip,
        });
      } else if (kind === "xmp") {
        segments.push({
          offset: pos,
          length: chunkSize,
          kind: "xmp",
          dataOffset: pos + 8,
          dataLength: length,
        });
      } else if (kind != "keep") {
        segments.push({ offset: pos, length: chunkSize, kind: "other" });
      }

      pos += chunkSize;
    }

    throw new CorruptFileError("too many chunks", "webp");
  },
};

type Kind = keyof typeof headers;
function findKind(type: Uint8Array): Kind | undefined {
  for (const kind of Object.keys(headers) as Kind[]) {
    if (headers[kind].some((h) => checkPrefix(type, h))) {
      return kind;
    }
  }
  return undefined;
}

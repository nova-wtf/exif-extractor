/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */
import { CorruptFileError, UnsupportedFormatError } from "../errors.js";
import type { FormatHandler, Segment } from "../types.js";
import { checkPrefix } from "../utils.js";

const signature = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);

const encoder = new TextEncoder();
const webmType = encoder.encode("webm");
const matroskaType = encoder.encode("matroska");

const docTypeHeader = new Uint8Array([0x42, 0x82]);

const segmentHeaders = {
  other: [
    new Uint8Array([0x44, 0x61]), // Date
    new Uint8Array([0x73, 0xa4]), // SegmentUUID
  ],
  comment: [
    new Uint8Array([0x7b, 0xa9]), // title
    new Uint8Array([0x53, 0x6e]), // name
    new Uint8Array([0x12, 0x54, 0xc3, 0x67]), /// tags
  ],
  walk: [
    new Uint8Array([0x18, 0x53, 0x80, 0x67]), // Segment
    new Uint8Array([0x15, 0x49, 0xa9, 0x66]), // Info
    new Uint8Array([0x16, 0x54, 0xae, 0x6b]), // Tracks
    new Uint8Array([0xae]), // TrackEntry
  ],
};

export const ebml: FormatHandler = {
  name: "ebml",
  detect: (h) => h.length >= 8 && checkPrefix(h, signature),
  async findSegments(r) {
    const segments: Segment[] = [];

    const tempHeader = await r.read(4, 1);
    if (tempHeader.length < 1) {
      throw new CorruptFileError("truncated file", "ebml", 4);
    }

    // Only 1-byte header sizes are handled (0x80–0xFE); anything else is a longer VINT or "unknown"
    if ((tempHeader[0]! & 0x80) === 0 || tempHeader[0] === 0xff) {
      throw new UnsupportedFormatError("ebml: unsupported EBML header size");
    }
    const headerSize = tempHeader[0]! & 0x7f;

    // Getting file type
    let headerPos = 5;
    let docType;
    for (let i = 0; i < 100; i++) {
      if (headerPos >= headerSize + 5) {
        throw new UnsupportedFormatError("ebml: no DocType in the EBML header");
      }

      const header = await r.read(headerPos, 11);
      if (!checkPrefix(header, docTypeHeader)) {
        headerPos += 4;
        continue;
      }

      const type = header.subarray(3);
      if (checkPrefix(type, webmType)) {
        docType = "webm";
        break;
      } else if (checkPrefix(type, matroskaType)) {
        docType = "matroska";
        break;
      } else {
        throw new UnsupportedFormatError(
          "ebml: DocType is not webm or matroska",
        );
      }
    }

    if (docType == undefined) {
      throw new CorruptFileError("invalid DocType", "ebml");
    }

    let pos = headerSize + 5;
    for (let i = 0; i < 100_000; i++) {
      if (pos >= r.size) {
        return segments;
      }

      const segId = await r.read(pos, 16);
      const idLength = vintLength(segId[0], pos);
      const { value: size, length: sizeLength } = readVINT(segId, idLength);

      const type = findKind(segId);
      if (size == -1 && type != "walk") {
        return segments;
      }

      if (type == undefined) {
        pos += idLength + sizeLength + size;
      } else if (type != "walk") {
        segments.push({
          kind: type,
          offset: pos,
          length: idLength + sizeLength + size,
          dataLength: size,
          dataOffset: pos + idLength + sizeLength,
        });

        pos += idLength + sizeLength + size;
      } else {
        pos += idLength + sizeLength;
      }
    }

    throw new CorruptFileError("too many elements", "ebml");
  },
};

type Kind = keyof typeof segmentHeaders;
function findKind(type: Uint8Array): Kind | undefined {
  for (const kind of Object.keys(segmentHeaders) as Kind[]) {
    if (segmentHeaders[kind].some((h) => checkPrefix(type, h))) {
      return kind;
    }
  }
  return undefined;
}

export function vintLength(
  firstByte: number | undefined,
  offset?: number,
): number {
  if (firstByte !== undefined) {
    for (let i = 0; i < 8; i++) {
      if (firstByte & (0x80 >> i)) return i + 1;
    }
  }
  throw new CorruptFileError("invalid VINT", "ebml", offset);
}

export function readVINT(
  bytes: Uint8Array,
  offset = 0,
): { value: number; length: number } {
  const first = bytes[offset];
  if (first === undefined)
    throw new CorruptFileError("truncated VINT", "ebml", offset);

  const length = vintLength(first, offset);
  if (offset + length > bytes.length)
    throw new CorruptFileError("truncated VINT", "ebml", offset);

  let value = first & (0xff >> length); // first byte without the marker
  let allOnes = value === 0xff >> length;
  for (let i = 1; i < length; i++) {
    const b = bytes[offset + i]!;
    value = value * 256 + b;
    if (b !== 0xff) allOnes = false;
  }

  return { value: allOnes ? -1 : value, length };
}

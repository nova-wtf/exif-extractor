/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */
import { CorruptFileError } from "../errors.js";
import type { FormatHandler, Segment } from "../types.js";
import { checkPrefix, readUint32LE } from "../utils.js";

const prefixSignature = [0x52, 0x49, 0x46, 0x46];
const suffixSignature = [0x41, 0x56, 0x49, 0x20];

const encoder = new TextEncoder();

const riffCheck = encoder.encode("RIFF");
const avixHeader = encoder.encode("AVIX");

const listHeader = encoder.encode("LIST");

const infoHeader = encoder.encode("INFO");
const checkHeaders = [encoder.encode("hdrl"), encoder.encode("strl")];

const headers = {
  xmp: [encoder.encode("_PMX")],
  vendor: [encoder.encode("strd")],
  comment: [encoder.encode("strn")],
};

export const avi: FormatHandler = {
  name: "avi",
  detect: (h) =>
    h.length >= 12 &&
    prefixSignature.every((v, i) => h[i] == v) &&
    suffixSignature.every((v, i) => h[i + 8] == v),
  async findSegments(r) {
    const segments: Segment[] = [];

    const riffHeader = await r.read(0, 12);
    if (riffHeader.length < 12) {
      throw new CorruptFileError("truncated file", "avi", 0);
    }

    let end = 8 + readUint32LE(riffHeader, 4);
    if (end > r.size) {
      throw new CorruptFileError("truncated file", "avi", 0);
    }

    let pos = 12;
    chunks: for (let i = 0; i < 10_000; i++) {
      // End of metadata
      if (pos >= end) {
        const extendedHeader = await r.read(end, 12);
        if (
          extendedHeader.length === 12 &&
          checkPrefix(extendedHeader, riffCheck) &&
          checkPrefix(extendedHeader.subarray(8, 12), avixHeader)
        ) {
          const blockStart = end;
          end = blockStart + 8 + readUint32LE(extendedHeader, 4);
          if (end > r.size) {
            throw new CorruptFileError("truncated file", "avi", blockStart);
          }
          pos = blockStart + 12;
          continue chunks;
        }
        return segments;
      }

      const header = await r.read(pos, 12);
      if (header.length < 8) {
        throw new CorruptFileError("truncated file", "avi", pos);
      }

      const length = readUint32LE(header, 4);

      const padding = length % 2;
      const chunkSize = 8 + length + padding;

      if (pos + chunkSize > end) {
        throw new CorruptFileError("invalid chunk size", "avi", pos);
      }

      const type = header.subarray(0, 4);
      if (checkPrefix(type, listHeader)) {
        const listType = header.subarray(8, 12);

        if (checkPrefix(listType, infoHeader)) {
          segments.push({
            kind: "comment",
            offset: pos,
            length: chunkSize,
            dataOffset: pos + 12,
            dataLength: length - 4,
          });
        }

        for (const check of checkHeaders) {
          if (checkPrefix(listType, check)) {
            pos += 12;
            continue chunks;
          }
        }
      } else {
        const kind = findKind(type);
        if (kind) {
          segments.push({ kind, offset: pos, length: chunkSize });
        }
      }

      pos += chunkSize;
    }

    throw new CorruptFileError("too many chunks", "avi");
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

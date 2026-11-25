/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */
import { CorruptFileError } from "../errors.js";
import type { FormatHandler, Reader, Segment } from "../types.js";
import { checkPrefix, readUint32BE } from "../utils.js";

const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

const encoder = new TextEncoder();
const itxtHeader = encoder.encode("iTXt");
const xmpKeyword = encoder.encode("XML:com.adobe.xmp\0");
const iendHeader = encoder.encode("IEND");

const headers = {
  exif: [
    encoder.encode("eXIf"),
    encoder.encode("exIf"),
    encoder.encode("zxIf"),
  ],
  comment: [
    encoder.encode("tEXt"),
    encoder.encode("zTXt"),
    encoder.encode("iTXt"),
    encoder.encode("tIME"),
  ],
  vendor: [
    encoder.encode("dSIG"),
    encoder.encode("pCAL"),
    encoder.encode("gIFg"),
    encoder.encode("gIFt"),
    encoder.encode("iDOT"),
    encoder.encode("vpAg"),
    encoder.encode("caNv"),
    encoder.encode("orNT"),
    encoder.encode("prVW"),
    encoder.encode("mkBF"),
    encoder.encode("mkTS"),
    encoder.encode("mkBS"),
    encoder.encode("mkBT"),
    encoder.encode("npTc"),
    encoder.encode("npOl"),
    encoder.encode("npLb"),
    encoder.encode("gIFx"),
  ],
};

export const png: FormatHandler = {
  name: "png",
  detect: (h) => h.length >= 8 && signature.every((v, i) => v == h[i]),
  async findSegments(r) {
    const segments: Segment[] = [];

    let pos = 8;
    for (let i = 0; i < 1_000_000; i++) {
      const header = await r.read(pos, 8);
      if (header.length < 8) {
        throw new CorruptFileError("truncated file", "png", pos);
      }

      const length = readUint32BE(header, 0);

      if (pos + 12 + length > r.size) {
        throw new CorruptFileError("invalid chunk length", "png", pos);
      }

      const type = header.subarray(4, 8);

      // End of metadata
      if (checkPrefix(type, iendHeader)) {
        return segments;
      }

      const kind = findKind(type);
      if (kind === "exif") {
        segments.push({
          offset: pos,
          length: 12 + length,
          kind: "exif",
          dataOffset: pos + 8,
          dataLength: length,
        });
      } else if (
        kind === "comment" &&
        checkPrefix(type, itxtHeader) &&
        (await isXmp(r, pos + 8, length))
      ) {
        segments.push({ offset: pos, length: 12 + length, kind: "xmp" });
      } else if (kind) {
        segments.push({ offset: pos, length: 12 + length, kind });
      }

      pos = pos + 12 + length;
    }

    throw new CorruptFileError("too many chunks", "png");
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

async function isXmp(
  r: Reader,
  dataOffset: number,
  dataLength: number,
): Promise<boolean> {
  const start = await r.read(
    dataOffset,
    Math.min(xmpKeyword.length, dataLength),
  );
  return checkPrefix(start, xmpKeyword);
}

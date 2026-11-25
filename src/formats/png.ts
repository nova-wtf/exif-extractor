/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */
import { CorruptFileError } from "../errors.js";
import { orientationTiff, readOrientation } from "../exif.js";
import type { FormatHandler, Item, SegmentType } from "../types.js";
import {
  ascii,
  checkPrefix,
  concatBytes,
  cutAll,
  fourcc,
  readUint32BE,
  uintBytes,
} from "../utils.js";

const signature = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const xmpKeyword = ascii("XML:com.adobe.xmp\0");

const exifTypes = new Set(["eXIf", "exIf", "zxIf"]);
const commentTypes = new Set(["tEXt", "zTXt", "iTXt", "tIME"]);

// Ancillary chunks that affect how the image looks. All other ancillary chunks go.
const keptTypes = new Set(
  (
    "tRNS cHRM gAMA iCCP sBIT sRGB cICP mDCv mDCV cLLi cLLI " +
    "bKGD hIST pHYs sPLT sTER acTL fcTL fdAT"
  ).split(" "),
);

function kindOf(type: string): SegmentType | undefined {
  if (exifTypes.has(type)) return "exif";
  if (commentTypes.has(type)) return "comment";
  // An uppercase first letter marks a critical chunk: the image needs it
  if ((type.charCodeAt(0) & 0x20) === 0 || keptTypes.has(type)) {
    return undefined;
  }
  return "vendor";
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let k = 0; k < 8; k++) {
      crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export const png: FormatHandler = {
  name: "png",
  detect: (h) => checkPrefix(h, signature),

  async findSegments(r) {
    const items: Item[] = [];

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

      const type = fourcc(header, 4);

      // End of the image: anything after it isn't part of the PNG
      if (type === "IEND") {
        const end = pos + 12 + length;
        if (end < r.size) {
          items.push({ kind: "other", offset: end, length: r.size - end });
        }
        return items;
      }

      let kind = kindOf(type);
      const item = { offset: pos, length: 12 + length };

      if (kind === "exif") {
        items.push({ ...item, kind, dataOffset: pos + 8, dataLength: length });
      } else if (kind) {
        if (type === "iTXt") {
          const start = await r.read(
            pos + 8,
            Math.min(xmpKeyword.length, length),
          );
          if (checkPrefix(start, xmpKeyword)) kind = "xmp";
        }
        items.push({ ...item, kind });
      }

      pos += 12 + length;
    }

    throw new CorruptFileError("too many chunks", "png");
  },

  async toPatches(r, selected, { keepOrientation }) {
    const patches = cutAll(selected);
    if (!keepOrientation) return patches;

    for (const s of selected) {
      if (s.kind !== "exif") continue;

      const orientation = await readOrientation(
        r,
        s.dataOffset!,
        s.dataLength!,
      );
      if (orientation === undefined) continue;

      const tiff = orientationTiff(orientation);
      const body = concatBytes(ascii("eXIf"), tiff);
      patches.find((p) => p.offset === s.offset)!.bytes = concatBytes(
        uintBytes(tiff.length, 4),
        body,
        uintBytes(crc32(body), 4),
      );
      break;
    }

    return patches;
  },
};

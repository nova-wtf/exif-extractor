/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */
import { CorruptFileError } from "../errors.js";
import { orientationTiff, readOrientation } from "../exif.js";
import type { FormatHandler, Item } from "../types.js";
import {
  ascii,
  checkPrefix,
  concatBytes,
  cutAll,
  fourcc,
  readUint32LE,
  uintBytes,
} from "../utils.js";

const exifPrefix = ascii("Exif\0\0");

const keptTypes = new Set([
  "VP8X",
  "VP8 ",
  "VP8L",
  "ALPH",
  "ANIM",
  "ANMF",
  "ICCP",
]);

const EXIF_FLAG = 0x08;
const XMP_FLAG = 0x04;

export const webp: FormatHandler = {
  name: "webp",
  detect: (h) =>
    h.length >= 12 && fourcc(h) === "RIFF" && fourcc(h, 8) === "WEBP",

  async findSegments(r) {
    const items: Item[] = [];

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
      // End of the image: anything after it isn't part of the WebP
      if (pos >= end) {
        if (end < r.size) {
          items.push({ kind: "other", offset: end, length: r.size - end });
        }
        return items;
      }

      const header = await r.read(pos, 8);
      if (header.length < 8) {
        throw new CorruptFileError("truncated file", "webp", pos);
      }

      const length = readUint32LE(header, 4);
      const chunkSize = 8 + length + (length % 2);

      if (pos + chunkSize > end) {
        throw new CorruptFileError("invalid chunk size", "webp", pos);
      }

      const type = fourcc(header);
      const item = { offset: pos, length: chunkSize };

      if (type === "EXIF") {
        const start = await r.read(
          pos + 8,
          Math.min(exifPrefix.length, length),
        );
        const skip = checkPrefix(start, exifPrefix) ? exifPrefix.length : 0;

        items.push({
          ...item,
          kind: "exif",
          dataOffset: pos + 8 + skip,
          dataLength: length - skip,
        });
      } else if (type === "XMP ") {
        items.push({
          ...item,
          kind: "xmp",
          dataOffset: pos + 8,
          dataLength: length,
        });
      } else if (!keptTypes.has(type)) {
        items.push({ ...item, kind: "other" });
      }

      pos += chunkSize;
    }

    throw new CorruptFileError("too many chunks", "webp");
  },

  async toPatches(r, selected, { keepOrientation }) {
    const patches = cutAll(selected);

    const head = await r.read(0, 21); // RIFF header + first chunk's type, size, flags
    const riffSize = readUint32LE(head, 4);
    const isVp8x = head.length === 21 && fourcc(head, 12) === "VP8X";

    let keptExif = false;
    if (keepOrientation && isVp8x) {
      for (const s of selected) {
        if (s.kind !== "exif") continue;

        const orientation = await readOrientation(
          r,
          s.dataOffset!,
          s.dataLength!,
        );
        if (orientation === undefined) continue;

        const tiff = orientationTiff(orientation);
        patches.find((p) => p.offset === s.offset)!.bytes = concatBytes(
          ascii("EXIF"),
          uintBytes(tiff.length, 4, true),
          tiff,
        );
        keptExif = true;
        break;
      }
    }

    if (isVp8x) {
      const oldFlags = head[20]!;
      let flags = oldFlags;
      if (!keptExif && selected.some((s) => s.kind === "exif")) {
        flags &= ~EXIF_FLAG;
      }
      if (selected.some((s) => s.kind === "xmp")) flags &= ~XMP_FLAG;

      if (flags !== oldFlags) {
        patches.push({
          kind: "other",
          offset: 20,
          length: 1,
          bytes: new Uint8Array([flags]),
        });
      }
    }

    // Bytes after the RIFF chunk were never counted in its size
    const removed = patches
      .filter((p) => p.offset >= 12 && p.offset < 8 + riffSize)
      .reduce((n, p) => n + p.length - p.bytes.length, 0);

    if (removed !== 0) {
      patches.push({
        kind: "other",
        offset: 4,
        length: 4,
        bytes: uintBytes(riffSize - removed, 4, true),
      });
    }

    return patches;
  },
};

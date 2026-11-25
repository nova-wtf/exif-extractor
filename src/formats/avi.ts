/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */
import { CorruptFileError } from "../errors.js";
import type { FormatHandler, Item, SegmentType } from "../types.js";
import {
  ascii,
  concatBytes,
  cut,
  fourcc,
  readUint32LE,
  uintBytes,
} from "../utils.js";

const chunkKinds = new Map<string, SegmentType>([
  ["_PMX", "xmp"],
  ["strd", "vendor"],
  ["strn", "comment"],
  ["IDIT", "other"], // recording date
]);

const walkedLists = new Set(["hdrl", "strl"]);

export const avi: FormatHandler = {
  name: "avi",
  detect: (h) =>
    h.length >= 12 && fourcc(h) === "RIFF" && fourcc(h, 8) === "AVI ",

  async findSegments(r) {
    const items: Item[] = [];

    const riffHeader = await r.read(0, 12);
    if (riffHeader.length < 12) {
      throw new CorruptFileError("truncated file", "avi", 0);
    }

    let end = 8 + readUint32LE(riffHeader, 4);
    if (end > r.size) {
      throw new CorruptFileError("truncated file", "avi", 0);
    }

    let pos = 12;
    for (let i = 0; i < 100_000; i++) {
      if (pos >= end) {
        // Files over 1 GB continue in more RIFF blocks
        const next = await r.read(end, 12);
        if (
          next.length === 12 &&
          fourcc(next) === "RIFF" &&
          fourcc(next, 8) === "AVIX"
        ) {
          const blockStart = end;
          end = blockStart + 8 + readUint32LE(next, 4);
          if (end > r.size) {
            throw new CorruptFileError("truncated file", "avi", blockStart);
          }
          pos = blockStart + 12;
          continue;
        }

        // Anything after the last RIFF block isn't part of the video
        if (end < r.size) {
          items.push({
            kind: "other",
            offset: end,
            length: r.size - end,
            cut: true,
          });
        }
        return items;
      }

      const header = await r.read(pos, 12);
      if (header.length < 8) {
        throw new CorruptFileError("truncated file", "avi", pos);
      }

      const length = readUint32LE(header, 4);
      const chunkSize = 8 + length + (length % 2);

      if (pos + chunkSize > end) {
        throw new CorruptFileError("invalid chunk size", "avi", pos);
      }

      const type = fourcc(header);
      if (type === "LIST") {
        const listType = fourcc(header, 8);

        if (listType === "INFO") {
          items.push({
            kind: "comment",
            offset: pos,
            length: chunkSize,
            dataOffset: pos + 12,
            dataLength: length - 4,
          });
        } else if (walkedLists.has(listType)) {
          pos += 12;
          continue;
        }
      } else {
        const kind = chunkKinds.get(type);
        if (kind) {
          items.push({ kind, offset: pos, length: chunkSize });
        }
      }

      pos += chunkSize;
    }

    throw new CorruptFileError("too many chunks", "avi");
  },

  // Frame positions are indexed, so chunks become JUNK of the same size
  toPatches: (_r, selected) =>
    selected.map((s) =>
      s.cut
        ? cut(s.kind, s.offset, s.length)
        : {
            kind: s.kind,
            offset: s.offset,
            length: s.length,
            bytes: concatBytes(ascii("JUNK"), uintBytes(s.length - 8, 4, true)),
            zeros: s.length - 8,
          },
    ),
};

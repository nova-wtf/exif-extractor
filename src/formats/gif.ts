/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */
import { CorruptFileError } from "../errors.js";
import type { FormatHandler, Item, Reader } from "../types.js";
import { cutAll, fourcc } from "../utils.js";

const EXTENSION = 0x21;
const IMAGE = 0x2c;
const TRAILER = 0x3b;

const COMMENT = 0xfe;
const APPLICATION = 0xff;

// Application extensions that affect playback or colour
const keptApplications = new Set([
  "NETSCAPE2.0",
  "ANIMEXTS1.0",
  "ICCRGBG1012",
]);

const colorTableSize = (flags: number) =>
  flags & 0x80 ? 3 * (2 << (flags & 0x07)) : 0;

/** Skips a chain of length-prefixed sub-blocks, including the closing zero. */
async function skipSubBlocks(r: Reader, from: number): Promise<number> {
  let pos = from;
  for (;;) {
    const size = await r.read(pos, 1);
    if (size.length < 1) {
      throw new CorruptFileError("truncated file", "gif", pos);
    }
    pos += 1 + size[0]!;
    if (size[0] === 0) return pos;
  }
}

export const gif: FormatHandler = {
  name: "gif",
  detect: (h) =>
    h.length >= 6 &&
    fourcc(h) === "GIF8" &&
    (h[4] === 0x37 || h[4] === 0x39) &&
    h[5] === 0x61,

  async findSegments(r) {
    const items: Item[] = [];

    const screen = await r.read(0, 13);
    if (screen.length < 13) {
      throw new CorruptFileError("truncated file", "gif", 0);
    }

    let pos = 13 + colorTableSize(screen[10]!);
    for (let i = 0; i < 1_000_000; i++) {
      const block = await r.read(pos, 14);

      if (block[0] === TRAILER) {
        if (pos + 1 < r.size) {
          items.push({
            kind: "other",
            offset: pos + 1,
            length: r.size - pos - 1,
          });
        }
        return items;
      }

      if (block[0] === IMAGE) {
        if (block.length < 11) {
          throw new CorruptFileError("truncated file", "gif", pos);
        }
        // descriptor, local colour table, LZW code size, then the data
        pos = await skipSubBlocks(r, pos + 10 + colorTableSize(block[9]!) + 1);
        continue;
      }

      if (block[0] !== EXTENSION || block.length < 2) {
        throw new CorruptFileError("invalid block", "gif", pos);
      }

      const label = block[1];
      const application =
        label === APPLICATION && block.length === 14 && block[2] === 11
          ? String.fromCharCode(...block.subarray(3, 14))
          : "";

      const end = await skipSubBlocks(r, pos + 2);
      const item = { offset: pos, length: end - pos };

      if (label === COMMENT) {
        items.push({ ...item, kind: "comment" });
      } else if (label === APPLICATION && !keptApplications.has(application)) {
        items.push({
          ...item,
          kind: application === "XMP DataXMP" ? "xmp" : "vendor",
        });
      }

      pos = end;
    }

    throw new CorruptFileError("too many blocks", "gif");
  },

  toPatches: (_r, selected) => cutAll(selected),
};

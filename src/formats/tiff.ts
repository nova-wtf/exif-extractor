/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */
import { CorruptFileError, UnsupportedFormatError } from "../errors.js";
import type {
  FormatHandler,
  Item,
  Patch,
  Reader,
  SegmentType,
} from "../types.js";
import {
  blank,
  concatBytes,
  mergeRanges,
  readUint,
  uintBytes,
} from "../utils.js";

// Metadata tags in the main directories. Everything else describes the image.
const tags = new Map<number, SegmentType>([
  [269, "exif"], // DocumentName
  [270, "exif"], // ImageDescription
  [271, "exif"], // Make
  [272, "exif"], // Model
  [285, "exif"], // PageName
  [305, "exif"], // Software
  [306, "exif"], // DateTime
  [315, "exif"], // Artist
  [316, "exif"], // HostComputer
  [700, "xmp"],
  [33432, "exif"], // Copyright
  [33723, "iptc"],
  [34377, "vendor"], // Photoshop resources
  [34665, "exif"], // Exif IFD
  [34853, "exif"], // GPS IFD
  [37724, "vendor"], // Photoshop layer data
  [40091, "exif"], // Windows XP title, comment, author, keywords, subject
  [40092, "exif"],
  [40093, "exif"],
  [40094, "exif"],
  [40095, "exif"],
]);

const MAKE = 271;
const SUB_IFDS = 330;
const DNG_VERSION = 50706;
const SUB_DIRECTORIES = new Set([34665, 34853, 40965]); // Exif, GPS, Interop

const typeSizes = [0, 1, 1, 2, 4, 8, 1, 1, 2, 4, 8, 4, 8, 4];

type Entry = {
  tag: number;
  raw: Uint8Array;
  /** Where the value lives when it doesn't fit inside the entry. */
  external?: [number, number];
  value: number;
};

type Ifd = {
  offset: number;
  entries: Entry[];
  next: number;
  length: number;
};

async function readIfd(r: Reader, offset: number, le: boolean): Promise<Ifd> {
  const fail = () => new CorruptFileError("invalid directory", "tiff", offset);

  const countBytes = await r.read(offset, 2);
  if (offset < 8 || countBytes.length < 2) throw fail();

  const count = readUint(countBytes, 0, 2, le);
  const length = 2 + count * 12 + 4;
  const bytes = await r.read(offset, length);
  if (bytes.length < length) throw fail();

  const entries: Entry[] = [];
  for (let i = 0; i < count; i++) {
    const at = 2 + i * 12;
    const type = readUint(bytes, at + 2, 2, le);
    const size = (typeSizes[type] ?? 0) * readUint(bytes, at + 4, 4, le);
    const value = readUint(bytes, at + 8, 4, le);

    const entry: Entry = {
      tag: readUint(bytes, at, 2, le),
      raw: bytes.slice(at, at + 12),
      value,
    };
    if (size > 4) {
      if (value + size > r.size) throw fail();
      entry.external = [value, value + size];
    }
    entries.push(entry);
  }

  return { offset, entries, next: readUint(bytes, length - 4, 4, le), length };
}

async function readChain(r: Reader): Promise<{ le: boolean; ifds: Ifd[] }> {
  const head = await r.read(0, 8);
  if (head.length < 8) {
    throw new CorruptFileError("truncated file", "tiff", 0);
  }
  const le = head[0] === 0x49;

  const ifds: Ifd[] = [];
  const seen = new Set<number>();
  let offset = readUint(head, 4, 4, le);
  while (offset !== 0) {
    if (seen.has(offset) || ifds.length >= 1000) {
      throw new CorruptFileError("directory loop", "tiff", offset);
    }
    seen.add(offset);

    const ifd = await readIfd(r, offset, le);
    ifds.push(ifd);
    offset = ifd.next;
  }

  // Camera RAW files are TIFFs whose "metadata" is needed to decode them
  const has = (tag: number) =>
    ifds.some((d) => d.entries.some((e) => e.tag === tag));
  if (has(DNG_VERSION) || (has(SUB_IFDS) && has(MAKE))) {
    throw new UnsupportedFormatError("tiff: camera RAW files are not supported");
  }

  return { le, ifds };
}

/** Every byte range belonging to a metadata sub-directory (Exif, GPS, …). */
async function subDirectoryRanges(
  r: Reader,
  offset: number,
  le: boolean,
  depth = 0,
): Promise<[number, number][]> {
  const ifd = await readIfd(r, offset, le);
  const ranges: [number, number][] = [[offset, offset + ifd.length]];

  for (const e of ifd.entries) {
    if (e.external) ranges.push(e.external);
    if (SUB_DIRECTORIES.has(e.tag) && depth < 2) {
      ranges.push(...(await subDirectoryRanges(r, e.value, le, depth + 1)));
    }
  }
  return ranges;
}

export const tiff: FormatHandler = {
  name: "tiff",
  detect: (h) =>
    h.length >= 8 &&
    // Canon CR2 has "CR" right after the header and is left alone
    !(h[8] === 0x43 && h[9] === 0x52) &&
    ((h[0] === 0x49 && h[1] === 0x49 && h[2] === 42 && h[3] === 0) ||
      (h[0] === 0x4d && h[1] === 0x4d && h[2] === 0 && h[3] === 42)),

  async findSegments(r) {
    const { ifds } = await readChain(r);

    // Each segment is a 12-byte directory entry; its data is the tag's value
    const items: Item[] = [];
    for (const ifd of ifds) {
      ifd.entries.forEach((entry, i) => {
        const kind = tags.get(entry.tag);
        if (!kind) return;
        items.push({
          kind,
          offset: ifd.offset + 2 + i * 12,
          length: 12,
          ...(entry.external && {
            dataOffset: entry.external[0],
            dataLength: entry.external[1] - entry.external[0],
          }),
        });
      });
    }
    return items;
  },

  async toPatches(r, selected) {
    const { le, ifds } = await readChain(r);
    const chosen = new Set(selected.map((s) => s.offset));

    const patches: Patch[] = [];
    const wipe: [number, number][] = [];

    for (const ifd of ifds) {
      const kept: Entry[] = [];
      for (const [i, entry] of ifd.entries.entries()) {
        if (!chosen.has(ifd.offset + 2 + i * 12)) {
          kept.push(entry);
          continue;
        }
        if (entry.external) wipe.push(entry.external);
        if (SUB_DIRECTORIES.has(entry.tag)) {
          wipe.push(...(await subDirectoryRanges(r, entry.value, le)));
        }
      }
      if (kept.length === ifd.entries.length) continue;

      // Rewrite the directory in place with the remaining entries
      const bytes = concatBytes(
        uintBytes(kept.length, 2, le),
        ...kept.map((e) => e.raw),
        uintBytes(ifd.next, 4, le),
      );
      patches.push({
        kind: "other",
        offset: ifd.offset,
        length: ifd.length,
        bytes,
        zeros: ifd.length - bytes.length,
      });
    }

    // Overwrite the removed values, but never a main directory
    const directories = [...ifds].sort((a, b) => a.offset - b.offset);
    for (const [from, end] of mergeRanges(wipe)) {
      let start = from;
      for (const d of directories) {
        if (d.offset >= end || d.offset + d.length <= start) continue;
        if (d.offset > start) {
          patches.push(blank("other", start, d.offset - start));
        }
        start = d.offset + d.length;
      }
      if (end > start) patches.push(blank("other", start, end - start));
    }

    return patches;
  },
};

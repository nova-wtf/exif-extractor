/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */
import { CorruptFileError } from "../errors.js";
import type {
  FormatHandler,
  Item,
  Patch,
  Reader,
  SegmentType,
} from "../types.js";
import {
  ascii,
  blank,
  checkPrefix,
  concatBytes,
  fourcc,
  mergeRanges,
  readUint,
  readUint32BE,
  uintBytes,
} from "../utils.js";

const xmpUuid = new Uint8Array([
  0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8, 0x9c, 0x71, 0x99, 0x94, 0x91,
  0xe3, 0xaf, 0xac,
]);

const containers = new Set(["moov", "trak", "mdia", "moof", "traf"]);
const datedBoxes = new Set(["mvhd", "tkhd", "mdhd"]);

// Timed metadata tracks, which record location and sensor data frame by frame
const metadataTracks = new Set(["gpmd", "camm", "djmd", "dbgi", "mebx"]);

const MAX_BOXES = 200_000;
const MAX_TABLE = 64 * 1024 * 1024;

type Box = {
  type: string;
  offset: number;
  size: number;
  headerSize: number;
};

async function readBox(r: Reader, pos: number, end: number): Promise<Box> {
  const header = await r.read(pos, 16);
  if (header.length < 8) {
    throw new CorruptFileError("truncated file", "isobmff", pos);
  }

  let size = readUint32BE(header, 0);
  let headerSize = 8;

  if (size === 1) {
    if (header.length < 16) {
      throw new CorruptFileError("truncated file", "isobmff", pos);
    }
    size = readUint(header, 8, 8);
    headerSize = 16;
  } else if (size === 0) {
    size = end - pos;
  }

  if (size < headerSize || pos + size > end) {
    throw new CorruptFileError("invalid box size", "isobmff", pos);
  }

  return { type: fourcc(header, 4), offset: pos, size, headerSize };
}

/** The boxes between `start` and `end`. */
async function readBoxes(
  r: Reader,
  start: number,
  end: number,
): Promise<Box[]> {
  const boxes: Box[] = [];
  let pos = start;
  // QuickTime ends some containers with four zero bytes, hence the 8
  while (end - pos >= 8) {
    if (boxes.length >= MAX_BOXES) {
      throw new CorruptFileError("too many boxes", "isobmff");
    }
    const box = await readBox(r, pos, end);
    boxes.push(box);
    pos += box.size;
  }
  return boxes;
}

const childrenOf = async (r: Reader, box: Box | undefined) =>
  box ? readBoxes(r, box.offset + box.headerSize, box.offset + box.size) : [];

const findBox = (boxes: Box[], type: string) =>
  boxes.find((b) => b.type === type);

/** The content of a box that is parsed as a table. */
function body(r: Reader, box: Box): Promise<Uint8Array> {
  const length = box.size - box.headerSize;
  if (length > MAX_TABLE) {
    throw new CorruptFileError("box too large", "isobmff", box.offset);
  }
  return r.read(box.offset + box.headerSize, length);
}

/** Turns a whole box into a `free` box of the same size. */
function freeBox(kind: SegmentType, offset: number, size: number): Patch {
  const bytes =
    size > 0xffffffff
      ? concatBytes(uintBytes(1, 4), ascii("free"), uintBytes(size, 8))
      : concatBytes(uintBytes(size, 4), ascii("free"));
  return { kind, offset, length: size, bytes, zeros: size - bytes.length };
}

const boxItem = (kind: SegmentType, box: Box): Item => ({
  kind,
  offset: box.offset,
  length: box.size,
  patches: [freeBox(kind, box.offset, box.size)],
});

/** The creation and modification times of a movie, track or media header. */
async function dates(r: Reader, box: Box): Promise<Item | undefined> {
  const start = box.offset + box.headerSize;
  const version = (await r.read(start, 1))[0];
  const length = version === 1 ? 16 : 8;
  if (box.size - box.headerSize < 4 + length) return undefined;

  const times = await r.read(start + 4, length);
  if (times.every((b) => b === 0)) return undefined;

  return {
    kind: "other",
    offset: start + 4,
    length,
    patches: [blank("other", start + 4, length)],
  };
}

/** Where a track's samples are stored, worked out from its sample tables. */
async function sampleRanges(
  r: Reader,
  stbl: Box[],
): Promise<[number, number][]> {
  const stsz = findBox(stbl, "stsz");
  const stsc = findBox(stbl, "stsc");
  const stco = findBox(stbl, "stco") ?? findBox(stbl, "co64");
  if (!stsz || !stsc || !stco) return [];

  const sizes = await body(r, stsz);
  const toChunk = await body(r, stsc);
  const offsets = await body(r, stco);
  const width = stco.type === "co64" ? 8 : 4;

  const fixedSize = readUint32BE(sizes, 4);
  const sampleCount = readUint32BE(sizes, 8);
  const chunkCount = readUint32BE(offsets, 4);
  const runCount = readUint32BE(toChunk, 4);

  const ranges: [number, number][] = [];
  let sample = 0;
  let run = 0;
  for (let chunk = 0; chunk < chunkCount && sample < sampleCount; chunk++) {
    // stsc lists runs of chunks that hold the same number of samples
    while (
      run + 1 < runCount &&
      readUint32BE(toChunk, 8 + (run + 1) * 12) <= chunk + 1
    ) {
      run++;
    }
    const perChunk = readUint32BE(toChunk, 8 + run * 12 + 4);
    const start = readUint(offsets, 8 + chunk * width, width);

    let length = 0;
    for (let i = 0; i < perChunk && sample < sampleCount; i++, sample++) {
      length += fixedSize || readUint32BE(sizes, 12 + sample * 4);
      if (start + length > r.size) {
        throw new CorruptFileError("sample past end of file", "isobmff", start);
      }
    }
    if (length > 0) ranges.push([start, start + length]);
  }
  return mergeRanges(ranges);
}

/** If the track is a metadata track: removes it together with its samples. */
async function metadataTrack(r: Reader, trak: Box): Promise<Item | undefined> {
  const mdia = findBox(await childrenOf(r, trak), "mdia");
  const minf = findBox(await childrenOf(r, mdia), "minf");
  const stbl = await childrenOf(
    r,
    findBox(await childrenOf(r, minf), "stbl"),
  );
  const stsd = findBox(stbl, "stsd");
  if (!stsd) return undefined;

  // version/flags, entry count, then the first entry's size and format
  const entry = await r.read(stsd.offset + stsd.headerSize + 8, 8);
  if (entry.length < 8 || !metadataTracks.has(fourcc(entry, 4))) {
    return undefined;
  }

  const samples = await sampleRanges(r, stbl);
  return {
    kind: "other",
    offset: trak.offset,
    length: trak.size,
    patches: [
      freeBox("other", trak.offset, trak.size),
      ...samples.map(([from, to]) => blank("other", from, to - from)),
    ],
  };
}

// HEIC / AVIF store metadata as "items" listed in the top-level meta box

function itemKind(info: Uint8Array): [number, SegmentType] | undefined {
  const version = info[0]!;
  if (version < 2) return undefined;

  const idSize = version === 2 ? 2 : 4;
  const id = readUint(info, 4, idSize);
  const typeAt = 4 + idSize + 2; // after the protection index
  const type = fourcc(info, typeAt);

  if (type === "Exif") return [id, "exif"];
  if (type !== "mime") return undefined; // image data

  // item name, then content type, both NUL-terminated
  const contentStart = info.indexOf(0, typeAt + 4) + 1;
  const contentType = new TextDecoder().decode(
    info.subarray(contentStart, info.indexOf(0, contentStart)),
  );
  return [id, contentType === "application/rdf+xml" ? "xmp" : "other"];
}

function itemLocations(
  iloc: Uint8Array,
  idatStart: number | undefined,
): Map<number, [number, number][]> {
  const version = iloc[0]!;
  const offsetSize = iloc[4]! >> 4;
  const lengthSize = iloc[4]! & 0x0f;
  const baseSize = iloc[5]! >> 4;
  const indexSize = version === 0 ? 0 : iloc[5]! & 0x0f;

  let pos = 6;
  const next = (size: number) => {
    const value = readUint(iloc, pos, size);
    pos += size;
    return value;
  };

  const locations = new Map<number, [number, number][]>();
  const count = next(version < 2 ? 2 : 4);
  for (let i = 0; i < count; i++) {
    const id = next(version < 2 ? 2 : 4);
    const method = version === 0 ? 0 : next(2) & 0x0f;
    next(2); // data reference index
    const base = next(baseSize);
    const extentCount = next(2);

    // 0 = offset in the file, 1 = offset in the idat box
    const origin = method === 0 ? 0 : method === 1 ? idatStart : undefined;

    const extents: [number, number][] = [];
    for (let j = 0; j < extentCount; j++) {
      next(indexSize);
      const offset = next(offsetSize);
      const length = next(lengthSize);
      if (origin !== undefined && length > 0) {
        const start = origin + base + offset;
        extents.push([start, start + length]);
      }
    }
    locations.set(id, extents);
  }
  return locations;
}

/** What an emptied item looks like: an EXIF block with no tags, or blank text. */
function emptyItem(kind: SegmentType, length: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  if (kind === "xmp") {
    out.fill(0x20);
  } else if (kind === "exif" && length >= 18) {
    // 4-byte header offset (0), then a TIFF header with an empty directory
    out.set([0x4d, 0x4d, 0x00, 0x2a, 0x00, 0x00, 0x00, 0x08], 4);
  }
  return out;
}

/** The metadata items of a still image, or undefined for a movie's `meta` box. */
async function imageItems(r: Reader, meta: Box): Promise<Item[] | undefined> {
  const end = meta.offset + meta.size;
  const start = meta.offset + meta.headerSize;
  // `meta` has a version field in ISO files but not in QuickTime ones
  const probe = await r.read(start + 4, 4);
  const hasVersion = probe.length === 4 && fourcc(probe) !== "hdlr";
  const boxes = await readBoxes(r, hasVersion ? start + 4 : start, end);

  const hdlr = findBox(boxes, "hdlr");
  if (!hdlr || fourcc(await body(r, hdlr), 8) !== "pict") return undefined;

  const iinf = findBox(boxes, "iinf");
  const iloc = findBox(boxes, "iloc");
  if (!iinf || !iloc) return [];

  const idat = findBox(boxes, "idat");
  const locations = itemLocations(
    await body(r, iloc),
    idat && idat.offset + idat.headerSize,
  );

  const iinfStart = iinf.offset + iinf.headerSize;
  const iinfVersion = (await r.read(iinfStart, 1))[0];
  const entries = await readBoxes(
    r,
    iinfStart + (iinfVersion === 0 ? 6 : 8),
    iinf.offset + iinf.size,
  );

  const items: Item[] = [];
  for (const entry of entries) {
    const found = itemKind(await body(r, entry));
    if (!found) continue;
    const [id, kind] = found;

    const patches: Patch[] = [];
    for (const [from, to] of locations.get(id) ?? []) {
      if (to > r.size || to - from > MAX_TABLE) {
        throw new CorruptFileError("invalid item location", "isobmff", from);
      }
      const bytes = emptyItem(kind, to - from);
      if (checkPrefix(await r.read(from, to - from), bytes)) continue; // done before

      patches.push({ kind, offset: from, length: to - from, bytes });
    }

    const first = patches[0];
    if (first) {
      items.push({
        kind,
        offset: first.offset,
        length: first.length,
        patches,
      });
    }
  }
  return items;
}

export const isobmff: FormatHandler = {
  name: "isobmff",
  detect: (h) =>
    h.length >= 12 &&
    fourcc(h, 4) === "ftyp" &&
    fourcc(h, 8) !== "crx ", // Canon RAW

  async findSegments(r) {
    const items: Item[] = [];
    let count = 0;

    const walk = async (start: number, end: number, depth: number) => {
      let pos = start;
      while (pos < end) {
        if (depth > 0 && end - pos < 8) return;
        if (++count > MAX_BOXES) {
          throw new CorruptFileError("too many boxes", "isobmff");
        }

        const box = await readBox(r, pos, end);
        pos += box.size;

        if (box.type === "trak") {
          const track = await metadataTrack(r, box);
          if (track) {
            items.push(track);
            continue;
          }
        }

        if (containers.has(box.type)) {
          if (depth < 8) {
            await walk(box.offset + box.headerSize, pos, depth + 1);
          }
        } else if (box.type === "udta") {
          items.push(boxItem("comment", box));
        } else if (box.type === "meta") {
          const found = depth === 0 ? await imageItems(r, box) : undefined;
          if (found) items.push(...found);
          else items.push(boxItem("comment", box));
        } else if (box.type === "uuid") {
          const id = await r.read(box.offset + box.headerSize, 16);
          if (checkPrefix(id, xmpUuid)) items.push(boxItem("xmp", box));
        } else if (datedBoxes.has(box.type)) {
          const found = await dates(r, box);
          if (found) items.push(found);
        }
      }
    };

    try {
      await walk(0, r.size, 0);
    } catch (e) {
      // A table that is shorter than it claims
      if (e instanceof RangeError) {
        throw new CorruptFileError("invalid table", "isobmff");
      }
      throw e;
    }
    return items;
  },

  // Frame positions are indexed, so nothing is cut: it's all overwritten in place
  toPatches: (_r, selected) => selected.flatMap((s) => s.patches!),
};

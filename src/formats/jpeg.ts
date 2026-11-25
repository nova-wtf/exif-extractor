/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */
import { CorruptFileError } from "../errors.js";
import { orientationTiff, readOrientation } from "../exif.js";
import type {
  FormatHandler,
  Item,
  Patch,
  Reader,
  SegmentType,
} from "../types.js";
import {
  ascii,
  checkPrefix,
  concatBytes,
  cutAll,
  readUint,
  readUint16BE,
  uintBytes,
} from "../utils.js";

const exifHeader = ascii("Exif\0\0");
const xmpHeader = ascii("http://ns.adobe.com/xap/1.0/\0");
const eXmpHeader = ascii("http://ns.adobe.com/xmp/extension/\0");
const jfifHeader = ascii("JFIF\0");
const iccHeader = ascii("ICC_PROFILE\0");
const mpfHeader = ascii("MPF\0");
const isoGainMapHeader = ascii("urn:iso:std:iso:ts:21496:-1\0");
const adobeHeader = ascii("Adobe");

const SCAN_CHUNK = 256 * 1024;
const MAX_IMAGES = 100;

type MpEntry = {
  /** Where the entry's size field sits in the file; the offset field follows it. */
  fieldOffset: number;
  littleEndian: boolean;
  /** The byte that image offsets are relative to. */
  base: number;
  start: number;
  size: number;
};

/**
 * Finds the next real marker after compressed image data. Inside that data
 * 0xFF is always followed by 0x00 (stuffing) or a restart marker.
 */
async function skipScanData(r: Reader, from: number): Promise<number> {
  let pos = from;
  while (pos < r.size) {
    const chunk = await r.read(pos, SCAN_CHUNK);
    let i = chunk.indexOf(0xff);
    while (i !== -1 && i + 1 < chunk.length) {
      const next = chunk[i + 1]!;
      if (next !== 0x00 && next !== 0xff && (next < 0xd0 || next > 0xd7)) {
        return pos + i;
      }
      i = chunk.indexOf(0xff, i + 1);
    }
    if (pos + chunk.length >= r.size) break;
    pos += chunk.length - 1; // a marker may straddle two chunks
  }
  return r.size;
}

/** Reads the image list from an MPF (multi-picture) APP2 segment. */
async function readMpf(
  r: Reader,
  base: number,
  length: number,
): Promise<MpEntry[]> {
  const data = await r.read(base, Math.max(0, length));
  if (data.length < 8) return [];
  const le = data[0] === 0x49;

  const ifd = readUint(data, 4, 4, le);
  if (ifd + 2 > data.length) return [];

  const count = readUint(data, ifd, 2, le);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > data.length) break;
    if (readUint(data, entry, 2, le) !== 0xb002) continue; // MPEntry

    const bytes = readUint(data, entry + 4, 4, le);
    const at = readUint(data, entry + 8, 4, le);
    if (at + bytes > data.length) break;

    const entries: MpEntry[] = [];
    for (let e = at; e + 16 <= at + bytes; e += 16) {
      const offset = readUint(data, e + 8, 4, le);
      entries.push({
        fieldOffset: base + e + 4,
        littleEndian: le,
        base,
        start: offset === 0 ? 0 : base + offset, // 0 means the first image
        size: readUint(data, e + 4, 4, le),
      });
    }
    return entries;
  }
  return [];
}

/** Walks one JPEG image starting at `start` and returns where it ends. */
async function parseImage(
  r: Reader,
  start: number,
  items: Item[],
  mpf: MpEntry[],
): Promise<number> {
  let pos = start + 2;
  let inScan = false;

  for (let i = 0; i < 100_000; i++) {
    const header = await r.read(pos, 2);

    // A file that stops in the middle of the image data still opens in viewers
    if (inScan && header.length < 2) return r.size;
    if (header.length < 2 || header[0] !== 0xff) {
      throw new CorruptFileError("invalid marker", "jpeg", pos);
    }

    const marker = header[1]!;

    if (marker === 0xd9) return pos + 2; // EOI

    // Padding byte
    if (marker === 0xff) {
      pos++;
      continue;
    }

    // Markers without a length field
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      pos += 2;
      continue;
    }

    const segmentHeader = await r.read(pos + 2, 2);
    if (segmentHeader.length < 2) {
      throw new CorruptFileError("truncated file", "jpeg", pos);
    }

    const segmentLength = readUint16BE(segmentHeader, 0);
    if (segmentLength < 2 || pos + 2 + segmentLength > r.size) {
      throw new CorruptFileError("invalid segment length", "jpeg", pos);
    }

    const contentOffset = pos + 4;
    const contentLength = segmentLength - 2;
    const totalLength = 2 + segmentLength; // marker + length field + content

    // SOS: compressed data follows. Progressive files have several scans.
    if (marker === 0xda) {
      inScan = true;
      pos = await skipScanData(r, pos + totalLength);
      continue;
    }

    const wipe = (kind: SegmentType) => {
      items.push({ kind, offset: pos, length: totalLength });
    };
    const content = () => r.read(contentOffset, Math.min(35, contentLength));

    if (marker === 0xe0) {
      if (!checkPrefix(await content(), jfifHeader)) wipe("other");
    } else if (marker === 0xe1) {
      const head = await content();
      const data = (kind: SegmentType, prefix: number) => {
        items.push({
          kind,
          offset: pos,
          length: totalLength,
          dataOffset: contentOffset + prefix,
          dataLength: contentLength - prefix,
        });
      };

      if (checkPrefix(head, exifHeader)) data("exif", exifHeader.length);
      else if (checkPrefix(head, xmpHeader)) data("xmp", xmpHeader.length);
      else if (checkPrefix(head, eXmpHeader)) wipe("exmp");
      else wipe("other");
    } else if (marker === 0xe2) {
      // Keep colour profiles, the multi-picture index and HDR gain map info
      const head = await content();
      if (checkPrefix(head, mpfHeader)) {
        if (start === 0) {
          mpf.push(...(await readMpf(r, contentOffset + 4, contentLength - 4)));
        }
      } else if (
        !checkPrefix(head, iccHeader) &&
        !checkPrefix(head, isoGainMapHeader)
      ) {
        wipe("vendor");
      }
    } else if (marker === 0xed) {
      wipe("iptc");
    } else if (marker === 0xee) {
      if (!checkPrefix(await content(), adobeHeader)) wipe("other");
    } else if (marker >= 0xe3 && marker <= 0xef) {
      wipe("vendor");
    } else if (marker === 0xfe) {
      wipe("comment");
    }

    pos += totalLength;
  }

  throw new CorruptFileError("too many segments", "jpeg");
}

async function parse(r: Reader): Promise<{ items: Item[]; mpf: MpEntry[] }> {
  const items: Item[] = [];
  const mpf: MpEntry[] = [];

  let pos = await parseImage(r, 0, items, mpf);

  // After the first image: more images (MPF, HDR gain maps) are cleaned like the
  // first one; anything else (motion photo video, vendor blobs) is removed.
  for (let i = 0; i < MAX_IMAGES && pos < r.size; i++) {
    const head = await r.read(pos, 3);
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
      const found: Item[] = [];
      try {
        pos = await parseImage(r, pos, found, mpf);
        items.push(...found);
        continue;
      } catch (e) {
        if (!(e instanceof CorruptFileError)) throw e;
      }
    }

    const here = pos;
    const nextImage = Math.min(
      r.size,
      ...mpf.filter((m) => m.start > here).map((m) => m.start),
    );
    items.push({ kind: "other", offset: pos, length: nextImage - pos });
    pos = nextImage;
  }

  if (pos < r.size) {
    items.push({ kind: "other", offset: pos, length: r.size - pos });
  }

  return { items, mpf };
}

// The MPF index found while listing segments, so removal doesn't scan the file again
const indexes = new WeakMap<Reader, MpEntry[]>();

/** Removing bytes moves the extra images, so the MPF index has to follow. */
function fixMpf(mpf: MpEntry[], patches: Patch[]): Patch[] {
  const moved = (x: number) =>
    patches.reduce(
      (at, p) =>
        p.offset + p.length <= x ? at - p.length + p.bytes.length : at,
      x,
    );

  const fixes: Patch[] = [];
  for (const entry of mpf) {
    const size = moved(entry.start + entry.size) - moved(entry.start);
    const offset =
      entry.start === 0 ? 0 : moved(entry.start) - moved(entry.base);
    const oldOffset = entry.start === 0 ? 0 : entry.start - entry.base;
    if (size === entry.size && offset === oldOffset) continue;

    fixes.push({
      kind: "other",
      offset: entry.fieldOffset,
      length: 8,
      bytes: concatBytes(
        uintBytes(size, 4, entry.littleEndian),
        uintBytes(offset, 4, entry.littleEndian),
      ),
    });
  }
  return fixes;
}

export const jpeg: FormatHandler = {
  name: "jpeg",
  detect: (h) =>
    h.length >= 3 && h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff,

  async findSegments(r) {
    const { items, mpf } = await parse(r);
    indexes.set(r, mpf);
    return items;
  },

  async toPatches(r, selected, { keepOrientation }) {
    const patches = cutAll(selected);
    const mpf = indexes.get(r)!;

    if (keepOrientation) {
      // Only the first image's EXIF decides how the picture is displayed
      const firstExtra = Math.min(
        r.size,
        ...mpf.filter((m) => m.start > 0).map((m) => m.start),
      );
      for (const s of selected) {
        if (s.kind !== "exif" || s.offset >= firstExtra) continue;

        const orientation = await readOrientation(
          r,
          s.dataOffset!,
          s.dataLength!,
        );
        if (orientation === undefined) continue;

        const tiff = orientationTiff(orientation);
        patches.find((p) => p.offset === s.offset)!.bytes = concatBytes(
          new Uint8Array([0xff, 0xe1]),
          uintBytes(2 + exifHeader.length + tiff.length, 2),
          exifHeader,
          tiff,
        );
        break;
      }
    }

    return [...patches, ...fixMpf(mpf, patches)];
  },
};

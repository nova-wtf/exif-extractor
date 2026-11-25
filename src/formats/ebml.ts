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
import { checkPrefix, concatBytes, uintBytes } from "../utils.js";

const signature = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3]);

// Element IDs, marker bits included
const EBML = 0x1a45dfa3;
const DOC_TYPE = 0x4282;
const SEGMENT = 0x18538067;
const INFO = 0x1549a966;
const TRACKS = 0x1654ae6b;
const TRACK_ENTRY = 0xae;
const CLUSTER = 0x1f43b675;
const TAGS = 0x1254c367;
const CRC32 = 0xbf;

const metadata = new Map<number, SegmentType>([
  [0x4461, "other"], // DateUTC
  [0x73a4, "other"], // SegmentUUID
  [0x7ba9, "comment"], // Title
  [0x536e, "comment"], // track Name
  [TAGS, "comment"],
]);

const masters = new Set([SEGMENT, INFO, TRACKS, TRACK_ENTRY]);

// What can follow a Cluster; used to find where an unknown-size Cluster ends
const topLevel = new Set([
  EBML,
  SEGMENT,
  INFO,
  TRACKS,
  CLUSTER,
  TAGS,
  0x1c53bb6b, // Cues
  0x114d9b74, // SeekHead
  0x1043a770, // Chapters
  0x1941a469, // Attachments
]);

const MAX_ELEMENTS = 20_000_000;
const MAX_DEPTH = 8;

export function vintLength(
  firstByte: number | undefined,
  offset?: number,
): number {
  if (!firstByte) {
    throw new CorruptFileError("invalid VINT", "ebml", offset);
  }
  return Math.clz32(firstByte) - 23; // leading zeros within the byte, plus one
}

/** Reads a variable-length integer. `value` is -1 for "unknown size". */
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

type Element = { id: number; size: number; headerLength: number };

function parseElement(bytes: Uint8Array, position: number): Element {
  const idLength = vintLength(bytes[0], position);
  if (idLength > 4 || idLength >= bytes.length) {
    throw new CorruptFileError("invalid element", "ebml", position);
  }
  let id = 0;
  for (let i = 0; i < idLength; i++) id = id * 256 + bytes[i]!;

  const { value: size, length } = readVINT(bytes, idLength);
  return { id, size, headerLength: idLength + length };
}

/** A `Void` element filling exactly `length` bytes. */
function voidElement(kind: SegmentType, offset: number, length: number): Patch {
  const shortSize = length - 2;
  const bytes =
    shortSize <= 126
      ? new Uint8Array([0xec, 0x80 | shortSize])
      : concatBytes(new Uint8Array([0xec, 0x01]), uintBytes(length - 9, 7));
  return { kind, offset, length, bytes, zeros: length - bytes.length };
}

/** Reads the EBML header, checks the DocType, and returns where the header ends. */
async function readHeader(r: Reader): Promise<number> {
  const head = parseElement(await r.read(0, 12), 0);
  const end = head.headerLength + head.size;
  if (head.size < 0 || head.size > 4096 || end > r.size) {
    throw new CorruptFileError("invalid EBML header", "ebml", 0);
  }

  let pos = head.headerLength;
  while (pos < end) {
    const el = parseElement(await r.read(pos, 12), pos);
    const data = pos + el.headerLength;
    if (el.size < 0 || data + el.size > end) {
      throw new CorruptFileError("invalid EBML header", "ebml", pos);
    }

    if (el.id === DOC_TYPE) {
      const type = new TextDecoder()
        .decode(await r.read(data, Math.min(el.size, 16)))
        .replace(/\0+$/, "");
      if (type !== "webm" && type !== "matroska") {
        throw new UnsupportedFormatError(
          "ebml: DocType is not webm or matroska",
        );
      }
      return end;
    }
    pos = data + el.size;
  }

  throw new UnsupportedFormatError("ebml: no DocType in the EBML header");
}

type EbmlItem = Item & {
  /** Checksum elements that stop matching once this element is removed. */
  checksums: [number, number][];
};

export const ebml: FormatHandler = {
  name: "ebml",
  detect: (h) => h.length >= 8 && checkPrefix(h, signature),

  async findSegments(r) {
    const items: EbmlItem[] = [];
    let count = 0;

    /**
     * Walks the elements from `start` to `end` and returns where it stopped;
     * `r.size` means nothing more can be read. `inCluster` means we're inside a
     * Cluster of unknown size, which ends at the next top-level element.
     */
    const walk = async (
      start: number,
      end: number,
      outerChecksums: [number, number][],
      depth: number,
      inCluster = false,
    ): Promise<number> => {
      let checksums = outerChecksums;
      let pos = start;

      while (pos < end) {
        if (++count > MAX_ELEMENTS) {
          throw new CorruptFileError("too many elements", "ebml");
        }

        let el: Element;
        try {
          el = parseElement(await r.read(pos, 12), pos);
        } catch (e) {
          // Live recordings often stop in the middle of a block
          if (inCluster) return r.size;
          throw e;
        }
        if (inCluster && topLevel.has(el.id)) return pos;

        const data = pos + el.headerLength;

        if (el.size < 0) {
          // Only a Segment or a Cluster may be left open
          if (el.id === SEGMENT && depth < MAX_DEPTH) {
            return walk(data, end, checksums, depth + 1);
          }
          if (el.id !== CLUSTER || inCluster) return r.size;
          pos = await walk(data, end, checksums, depth, true);
          continue;
        }

        const next = data + el.size;
        if (next > end) {
          // A cut-off last Cluster is fine; a cut-off anything else is not
          if (inCluster || el.id === CLUSTER) return r.size;
          throw new CorruptFileError("element past end", "ebml", pos);
        }

        if (!inCluster) {
          const kind = metadata.get(el.id);
          if (el.id === CRC32 && pos === start && depth > 0) {
            checksums = [...outerChecksums, [pos, next - pos]];
          } else if (kind) {
            items.push({
              kind,
              offset: pos,
              length: next - pos,
              dataOffset: data,
              dataLength: el.size,
              checksums,
            });
          } else if (masters.has(el.id) && depth < MAX_DEPTH) {
            await walk(data, next, checksums, depth + 1);
          }
        }

        pos = next;
      }
      return pos;
    };

    await walk(await readHeader(r), r.size, [], 0);
    return items;
  },

  // Frame positions are indexed, so elements become Void of the same size
  toPatches(_r, selected) {
    const patches = selected.map((s) =>
      voidElement(s.kind, s.offset, s.length),
    );

    // CRC-32 is optional, so a checksum that no longer matches is voided too
    const checksums = new Map(
      (selected as EbmlItem[]).flatMap((s) => s.checksums),
    );
    for (const [offset, length] of checksums) {
      patches.push(voidElement("other", offset, length));
    }

    return patches;
  },
};

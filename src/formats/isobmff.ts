/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */
import { CorruptFileError } from "../errors.js";
import type { FormatHandler, Segment } from "../types.js";
import { checkPrefix, readUint32BE } from "../utils.js";

const encoder = new TextEncoder();

// HEIC can't be handled with this even though it has the same signature
const excludedBrands = [
  "heic",
  "heix",
  "mif1",
  "msf1",
  "avif",
  "avis",
  "crx ",
].map((b) => encoder.encode(b));

const ftypHeader = encoder.encode("ftyp");
const moovHeader = encoder.encode("moov");
const trakHeader = encoder.encode("trak");
const udtaHeader = encoder.encode("udta");
const metaHeader = encoder.encode("meta");
const uuidHeader = encoder.encode("uuid");
const xmpUuid = new Uint8Array([
  0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8, 0x9c, 0x71, 0x99, 0x94, 0x91,
  0xe3, 0xaf, 0xac,
]);

export const isobmff: FormatHandler = {
  name: "isobmff",
  detect: (h) =>
    h.length >= 12 &&
    checkPrefix(h.subarray(4, 8), ftypHeader) &&
    !excludedBrands.some((b) => checkPrefix(h.subarray(8, 12), b)),
  async findSegments(r) {
    const segments: Segment[] = [];

    let pos = 0;
    for (let i = 0; i < 100_000; i++) {
      // End of metadata
      if (pos >= r.size) {
        return segments;
      }

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

        size = readUint32BE(header, 8) * 2 ** 32 + readUint32BE(header, 12);
        headerSize = 16;
      } else if (size === 0) {
        size = r.size - pos;
      }

      if (size < headerSize || pos + size > r.size) {
        throw new CorruptFileError("invalid box size", "isobmff", pos);
      }

      const type = header.subarray(4, 8);

      if (checkPrefix(type, moovHeader) || checkPrefix(type, trakHeader)) {
        pos += headerSize;
        continue;
      }

      if (checkPrefix(type, udtaHeader) || checkPrefix(type, metaHeader)) {
        segments.push({ kind: "comment", offset: pos, length: size });
      }

      if (checkPrefix(type, uuidHeader)) {
        const id = await r.read(pos + headerSize, 16);
        if (checkPrefix(id, xmpUuid)) {
          segments.push({ kind: "xmp", offset: pos, length: size });
        }
      }

      pos += size;
    }

    throw new CorruptFileError("too many boxes", "isobmff");
  },
};

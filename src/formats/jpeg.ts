/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */
import { CorruptFileError } from "../errors.js";
import type { FormatHandler, Segment, SegmentType } from "../types.js";
import { checkPrefix, readUint16BE } from "../utils.js";

const encoder = new TextEncoder();
const exifHeader = encoder.encode("Exif\0\0");
const xmpHeader = encoder.encode("http://ns.adobe.com/xap/1.0/\0");
const eXmpHeader = encoder.encode("http://ns.adobe.com/xmp/extension/\0");
const jfifHeader = encoder.encode("JFIF\0");
const iccHeader = encoder.encode("ICC_PROFILE\0");
const mpfHeader = encoder.encode("MPF\0");
const adobeHeader = encoder.encode("Adobe");

export const jpeg: FormatHandler = {
  name: "jpeg",
  detect: (h) =>
    h.length >= 3 && h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff,

  async findSegments(r) {
    const segments: Segment[] = [];
    let pos = 2;

    for (let i = 0; i < 10_000; i++) {
      const header = await r.read(pos, 2);
      if (header.length < 2 || header[0] !== 0xff) {
        throw new CorruptFileError("invalid marker", "jpeg", pos);
      }

      const markerType = header[1];

      // End of metadata
      if (markerType === 0xda || markerType === 0xd9) {
        return segments;
      }

      // Padding byte
      if (markerType === 0xff) {
        pos++;
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

      const wipe = (kind: SegmentType) => {
        segments.push({ kind, offset: pos, length: totalLength });
      };

      switch (markerType) {
        // APP0
        case 0xe0: {
          const content = await r.read(
            contentOffset,
            Math.min(5, contentLength),
          );
          if (!checkPrefix(content, jfifHeader)) wipe("other");
          break;
        }

        // APP1
        case 0xe1: {
          const content = await r.read(
            contentOffset,
            Math.min(35, contentLength),
          );

          if (checkPrefix(content, exifHeader)) {
            segments.push({
              kind: "exif",
              offset: pos,
              length: totalLength,
              dataOffset: contentOffset + exifHeader.length,
              dataLength: contentLength - exifHeader.length,
            });
          } else if (checkPrefix(content, xmpHeader)) {
            segments.push({
              kind: "xmp",
              offset: pos,
              length: totalLength,
              dataOffset: contentOffset + xmpHeader.length,
              dataLength: contentLength - xmpHeader.length,
            });
          } else if (checkPrefix(content, eXmpHeader)) {
            wipe("exmp");
          } else {
            wipe("other");
          }
          break;
        }

        // APP2 keep ICC profile and MPF
        case 0xe2: {
          const content = await r.read(
            contentOffset,
            Math.min(12, contentLength),
          );
          if (
            !checkPrefix(content, iccHeader) &&
            !checkPrefix(content, mpfHeader)
          ) {
            wipe("vendor");
          }
          break;
        }

        // APP3 – APP12, APP15
        case 0xe3:
        case 0xe4:
        case 0xe5:
        case 0xe6:
        case 0xe7:
        case 0xe8:
        case 0xe9:
        case 0xea:
        case 0xeb:
        case 0xec:
        case 0xef:
          wipe("vendor");
          break;

        // APP13
        case 0xed:
          wipe("iptc");
          break;

        // APP14
        case 0xee: {
          const content = await r.read(
            contentOffset,
            Math.min(5, contentLength),
          );
          if (!checkPrefix(content, adobeHeader)) wipe("other");
          break;
        }

        // COM
        case 0xfe:
          wipe("comment");
          break;
      }

      pos += totalLength;
    }

    throw new CorruptFileError("too many segments", "jpeg");
  },
};

/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */
import type { Patch } from "./types.js";

const freeHeader = new TextEncoder().encode("free");

export async function applyPatches(
  input: Blob,
  patches: Patch[],
  format: string,
): Promise<Blob> {
  const parts: BlobPart[] = [];

  const formattedPatches = await addFormatFixes(input, patches, format);

  let currentOffset = 0;
  for (const patch of formattedPatches.toSorted(
    (a, b) => a.offset - b.offset,
  )) {
    if (patch.offset < currentOffset) {
      throw new Error("overlapping patches");
    }

    if (input.size < patch.offset + patch.length) {
      throw new Error("patch out of bounds");
    }

    const prefix = input.slice(currentOffset, patch.offset);
    parts.push(prefix);
    parts.push(patch.bytes);
    currentOffset = patch.offset + patch.length;
  }

  const remainingData = input.slice(currentOffset);
  parts.push(remainingData);

  return new Blob(parts, { type: input.type });
}

const junkHeader = new TextEncoder().encode("JUNK");

async function addFormatFixes(
  input: Blob,
  patches: Patch[],
  format: string,
): Promise<Patch[]> {
  const results = [...patches];
  if (format == "webp") {
    let removed = 0;
    for (const p of patches) {
      removed += p.length - p.bytes.byteLength;
    }

    const v = new Uint8Array(await input.slice(12, 21).arrayBuffer()); // fourcc + size + flags
    const isVp8x =
      v.length === 9 &&
      String.fromCharCode(v[0]!, v[1]!, v[2]!, v[3]!) === "VP8X";

    if (isVp8x) {
      const oldFlags = v[8]!;
      let flags = oldFlags;
      if (patches.some((p) => p.kind === "exif")) flags &= ~0x08; // EXIF flag
      if (patches.some((p) => p.kind === "xmp")) flags &= ~0x04; // XMP flag

      if (flags !== oldFlags) {
        results.push({
          kind: "other",
          offset: 20,
          length: 1,
          bytes: new Uint8Array([flags]),
        });
      }
    }

    if (removed != 0) {
      const h = new Uint8Array(await input.slice(4, 8).arrayBuffer());
      const oldSize =
        (h[0]! | (h[1]! << 8) | (h[2]! << 16) | (h[3]! << 24)) >>> 0;
      const size = oldSize - removed;

      results.push({
        kind: "other",
        offset: 4,
        length: 4,
        bytes: new Uint8Array([
          size & 0xff,
          (size >>> 8) & 0xff,
          (size >>> 16) & 0xff,
          (size >>> 24) & 0xff,
        ]),
      });
    }
  } else if (format == "avi") {
    for (let i = 0; i < patches.length; i++) {
      const p = patches[i]!;
      const emptyBytes = p.length - p.bytes.length;

      if (emptyBytes === 0) {
        continue;
      }

      if (emptyBytes < 8 || emptyBytes % 2 !== 0) {
        throw new Error("unable to apply patches");
      }

      const bytes = new Uint8Array(p.length);
      bytes.set(p.bytes, 0);

      const junkAt = p.bytes.length;
      const junkSize = emptyBytes - 8;
      bytes.set(junkHeader, junkAt);
      bytes[junkAt + 4] = junkSize & 0xff;
      bytes[junkAt + 5] = (junkSize >>> 8) & 0xff;
      bytes[junkAt + 6] = (junkSize >>> 16) & 0xff;
      bytes[junkAt + 7] = (junkSize >>> 24) & 0xff;

      results[i] = { ...p, bytes };
    }
  } else if (format == "isobmff") {
    for (let i = 0; i < patches.length; i++) {
      const p = patches[i]!;
      if (p.bytes.length !== 0) continue;

      const bytes = new Uint8Array(p.length);
      bytes[0] = (p.length >>> 24) & 0xff;
      bytes[1] = (p.length >>> 16) & 0xff;
      bytes[2] = (p.length >>> 8) & 0xff;
      bytes[3] = p.length & 0xff;
      bytes.set(freeHeader, 4); // "free"

      results[i] = { ...p, bytes };
    }
  } else if (format == "ebml") {
    for (let i = 0; i < patches.length; i++) {
      const p = patches[i]!;
      if (p.bytes.length !== 0) continue;

      const bytes = new Uint8Array(p.length);
      bytes[0] = 0xec;

      const dataSize = p.length - 2;
      if (dataSize <= 126) {
        bytes[1] = 0x80 | dataSize;
      } else {
        let n = p.length - 9;
        bytes[1] = 0x01;
        for (let j = 8; j >= 2; j--) {
          bytes[j] = n % 256;
          n = Math.floor(n / 256);
        }
      }

      results[i] = { ...p, bytes };
    }
  }

  return results;
}

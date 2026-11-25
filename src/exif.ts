/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */
import type { Reader } from "./types.js";
import { concatBytes, readUint, uintBytes } from "./utils.js";

const ORIENTATION = 0x0112;

/** The orientation (2–8) stored in a TIFF/EXIF block, or undefined if upright or absent. */
export async function readOrientation(
  r: Reader,
  offset: number,
  length: number,
): Promise<number | undefined> {
  const tiff = await r.read(offset, Math.max(0, Math.min(length, 64 * 1024)));
  if (tiff.length < 14) return undefined;

  const le = tiff[0] === 0x49 && tiff[1] === 0x49;
  if (!le && !(tiff[0] === 0x4d && tiff[1] === 0x4d)) return undefined;

  const ifd = readUint(tiff, 4, 4, le);
  if (ifd + 2 > tiff.length) return undefined;

  const count = readUint(tiff, ifd, 2, le);
  for (let i = 0; i < count; i++) {
    const entry = ifd + 2 + i * 12;
    if (entry + 12 > tiff.length) break;
    if (readUint(tiff, entry, 2, le) !== ORIENTATION) continue;

    const value = readUint(tiff, entry + 8, 2, le);
    return value >= 2 && value <= 8 ? value : undefined;
  }
  return undefined;
}

/** A 26-byte TIFF block holding the orientation tag and nothing else. */
export function orientationTiff(orientation: number): Uint8Array<ArrayBuffer> {
  return concatBytes(
    new Uint8Array([0x4d, 0x4d, 0x00, 0x2a]), // "MM", 42
    uintBytes(8, 4), // offset of the first IFD
    uintBytes(1, 2), // one entry
    uintBytes(ORIENTATION, 2),
    uintBytes(3, 2), // SHORT
    uintBytes(1, 4),
    uintBytes(orientation, 2),
    uintBytes(0, 2),
    uintBytes(0, 4), // no next IFD
  );
}

/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */
import type { Item, Patch, SegmentType } from "./types.js";

const encoder = new TextEncoder();
export const ascii = (text: string) => encoder.encode(text);

export function checkPrefix(base: Uint8Array, prefix: Uint8Array): boolean {
  if (prefix.length > base.length) return false;

  for (let i = 0; i < prefix.length; i++) {
    if (base[i] !== prefix[i]) {
      return false;
    }
  }

  return true;
}

/** The four characters at `offset`, for matching chunk and box types. */
export function fourcc(bytes: Uint8Array, offset = 0): string {
  return String.fromCharCode(
    bytes[offset]!,
    bytes[offset + 1]!,
    bytes[offset + 2]!,
    bytes[offset + 3]!,
  );
}

/** Reads an unsigned integer of `length` bytes (exact up to 2^53). */
export function readUint(
  bytes: Uint8Array,
  offset: number,
  length: number,
  littleEndian = false,
): number {
  if (offset < 0 || offset + length > bytes.length) {
    throw new RangeError(
      `need ${length} bytes at offset ${offset}, have ${bytes.length}`,
    );
  }

  let value = 0;
  for (let i = 0; i < length; i++) {
    value = value * 256 + bytes[offset + (littleEndian ? length - 1 - i : i)]!;
  }
  return value;
}

export const readUint16BE = (b: Uint8Array, o: number) => readUint(b, o, 2);
export const readUint32BE = (b: Uint8Array, o: number) => readUint(b, o, 4);
export const readUint32LE = (b: Uint8Array, o: number) =>
  readUint(b, o, 4, true);

export function uintBytes(
  value: number,
  length: number,
  littleEndian = false,
): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[littleEndian ? i : length - 1 - i] = value % 256;
    value = Math.floor(value / 256);
  }
  return out;
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

const NOTHING = new Uint8Array(0);

/** A patch that removes the bytes, making the file shorter. */
export const cut = (
  kind: SegmentType,
  offset: number,
  length: number,
): Patch => ({ kind, offset, length, bytes: NOTHING });

/** A patch that overwrites the bytes with zeros, keeping the file size. */
export const blank = (
  kind: SegmentType,
  offset: number,
  length: number,
): Patch => ({ kind, offset, length, bytes: NOTHING, zeros: length });

/** Cuts every selected segment. */
export function cutAll(selected: Item[]): Patch[] {
  return selected.map((s) => cut(s.kind, s.offset, s.length));
}

/** Sorts [start, end) ranges and joins the ones that touch or overlap. */
export function mergeRanges(ranges: [number, number][]): [number, number][] {
  const merged: [number, number][] = [];
  for (const [start, end] of [...ranges].sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (last && start <= last[1]) {
      last[1] = Math.max(last[1], end);
    } else {
      merged.push([start, end]);
    }
  }
  return merged;
}

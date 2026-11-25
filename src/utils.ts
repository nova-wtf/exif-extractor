/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */
export function checkPrefix(
  base: Uint8Array<ArrayBufferLike>,
  prefix: Uint8Array<ArrayBufferLike>,
): boolean {
  if (prefix.length > base.length) return false;

  for (let i = 0; i < prefix.length; i++) {
    if (base[i] != prefix[i]) {
      return false;
    }
  }

  return true;
}

export function readUint32LE(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) {
    throw new Error(`need 4 bytes at offset ${offset}, have ${bytes.length}`);
  }

  return (
    (bytes[offset]! |
      (bytes[offset + 1]! << 8) |
      (bytes[offset + 2]! << 16) |
      (bytes[offset + 3]! << 24)) >>>
    0
  );
}

export function readUint32BE(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 4 > bytes.length) {
    throw new Error(`need 4 bytes at offset ${offset}, have ${bytes.length}`);
  }

  return (
    ((bytes[offset]! << 24) |
      (bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!) >>>
    0
  );
}

export function readUint16BE(bytes: Uint8Array, offset: number): number {
  if (offset < 0 || offset + 2 > bytes.length) {
    throw new Error(`need 2 bytes at offset ${offset}, have ${bytes.length}`);
  }

  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

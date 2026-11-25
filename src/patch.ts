/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */
import { CorruptFileError } from "./errors.js";
import type { Patch } from "./types.js";

// One shared block of zeros, so overwriting a huge range doesn't allocate it
const ZEROS = new Uint8Array(64 * 1024);

/**
 * Builds the output from slices of the input plus the replacement bytes.
 * Nothing from the input is read into memory.
 */
export function applyPatches(
  input: Blob,
  patches: Patch[],
  format: string,
): Blob {
  const parts: BlobPart[] = [];
  let currentOffset = 0;

  // Node 18 has no toSorted
  for (const patch of [...patches].sort((a, b) => a.offset - b.offset)) {
    if (patch.offset < currentOffset) {
      throw new CorruptFileError("overlapping structures", format, patch.offset);
    }

    if (input.size < patch.offset + patch.length) {
      throw new CorruptFileError("data past end of file", format, patch.offset);
    }

    if (patch.offset > currentOffset) {
      parts.push(input.slice(currentOffset, patch.offset));
    }
    if (patch.bytes.length > 0) {
      parts.push(patch.bytes);
    }
    for (let left = patch.zeros ?? 0; left > 0; left -= ZEROS.length) {
      parts.push(left >= ZEROS.length ? ZEROS : ZEROS.subarray(0, left));
    }

    currentOffset = patch.offset + patch.length;
  }

  parts.push(input.slice(currentOffset));

  return new Blob(parts, { type: input.type });
}

/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */
import type { Reader } from "./types.js";

function checkRange(offset: number, length: number): void {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new RangeError(`invalid offset: ${offset}`);
  }
  if (!Number.isInteger(length) || length < 0) {
    throw new RangeError(`invalid length: ${length}`);
  }
}

export function createReader(input: Blob | Uint8Array): Reader {
  if (input instanceof Uint8Array) {
    return {
      size: input.byteLength,
      async read(offset, length) {
        checkRange(offset, length);
        return input.subarray(offset, offset + length);
      },
    };
  }

  const size = input.size;
  return {
    size,
    async read(offset, length) {
      checkRange(offset, length);

      const end = Math.min(offset + length, size);
      if (offset >= end) {
        return new Uint8Array(0);
      }

      return new Uint8Array(await input.slice(offset, end).arrayBuffer());
    },
  };
}

/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */
import type { Reader } from "./types.js";

const MIN_WINDOW = 4 * 1024;
const MAX_WINDOW = 256 * 1024;

function checkRange(offset: number, length: number): void {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new RangeError(`invalid offset: ${offset}`);
  }
  if (!Number.isInteger(length) || length < 0) {
    throw new RangeError(`invalid length: ${length}`);
  }
}

/**
 * Reads from a Blob are served from a cached window, because every
 * `arrayBuffer()` call is expensive and parsers ask for a few bytes at a time.
 * The window grows while reads stay close together and shrinks after a long jump.
 */
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
  let start = 0;
  let cache = new Uint8Array(0);
  let window = MIN_WINDOW;

  const load = async (from: number, to: number) =>
    new Uint8Array(await input.slice(from, to).arrayBuffer());

  return {
    size,
    async read(offset, length) {
      checkRange(offset, length);

      const end = Math.min(offset + length, size);
      if (offset >= end) {
        return new Uint8Array(0);
      }

      const cacheEnd = start + cache.length;
      if (offset >= start && end <= cacheEnd) {
        return cache.subarray(offset - start, end - start);
      }

      if (end - offset >= MAX_WINDOW) {
        return load(offset, end);
      }

      const nearby = offset >= start && offset <= cacheEnd + window;
      window = nearby ? Math.min(window * 2, MAX_WINDOW) : MIN_WINDOW;

      cache = await load(offset, Math.min(size, Math.max(end, offset + window)));
      start = offset;
      return cache.subarray(0, end - offset);
    },
  };
}

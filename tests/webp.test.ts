/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */
import { describe, expect, test } from "vitest";
import { contains, makeWebp, strip, webpChunk } from "./helpers.ts";

describe("removeExif: WebP", () => {
  const EXIF_FLAG = 0x08;
  const XMP_FLAG = 0x04;
  const ICC_FLAG = 0x20;

  // VP8X chunk: 1 flags byte + 3 reserved + 6 bytes canvas size.
  const vp8x = (flags: number) =>
    webpChunk("VP8X", new Uint8Array([flags, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  const image = webpChunk("VP8 ", new Uint8Array(20));
  const exifChunk = webpChunk("EXIF", "MM\0*SECRET-GPS");
  const xmpChunk = webpChunk("XMP ", "<x>KEEP-XMP</x>");

  const riffSize = (b: Uint8Array) =>
    new DataView(b.buffer, b.byteOffset).getUint32(4, true);
  const vp8xFlags = (b: Uint8Array) => b[12 + 8]!; // first data byte of the first chunk

  test("removes the EXIF chunk and keeps XMP", async () => {
    const out = await strip(
      makeWebp(vp8x(EXIF_FLAG | XMP_FLAG), image, exifChunk, xmpChunk),
    );

    expect(contains(out, "SECRET-GPS")).toBe(false);
    expect(contains(out, "KEEP-XMP")).toBe(true);
  });

  test("updates the RIFF size to match the new file", async () => {
    const out = await strip(makeWebp(vp8x(EXIF_FLAG), image, exifChunk));

    // RIFF size must always be (file size − 8)
    expect(riffSize(out)).toBe(out.length - 8);
  });

  test("clears the EXIF flag in VP8X, keeps the other flags", async () => {
    const out = await strip(
      makeWebp(
        vp8x(EXIF_FLAG | XMP_FLAG | ICC_FLAG),
        image,
        exifChunk,
        xmpChunk,
      ),
    );

    expect(vp8xFlags(out) & EXIF_FLAG).toBe(0);
    expect(vp8xFlags(out) & XMP_FLAG).toBe(XMP_FLAG);
    expect(vp8xFlags(out) & ICC_FLAG).toBe(ICC_FLAG);
  });

  test("result is exactly the file you'd get if it never had EXIF", async () => {
    const out = await strip(makeWebp(vp8x(EXIF_FLAG), image, exifChunk));
    expect(out).toEqual(makeWebp(vp8x(0), image));
  });

  test("a WebP without EXIF comes back byte-for-byte the same", async () => {
    const input = makeWebp(vp8x(XMP_FLAG), image, xmpChunk);
    expect(await strip(input)).toEqual(input);
  });
});

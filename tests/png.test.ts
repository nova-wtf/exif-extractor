/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */
import { describe, expect, test } from "vitest";
import { contains, makePng, pngChunk, strip } from "./helpers";

describe("removeExif: PNG", () => {
  const idat = pngChunk("IDAT", new Uint8Array(30));
  const text = pngChunk("tEXt", "Author\0KEEP-AUTHOR");

  test("removes eXIf, keeps everything else", async () => {
    const out = await strip(
      makePng(pngChunk("eXIf", "MM\0*SECRET-GPS"), text, idat),
    );
    expect(out).toEqual(makePng(text, idat));
  });

  test("removes the old lowercase exIf chunk too", async () => {
    const out = await strip(makePng(pngChunk("exIf", "MM\0*SECRET-GPS"), idat));
    expect(contains(out, "SECRET-GPS")).toBe(false);
  });

  test("finds eXIf even when it comes after the image data", async () => {
    const out = await strip(makePng(idat, pngChunk("eXIf", "MM\0*SECRET-GPS")));
    expect(out).toEqual(makePng(idat));
  });
});

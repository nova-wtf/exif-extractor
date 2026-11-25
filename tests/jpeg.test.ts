/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */
import { describe, expect, test } from "vitest";
import {
  comment,
  contains,
  dqt,
  exif,
  icc,
  jfif,
  makeJpeg,
  strip,
  xmp,
} from "./helpers.ts";

describe("removeExif: JPEG", () => {
  test("result is exactly the file without the EXIF segment", async () => {
    const out = await strip(makeJpeg(jfif(), exif(), icc(), dqt()));
    expect(out).toEqual(makeJpeg(jfif(), icc(), dqt()));
  });

  test("leaves XMP, comments and ICC alone", async () => {
    const out = await strip(
      makeJpeg(exif(), xmp("KEEP-XMP"), comment("KEEP-COMMENT"), icc()),
    );

    expect(contains(out, "SECRET-GPS")).toBe(false);
    expect(contains(out, "KEEP-XMP")).toBe(true);
    expect(contains(out, "KEEP-COMMENT")).toBe(true);
    expect(contains(out, "ICC_PROFILE")).toBe(true);
  });

  test("removes several EXIF segments", async () => {
    const out = await strip(makeJpeg(exif("ONE"), dqt(), exif("TWO")));

    expect(contains(out, "ONE")).toBe(false);
    expect(contains(out, "TWO")).toBe(false);
  });

  test("a JPEG without EXIF comes back byte-for-byte the same", async () => {
    const input = makeJpeg(jfif(), xmp(), dqt());
    expect(await strip(input)).toEqual(input);
  });
});

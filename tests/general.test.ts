/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */
import { describe, expect, test } from "vitest";
import { removeExif } from "../src/index.ts";
import { blob, exif, makeJpeg } from "./helpers.ts";

describe("removeExif: general", () => {
  test("keeps the MIME type", async () => {
    const out = await removeExif(blob(makeJpeg(exif()), "image/jpeg"));
    expect(out.type).toBe("image/jpeg");
  });

  test("does not change the input", async () => {
    const input = makeJpeg(exif());
    const before = input.slice();
    await removeExif(blob(input, "image/jpeg"));
    expect(input).toEqual(before);
  });
});

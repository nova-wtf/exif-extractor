/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */

import { describe, expect, test } from "vitest";
import { isobmff } from "../src/formats/isobmff.ts";
import { removeExif, removeMetadata } from "../src/index.ts";
import { createReader } from "../src/reader.ts";
import { bytesOf, concat, contains } from "./helpers.ts";

const enc = new TextEncoder();

// Small MP4 builders

// One box: 4-byte big-endian size (incl. header) + type + content.
function box(type: string, ...content: (Uint8Array | string)[]): Uint8Array {
  const body = concat(
    ...content.map((c) => (typeof c === "string" ? enc.encode(c) : c)),
  );
  const head = new Uint8Array(8);
  new DataView(head.buffer).setUint32(0, 8 + body.length);
  head.set(enc.encode(type), 4);
  return concat(head, body);
}

// A box with a 64-bit size (size field = 1, real size in bytes 8–15).
function bigBox(type: string, content: Uint8Array): Uint8Array {
  const head = new Uint8Array(16);
  const view = new DataView(head.buffer);
  view.setUint32(0, 1);
  head.set(enc.encode(type), 4);
  view.setUint32(12, 16 + content.length); // high 4 bytes stay 0
  return concat(head, content);
}

// ftyp with the given major brand.
const ftyp = (brand = "isom") =>
  box("ftyp", brand, new Uint8Array(4), "isomiso2");

const XMP_UUID = new Uint8Array([
  0xbe, 0x7a, 0xcf, 0xcb, 0x97, 0xa9, 0x42, 0xe8, 0x9c, 0x71, 0x99, 0x94, 0x91,
  0xe3, 0xaf, 0xac,
]);

const mp4Blob = (bytes: Uint8Array) =>
  new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "video/mp4" });
const find = (bytes: Uint8Array) => isobmff.findSegments(createReader(bytes));
const typeAt = (bytes: Uint8Array, offset: number) =>
  String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));

// A typical phone video: moov at the end, metadata in moov, a track and at the top level.
function sampleMp4(): Uint8Array {
  return concat(
    ftyp("isom"),
    box("free"),
    box("mdat", new Uint8Array(200).fill(0xab)), // fake frames
    box(
      "moov",
      box("mvhd", new Uint8Array(100)),
      box("meta", "com.apple.quicktime.location.ISO6709 SECRET-APPLE-GPS"),
      box(
        "trak",
        box("tkhd", new Uint8Array(80)),
        box("mdia", new Uint8Array(60)),
        box("udta", "SECRET-TRACK"),
      ),
      box("udta", "©xyz SECRET-GPS +52.3676+004.9041/"),
    ),
    box("uuid", XMP_UUID, "<x>SECRET-XMP</x>"),
  );
}

function walkAll(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const seen: string[] = [];

  function walk(start: number, end: number) {
    let pos = start;
    while (pos < end) {
      const size = view.getUint32(pos);
      const type = typeAt(bytes, pos);
      if (size < 8 || pos + size > end)
        throw new Error(`box ${type} at ${pos} has a bad size`);
      seen.push(type);
      if (type === "moov" || type === "trak") walk(pos + 8, pos + size);
      pos += size;
    }
    if (pos !== end) throw new Error(`boxes don't end exactly at ${end}`);
  }

  walk(0, bytes.length);
  return seen;
}

// detect

describe("ISOBMFF: detect", () => {
  test("accepts MP4, MOV and 3GP", () => {
    for (const brand of ["isom", "mp42", "qt  ", "3gp4"]) {
      expect(isobmff.detect(ftyp(brand))).toBe(true);
    }
  });

  test("rejects HEIC / AVIF / CR3 (their meta box is the image itself)", () => {
    for (const brand of [
      "heic",
      "heix",
      "mif1",
      "msf1",
      "avif",
      "avis",
      "crx ",
    ]) {
      expect(isobmff.detect(ftyp(brand))).toBe(false);
    }
  });

  test("rejects files without ftyp at bytes 4–7", () => {
    expect(isobmff.detect(new Uint8Array(16))).toBe(false);
  });
});

// findSegments

describe("ISOBMFF: findSegments", () => {
  test("finds meta/udta in moov and trak, and the XMP uuid", async () => {
    const file = sampleMp4();
    const found = await find(file);

    expect(found.map((s) => typeAt(file, s.offset))).toEqual([
      "meta",
      "udta",
      "udta",
      "uuid",
    ]);
    expect(found.map((s) => s.kind)).toEqual([
      "comment",
      "comment",
      "comment",
      "xmp",
    ]);
  });

  test("a segment covers the whole box", async () => {
    const file = concat(ftyp(), box("moov", box("udta", "abc")));
    const [seg] = await find(file);

    // ftyp + moov header (8) → udta starts there and runs to the end of the file
    expect(seg!.offset).toBe(ftyp().length + 8);
    expect(seg!.offset + seg!.length).toBe(file.length);
  });

  test("works with moov before mdat (fast start)", async () => {
    const file = concat(
      ftyp(),
      box("moov", box("udta", "x")),
      box("mdat", new Uint8Array(50)),
    );
    expect((await find(file)).length).toBe(1);
  });

  test("handles a 64-bit box size (size = 1)", async () => {
    const file = concat(
      ftyp(),
      bigBox("mdat", new Uint8Array(50)),
      box("moov", box("udta", "x")),
    );
    expect((await find(file)).length).toBe(1);
  });

  test("handles size 0 (box runs to the end of the file)", async () => {
    const lastMdat = concat(
      new Uint8Array([0, 0, 0, 0]),
      enc.encode("mdat"),
      new Uint8Array(30),
    );
    const file = concat(ftyp(), box("moov", box("udta", "x")), lastMdat);
    expect((await find(file)).length).toBe(1);
  });

  test("keeps uuid boxes that aren't XMP", async () => {
    const otherUuid = new Uint8Array(16).fill(0x11);
    const file = concat(ftyp(), box("uuid", otherUuid, "vendor stuff"));
    expect(await find(file)).toEqual([]);
  });

  test("doesn't look inside mdat", async () => {
    const file = concat(ftyp(), box("mdat", box("udta", "inside frames")));
    expect(await find(file)).toEqual([]);
  });

  test("throws for a truncated file", async () => {
    const file = sampleMp4().subarray(0, 100);
    await expect(find(file)).rejects.toThrow();
  });

  test("throws for a box smaller than its own header", async () => {
    const file = concat(
      ftyp(),
      new Uint8Array([0, 0, 0, 4]),
      enc.encode("moov"),
    );
    await expect(find(file)).rejects.toThrow();
  });
});

// removeMetadata / removeExif

describe("ISOBMFF: removeMetadata", () => {
  test("removes GPS, Apple metadata, track metadata and XMP", async () => {
    const out = await bytesOf(await removeMetadata(mp4Blob(sampleMp4())));

    for (const secret of [
      "SECRET-GPS",
      "SECRET-APPLE-GPS",
      "SECRET-TRACK",
      "SECRET-XMP",
    ]) {
      expect(contains(out, secret)).toBe(false);
    }
  });

  test("keeps the file exactly the same size", async () => {
    const input = sampleMp4();
    const out = await bytesOf(await removeMetadata(mp4Blob(input)));

    expect(out.length).toBe(input.length);
  });

  test("replaces each removed box with free, everything else stays in place", async () => {
    const out = await bytesOf(await removeMetadata(mp4Blob(sampleMp4())));

    expect(walkAll(out)).toEqual([
      "ftyp",
      "free",
      "mdat",
      "moov",
      "mvhd",
      "free", // was meta
      "trak",
      "tkhd",
      "mdia",
      "free", // was trak/udta
      "free", // was moov/udta
      "free", // was the XMP uuid
    ]);
  });

  test("leaves the video frames byte-for-byte untouched", async () => {
    const input = sampleMp4();
    const out = await bytesOf(await removeMetadata(mp4Blob(input)));

    const mdatStart = ftyp().length + 8; // after ftyp and the empty free box
    const mdatEnd = mdatStart + 8 + 200;
    expect(out.subarray(mdatStart, mdatEnd)).toEqual(
      input.subarray(mdatStart, mdatEnd),
    );
  });

  test("a file with nothing to remove comes back unchanged", async () => {
    const input = concat(
      ftyp(),
      box("mdat", new Uint8Array(40)),
      box("moov", box("mvhd", new Uint8Array(100))),
    );
    const out = await bytesOf(await removeMetadata(mp4Blob(input)));

    expect(out).toEqual(input);
  });

  test("running it twice gives the same result", async () => {
    const once = await removeMetadata(mp4Blob(sampleMp4()));
    const twice = await bytesOf(await removeMetadata(once));

    expect(twice).toEqual(await bytesOf(once));
  });
});

describe("ISOBMFF: removeExif", () => {
  test("MP4 has no EXIF, so nothing changes", async () => {
    const input = sampleMp4();
    const out = await bytesOf(await removeExif(mp4Blob(input)));

    expect(out).toEqual(input);
  });
});

/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */
import { describe, expect, test } from "vitest";
import { removeExif, removeMetadata } from "../src/index.ts";
import { bytesOf, concat, contains } from "./helpers.ts";

const enc = new TextEncoder();

// Small AVI builders

// One RIFF chunk: fourcc + 4-byte little-endian size + data (+ padding byte if size is odd).
function chunk(
  fourcc: string,
  data: Uint8Array | string = new Uint8Array(0),
): Uint8Array {
  const body = typeof data === "string" ? enc.encode(data) : data;
  const out = new Uint8Array(8 + body.length + (body.length % 2));
  out.set(enc.encode(fourcc), 0);
  new DataView(out.buffer).setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}

// LIST chunk: "LIST" + size + list type + children.
const list = (type: string, ...children: Uint8Array[]) =>
  chunk("LIST", concat(enc.encode(type), ...children));

// RIFF block: "RIFF" + size + form type ("AVI " or "AVIX") + chunks.
function riff(form: string, ...chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const body = concat(enc.encode(form), ...chunks);
  const head = new Uint8Array(8);
  head.set(enc.encode("RIFF"), 0);
  new DataView(head.buffer).setUint32(4, body.length, true);
  return concat(head, body);
}

const aviBlob = (bytes: Uint8Array<ArrayBuffer>) =>
  new Blob([bytes], { type: "video/x-msvideo" });

// A typical small AVI with metadata in every place the handler looks.
function sampleAvi() {
  return riff(
    "AVI ",
    list(
      "hdrl",
      chunk("avih", new Uint8Array(56)),
      list(
        "strl",
        chunk("strh", new Uint8Array(56)),
        chunk("strf", new Uint8Array(40)),
        chunk("strd", "SECRET-SERIAL"),
        chunk("strn", "SECRET-NAME"), // odd size → has a padding byte
      ),
    ),
    list(
      "INFO",
      chunk("IART", "SECRET-AUTHOR"),
      chunk("ISFT", "SECRET-SOFTWARE"),
    ),
    chunk("_PMX", "<x>SECRET-XMP</x>"),
    list("movi", chunk("00dc", new Uint8Array(100))),
    chunk("idx1", new Uint8Array(16)),
  );
}

/**
 * Walks every chunk in the file (into every LIST) and checks the structure is valid:
 * chunks tile each LIST exactly, and the RIFF size matches the file.
 * Returns the fourccs it saw, in order.
 */
function walkAll(bytes: Uint8Array): string[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const seen: string[] = [];
  const fourcc = (o: number) =>
    String.fromCharCode(...bytes.subarray(o, o + 4));

  function walk(start: number, end: number) {
    let pos = start;
    while (pos < end) {
      const type = fourcc(pos);
      const size = view.getUint32(pos + 4, true);
      const next = pos + 8 + size + (size % 2);
      if (next > end)
        throw new Error(`chunk ${type} at ${pos} runs past its parent`);
      seen.push(type === "LIST" ? `LIST ${fourcc(pos + 8)}` : type);
      if (type === "LIST") walk(pos + 12, pos + 8 + size);
      pos = next;
    }
    if (pos !== end) throw new Error(`chunks don't end exactly at ${end}`);
  }

  if (view.getUint32(4, true) !== bytes.length - 8)
    throw new Error("RIFF size doesn't match the file");
  walk(12, bytes.length);
  return seen;
}

// Tests

describe("AVI: removeMetadata", () => {
  test("removes INFO, XMP, stream data and stream names", async () => {
    const out = await bytesOf(await removeMetadata(aviBlob(sampleAvi())));

    for (const secret of [
      "SECRET-SERIAL",
      "SECRET-NAME",
      "SECRET-AUTHOR",
      "SECRET-SOFTWARE",
      "SECRET-XMP",
    ]) {
      expect(contains(out, secret)).toBe(false);
    }
  });

  test("keeps the file exactly the same size", async () => {
    const input = sampleAvi();
    const out = await bytesOf(await removeMetadata(aviBlob(input)));

    expect(out.length).toBe(input.length);
  });

  test("replaces each removed chunk with JUNK, everything else stays in place", async () => {
    const out = await bytesOf(await removeMetadata(aviBlob(sampleAvi())));

    expect(walkAll(out)).toEqual([
      "LIST hdrl",
      "avih",
      "LIST strl",
      "strh",
      "strf",
      "JUNK", // was strd
      "JUNK", // was strn
      "JUNK", // was LIST INFO (its children are gone too)
      "JUNK", // was _PMX
      "LIST movi",
      "00dc",
      "idx1",
    ]);
  });

  test("leaves the video headers and frames byte-for-byte untouched", async () => {
    const input = sampleAvi();
    const out = await bytesOf(await removeMetadata(aviBlob(input)));

    // Everything before the first removed chunk (strd) is identical…
    const strdAt = findBytes(input, enc.encode("strd"));
    expect(out.subarray(0, strdAt)).toEqual(input.subarray(0, strdAt));

    // …and so is everything from the frames (LIST movi) to the end.
    const moviAt = findBytes(input, enc.encode("movi")) - 8; // the LIST header starts 8 bytes earlier
    expect(out.subarray(moviAt)).toEqual(input.subarray(moviAt));
  });

  test("a file with nothing to remove comes back unchanged", async () => {
    const input = riff(
      "AVI ",
      list("hdrl", chunk("avih", new Uint8Array(56))),
      list("movi", chunk("00dc", new Uint8Array(20))),
    );
    const out = await bytesOf(await removeMetadata(aviBlob(input)));

    expect(out).toEqual(input);
  });

  test("also cleans RIFF AVIX blocks (files > 1 GB)", async () => {
    const input = concat(
      sampleAvi(),
      riff(
        "AVIX",
        chunk("_PMX", "<x>SECOND-XMP</x>"),
        list("movi", chunk("00dc", new Uint8Array(20))),
      ),
    );
    const out = await bytesOf(await removeMetadata(aviBlob(input)));

    expect(contains(out, "SECOND-XMP")).toBe(false);
    expect(out.length).toBe(input.length);
  });

  test("running it twice gives the same result", async () => {
    const once = await removeMetadata(aviBlob(sampleAvi()));
    const twice = await bytesOf(await removeMetadata(once));

    expect(twice).toEqual(await bytesOf(once));
  });
});

describe("AVI: removeExif", () => {
  test("AVI has no EXIF, so nothing changes", async () => {
    const input = sampleAvi();
    const out = await bytesOf(await removeExif(aviBlob(input)));

    expect(out).toEqual(input);
  });
});

function findBytes(haystack: Uint8Array, needle: Uint8Array): number {
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++)
      if (haystack[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

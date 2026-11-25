/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */

import { describe, expect, test } from "vitest";
import { ebml } from "../src/formats/ebml.ts";
import { removeExif, removeMetadata } from "../src/index.ts";
import { createReader } from "../src/reader.ts";
import { bytesOf, concat, contains } from "./helpers.ts";

const enc = new TextEncoder();

// Small EBML builders

// Encodes a size as a VINT: 1 byte when it fits (≤ 126), otherwise 8 bytes.
function vint(size: number): Uint8Array {
  if (size <= 126) return new Uint8Array([0x80 | size]);
  const out = new Uint8Array(8);
  out[0] = 0x01;
  let n = size;
  for (let i = 7; i >= 1; i--) {
    out[i] = n % 256;
    n = Math.floor(n / 256);
  }
  return out;
}

// One element: ID bytes + size VINT + data.
function el(id: number[], ...data: (Uint8Array | string)[]): Uint8Array {
  const body = concat(
    ...data.map((d) => (typeof d === "string" ? enc.encode(d) : d)),
  );
  return concat(new Uint8Array(id), vint(body.length), body);
}

// Same, but with an "unknown size" (8 bytes of 01 FF FF …), like live recordings write.
function elUnknown(id: number[], ...data: Uint8Array[]): Uint8Array {
  return concat(
    new Uint8Array(id),
    new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]),
    ...data,
  );
}

const ID = {
  EBML: [0x1a, 0x45, 0xdf, 0xa3],
  Segment: [0x18, 0x53, 0x80, 0x67],
  SeekHead: [0x11, 0x4d, 0x9b, 0x74],
  Info: [0x15, 0x49, 0xa9, 0x66],
  TimestampScale: [0x2a, 0xd7, 0xb1],
  MuxingApp: [0x4d, 0x80],
  WritingApp: [0x57, 0x41],
  DateUTC: [0x44, 0x61],
  Title: [0x7b, 0xa9],
  SegmentUUID: [0x73, 0xa4],
  Tracks: [0x16, 0x54, 0xae, 0x6b],
  TrackEntry: [0xae],
  TrackNumber: [0xd7],
  Name: [0x53, 0x6e],
  CodecID: [0x86],
  Tags: [0x12, 0x54, 0xc3, 0x67],
  Cluster: [0x1f, 0x43, 0xb6, 0x75],
  Cues: [0x1c, 0x53, 0xbb, 0x6b],
  Void: [0xec],
};

// The EBML header, the way ffmpeg writes it.
function ebmlHeader(docType = "webm"): Uint8Array {
  return el(
    ID.EBML,
    el([0x42, 0x86], new Uint8Array([1])),
    el([0x42, 0xf7], new Uint8Array([1])),
    el([0x42, 0xf2], new Uint8Array([4])),
    el([0x42, 0xf3], new Uint8Array([8])),
    el([0x42, 0x82], docType),
    el([0x42, 0x87], new Uint8Array([4])),
    el([0x42, 0x85], new Uint8Array([2])),
  );
}

const info = (title = "SECRET-TITLE") =>
  el(
    ID.Info,
    el(ID.TimestampScale, new Uint8Array([0x0f, 0x42, 0x40])),
    el(ID.MuxingApp, "Lavf60.16.100"),
    el(ID.WritingApp, "Lavf60.16.100"),
    el(ID.DateUTC, "SECRDATE"), // 8 bytes, like a real date
    el(ID.Title, title),
    el(ID.SegmentUUID, "SECRET-UUID-1234"), // 16 bytes, like a real UUID
  );

const tracks = () =>
  el(
    ID.Tracks,
    el(
      ID.TrackEntry,
      el(ID.TrackNumber, new Uint8Array([1])),
      el(ID.Name, "SECRET-TRACK"),
      el(ID.CodecID, "V_VP9"),
    ),
  );

const tags = (text = "SECRET-TAGS") =>
  el(
    ID.Tags,
    el(
      [0x73, 0x73],
      el([0x67, 0xc8], el([0x45, 0xa3], "LOCATION"), el([0x44, 0x87], text)),
    ),
  );
const cluster = () =>
  el(
    ID.Cluster,
    el([0xe7], new Uint8Array([0])),
    el([0xa3], new Uint8Array(60).fill(0xab)),
  );
const seekHead = () => el(ID.SeekHead, new Uint8Array(20));
const cues = () => el(ID.Cues, new Uint8Array(12));

// A typical WebM: header + one Segment with metadata in Info, Tracks and Tags.
function sampleWebm(docType = "webm"): Uint8Array {
  return concat(
    ebmlHeader(docType),
    el(ID.Segment, seekHead(), info(), tracks(), tags(), cluster(), cues()),
  );
}

const webmBlob = (bytes: Uint8Array) =>
  new Blob([bytes as Uint8Array<ArrayBuffer>], { type: "video/webm" });
const find = (bytes: Uint8Array) => ebml.findSegments(createReader(bytes));

// A small independent walker, to check the structure after stripping

const MASTERS = new Set(["18538067", "1549a966", "1654ae6b", "ae"]); // Segment, Info, Tracks, TrackEntry
const hex = (b: Uint8Array) =>
  [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

function vintLen(first: number): number {
  for (let i = 0; i < 8; i++) if (first & (0x80 >> i)) return i + 1;
  throw new Error("bad VINT");
}

function vintValue(b: Uint8Array, o: number): number {
  const len = vintLen(b[o]!);
  let v = b[o]! & (0xff >> len);
  for (let i = 1; i < len; i++) v = v * 256 + b[o + i]!;
  return v;
}

// Walks every element after the EBML header (into Segment, Info, Tracks, TrackEntry); returns their IDs in hex.
function walkAll(bytes: Uint8Array): string[] {
  const seen: string[] = [];
  const headerEnd = 5 + (bytes[4]! & 0x7f);

  function walk(start: number, end: number) {
    let pos = start;
    while (pos < end) {
      const idLen = vintLen(bytes[pos]!);
      const id = hex(bytes.subarray(pos, pos + idLen));
      const sizeLen = vintLen(bytes[pos + idLen]!);
      const size = vintValue(bytes, pos + idLen);
      const next = pos + idLen + sizeLen + size;
      if (next > end)
        throw new Error(`element ${id} at ${pos} runs past its parent`);
      seen.push(id);
      if (MASTERS.has(id)) walk(pos + idLen + sizeLen, next);
      pos = next;
    }
    if (pos !== end) throw new Error(`elements don't end exactly at ${end}`);
  }

  walk(headerEnd, bytes.length);
  return seen;
}

// detect / DocType

describe("EBML: detect", () => {
  test("accepts files starting with the EBML ID", () => {
    expect(ebml.detect(sampleWebm())).toBe(true);
    expect(ebml.detect(sampleWebm("matroska"))).toBe(true);
  });

  test("rejects other files", () => {
    expect(
      ebml.detect(
        new Uint8Array([0x00, 0x00, 0x00, 0x20, 0x66, 0x74, 0x79, 0x70]),
      ),
    ).toBe(false);
  });

  test("throws for an EBML file that isn't WebM or MKV", async () => {
    await expect(find(sampleWebm("other"))).rejects.toThrow();
  });
});

// findSegments

describe("EBML: findSegments", () => {
  test("finds DateUTC, Title, SegmentUUID, track Name and Tags", async () => {
    const file = sampleWebm();
    const found = await find(file);

    const ids = found.map((s) =>
      hex(
        file.subarray(s.offset, s.offset + (file[s.offset]! >= 0x40 ? 2 : 4)),
      ),
    );
    expect(ids).toEqual(["4461", "7ba9", "73a4", "536e", "1254c367"]);
    expect(found.map((s) => s.kind)).toEqual([
      "other",
      "comment",
      "other",
      "comment",
      "comment",
    ]);
  });

  test("works for MKV (DocType matroska)", async () => {
    expect((await find(sampleWebm("matroska"))).length).toBe(5);
  });

  test("each segment covers the whole element (ID + size + data)", async () => {
    const file = concat(
      ebmlHeader(),
      el(ID.Segment, el(ID.Info, el(ID.Title, "abc"))),
    );
    const [title] = await find(file);

    // Title is the last element in the file: 2 ID + 1 size + 3 data
    expect(title!.length).toBe(6);
    expect(title!.offset + title!.length).toBe(file.length);
    expect(
      new TextDecoder().decode(
        file.subarray(
          title!.dataOffset!,
          title!.dataOffset! + title!.dataLength!,
        ),
      ),
    ).toBe("abc");
  });

  test("keeps MuxingApp, WritingApp, TimestampScale and the frames", async () => {
    const file = sampleWebm();
    const found = await find(file);
    const covered = (text: string) =>
      found.some((s) =>
        contains(file.subarray(s.offset, s.offset + s.length), text),
      );

    expect(covered("Lavf60")).toBe(false);
  });

  test("finds metadata in every Segment of a file with two", async () => {
    const file = concat(
      ebmlHeader(),
      el(ID.Segment, info("ONE"), tracks()),
      el(ID.Segment, info("TWO"), tags()),
    );
    const kinds = (await find(file)).map((s) => s.kind);

    expect(kinds.length).toBe(4 + 4); // 3 Info + Name, then 3 Info + Tags
  });

  test("live recording: steps into an unknown-size Segment, stops at an unknown-size Cluster", async () => {
    const file = concat(
      ebmlHeader(),
      elUnknown(
        ID.Segment,
        info(),
        tracks(),
        elUnknown(ID.Cluster, new Uint8Array(50)),
      ),
    );
    const found = await find(file);

    expect(found.map((s) => s.kind)).toEqual([
      "other",
      "comment",
      "other",
      "comment",
    ]);
  });

  test("a Tags block larger than 126 bytes (8-byte size)", async () => {
    const file = concat(ebmlHeader(), el(ID.Segment, tags("X".repeat(300))));
    const [t] = await find(file);

    expect(t!.offset + t!.length).toBe(file.length);
  });

  test("throws for a truncated file", async () => {
    const file = sampleWebm().subarray(0, 80);
    await expect(find(file)).rejects.toThrow();
  });
});

// removeMetadata / removeExif

describe("EBML: removeMetadata", () => {
  test("removes title, date, UUID, track name and tags", async () => {
    const out = await bytesOf(await removeMetadata(webmBlob(sampleWebm())));

    for (const secret of [
      "SECRDATE",
      "SECRET-TITLE",
      "SECRET-UUID",
      "SECRET-TRACK",
      "SECRET-TAGS",
      "LOCATION",
    ]) {
      expect(contains(out, secret)).toBe(false);
    }
  });

  test("keeps the file exactly the same size", async () => {
    const input = sampleWebm();
    const out = await bytesOf(await removeMetadata(webmBlob(input)));

    expect(out.length).toBe(input.length);
  });

  test("replaces each removed element with Void, everything else stays in place", async () => {
    const out = await bytesOf(await removeMetadata(webmBlob(sampleWebm())));

    expect(walkAll(out)).toEqual([
      "18538067", // Segment
      "114d9b74", // SeekHead
      "1549a966", // Info
      "2ad7b1", //   TimestampScale
      "4d80", //     MuxingApp
      "5741", //     WritingApp
      "ec", //       Void (was DateUTC)
      "ec", //       Void (was Title)
      "ec", //       Void (was SegmentUUID)
      "1654ae6b", // Tracks
      "ae", //       TrackEntry
      "d7", //         TrackNumber
      "ec", //         Void (was Name)
      "86", //         CodecID
      "ec", //       Void (was Tags)
      "1f43b675", // Cluster
      "1c53bb6b", // Cues
    ]);
  });

  test("a large Tags block becomes one Void with an 8-byte size", async () => {
    const input = concat(
      ebmlHeader(),
      el(ID.Segment, tags("X".repeat(300)), cluster()),
    );
    const out = await bytesOf(await removeMetadata(webmBlob(input)));

    expect(out.length).toBe(input.length);
    expect(walkAll(out)).toEqual(["18538067", "ec", "1f43b675"]);
  });

  test("leaves the frames byte-for-byte untouched", async () => {
    const input = sampleWebm();
    const out = await bytesOf(await removeMetadata(webmBlob(input)));

    const clusterBytes = cluster();
    const at = input.length - cues().length - clusterBytes.length;
    expect(out.subarray(at, at + clusterBytes.length)).toEqual(clusterBytes);
  });

  test("a file with nothing to remove comes back unchanged", async () => {
    const input = concat(
      ebmlHeader(),
      el(
        ID.Segment,
        seekHead(),
        el(ID.Info, el(ID.TimestampScale, new Uint8Array([1]))),
        cluster(),
      ),
    );
    const out = await bytesOf(await removeMetadata(webmBlob(input)));

    expect(out).toEqual(input);
  });

  test("running it twice gives the same result", async () => {
    const once = await removeMetadata(webmBlob(sampleWebm()));
    const twice = await bytesOf(await removeMetadata(once));

    expect(twice).toEqual(await bytesOf(once));
  });
});

describe("EBML: removeExif", () => {
  test("WebM has no EXIF, so nothing changes", async () => {
    const input = sampleWebm();
    const out = await bytesOf(await removeExif(webmBlob(input)));

    expect(out).toEqual(input);
  });
});

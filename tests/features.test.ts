/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */
import { describe, expect, test } from "vitest";
import {
  CorruptFileError,
  inspect,
  removeExif,
  removeMetadata,
  UnsupportedFormatError,
} from "../src/index.ts";
import { createReader } from "../src/reader.ts";
import {
  bytesOf,
  comment,
  concat,
  contains,
  exif,
  jpegSegment,
  makeJpeg,
  makePng,
  makeWebp,
  PNG_SIGNATURE,
  pngChunk,
  webpChunk,
} from "./helpers.ts";

const enc = new TextEncoder();
const blobOf = (bytes: Uint8Array) =>
  new Blob([bytes as Uint8Array<ArrayBuffer>]);
const clean = async (bytes: Uint8Array) =>
  bytesOf(await removeMetadata(blobOf(bytes)));

function u(value: number, length: number, le = false): Uint8Array {
  const out = new Uint8Array(length);
  for (let i = 0; i < length; i++) {
    out[le ? i : length - 1 - i] = value % 256;
    value = Math.floor(value / 256);
  }
  return out;
}

// A little-endian EXIF block with an orientation tag followed by a secret.
const orientedTiff = (orientation: number) =>
  concat(
    enc.encode("II"),
    u(42, 2, true),
    u(8, 4, true),
    u(1, 2, true),
    u(0x0112, 2, true),
    u(3, 2, true),
    u(1, 4, true),
    u(orientation, 4, true),
    u(0, 4, true),
    enc.encode("SECRET-GPS"),
  );

const orientedExif = (orientation: number) =>
  jpegSegment(
    0xe1,
    concat(enc.encode("Exif\0\0"), orientedTiff(orientation)),
  );

describe("errors", () => {
  test("unknown formats throw UnsupportedFormatError", async () => {
    await expect(
      removeMetadata(blobOf(enc.encode("PK\x03\x04 not an image"))),
    ).rejects.toBeInstanceOf(UnsupportedFormatError);
    await expect(removeMetadata(new Blob([]))).rejects.toBeInstanceOf(
      UnsupportedFormatError,
    );
  });

  test("broken files throw CorruptFileError", async () => {
    const broken = concat(PNG_SIGNATURE, u(999, 4), enc.encode("tEXt"));
    await expect(removeMetadata(blobOf(broken))).rejects.toBeInstanceOf(
      CorruptFileError,
    );
  });

  test("random damage never throws anything else", async () => {
    const samples = [
      makeJpeg(orientedExif(6), comment()),
      makePng(pngChunk("eXIf", orientedTiff(6)), pngChunk("tEXt", "a\0b")),
      makeWebp(webpChunk("VP8X", new Uint8Array(10)), webpChunk("EXIF", "x")),
    ];
    let seed = 1;
    const random = (n: number) => (seed = (seed * 48271) % 2147483647) % n;

    for (const sample of samples) {
      for (let i = 0; i < 500; i++) {
        const damaged = sample.slice(0, 12 + random(sample.length));
        damaged[random(damaged.length)] = random(256);
        try {
          await removeMetadata(blobOf(damaged));
        } catch (e) {
          expect(
            e instanceof CorruptFileError ||
              e instanceof UnsupportedFormatError,
          ).toBe(true);
        }
      }
    }
  });
});

describe("orientation", () => {
  test("JPEG keeps the orientation and nothing else", async () => {
    const out = await clean(makeJpeg(orientedExif(6)));

    expect(contains(out, "SECRET-GPS")).toBe(false);
    expect(contains(out, "Exif\0\0MM")).toBe(true);
    expect(await clean(out)).toEqual(out);
  });

  test("can be turned off", async () => {
    const out = await bytesOf(
      await removeExif(blobOf(makeJpeg(orientedExif(6))), {
        keepOrientation: false,
      }),
    );
    expect(out).toEqual(makeJpeg());
  });

  test("upright photos get no EXIF at all", async () => {
    expect(await clean(makeJpeg(orientedExif(1)))).toEqual(makeJpeg());
  });

  test("PNG gets a small eXIf chunk", async () => {
    const out = await clean(makePng(pngChunk("eXIf", orientedTiff(8))));
    const { segments } = await inspect(blobOf(out));

    expect(contains(out, "SECRET-GPS")).toBe(false);
    expect(segments).toMatchObject([{ kind: "exif", dataLength: 26 }]);
  });

  test("WebP keeps the VP8X EXIF flag and a correct size", async () => {
    const vp8x = webpChunk("VP8X", new Uint8Array([8, 0, 0, 0, 0, 0, 0, 0]));
    const out = await clean(
      makeWebp(vp8x, webpChunk("EXIF", orientedTiff(3))),
    );

    expect(contains(out, "SECRET-GPS")).toBe(false);
    expect(out[20]).toBe(8);
    expect(new DataView(out.buffer).getUint32(4, true)).toBe(out.length - 8);
  });
});

describe("JPEG after the first image", () => {
  test("removes a motion photo video", async () => {
    const input = concat(makeJpeg(), enc.encode("....ftypmp42 SECRET-VIDEO"));
    expect(await clean(input)).toEqual(makeJpeg());
  });

  test("cleans following images", async () => {
    const input = concat(makeJpeg(exif()), makeJpeg(comment()));
    expect(await clean(input)).toEqual(concat(makeJpeg(), makeJpeg()));
  });

  test("finds metadata between progressive scans", async () => {
    const input = concat(
      makeJpeg().subarray(0, -2), // everything but EOI
      comment(),
      jpegSegment(0xda, new Uint8Array(4)),
      new Uint8Array([9, 0xff, 0x00, 0xff, 0xd0, 9, 0xff, 0xd9]),
    );
    const out = await clean(input);

    expect(contains(out, "SECRET-COMMENT")).toBe(false);
    expect(out.length).toBe(input.length - comment().length);
  });

  test("updates the MPF index when images move", async () => {
    const second = makeJpeg(exif("SECOND"));
    const mpf = (size1: number, size2: number, offset2: number) =>
      jpegSegment(
        0xe2,
        concat(
          enc.encode("MPF\0"),
          enc.encode("MM"),
          u(42, 2),
          u(8, 4),
          u(1, 2),
          u(0xb002, 2),
          u(7, 2),
          u(32, 4),
          u(26, 4),
          u(0, 4),
          u(0, 4),
          u(size1, 4),
          u(0, 4),
          u(0, 4),
          u(0, 4),
          u(size2, 4),
          u(offset2, 4),
          u(0, 4),
        ),
      );
    // SOI, EXIF, then the MPF segment whose offsets start 8 bytes into it
    const build = (head: Uint8Array[], tail: Uint8Array) => {
      const length = makeJpeg(...head, mpf(0, 0, 0)).length;
      const base = 2 + head.reduce((n, p) => n + p.length, 0) + 8;
      return concat(
        makeJpeg(...head, mpf(length, tail.length, length - base)),
        tail,
      );
    };

    const out = await clean(build([exif()], second));
    expect(out).toEqual(build([], makeJpeg()));
  });
});

describe("PNG and WebP extras", () => {
  test("removes unknown ancillary chunks and keeps critical ones", async () => {
    const input = makePng(
      pngChunk("prIv", "SECRET"),
      pngChunk("CgBI", "keep"),
      pngChunk("gAMA", "keep"),
    );
    expect(await clean(input)).toEqual(
      makePng(pngChunk("CgBI", "keep"), pngChunk("gAMA", "keep")),
    );
  });

  test("removes data after the end of the image", async () => {
    const tail = enc.encode("SECRET-TRAILER");
    expect(await clean(concat(makePng(), tail))).toEqual(makePng());

    const image = webpChunk("VP8 ", new Uint8Array(4));
    expect(await clean(concat(makeWebp(image), tail))).toEqual(
      makeWebp(image),
    );
  });
});

describe("GIF", () => {
  const screen = concat(enc.encode("GIF89a"), new Uint8Array([1, 0, 1, 0]), u(0, 3));
  const block = (text: string) =>
    concat(new Uint8Array([text.length]), enc.encode(text));
  const extension = (label: number, ...blocks: string[]) =>
    concat(
      new Uint8Array([0x21, label]),
      ...blocks.map(block),
      new Uint8Array([0]),
    );
  const loop = extension(0xff, "NETSCAPE2.0", "\x01\x00\x00");
  const image = new Uint8Array([
    0x2c, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 0x44, 0x01, 0,
  ]);
  const end = new Uint8Array([0x3b]);

  test("removes comments, XMP and trailing data, keeps looping", async () => {
    const input = concat(
      screen,
      loop,
      extension(0xfe, "SECRET-COMMENT"),
      extension(0xff, "XMP DataXMP", "SECRET-XMP"),
      image,
      end,
      enc.encode("SECRET-TAIL"),
    );
    expect((await inspect(blobOf(input))).segments.map((s) => s.kind)).toEqual([
      "comment",
      "xmp",
      "other",
    ]);
    expect(await clean(input)).toEqual(concat(screen, loop, image, end));
  });

  test("throws for a truncated file", async () => {
    await expect(clean(concat(screen, image))).rejects.toBeInstanceOf(
      CorruptFileError,
    );
  });
});

describe("TIFF", () => {
  // Header, one directory (width, Make, GPS pointer), the Make string, the GPS IFD
  const entry = (tag: number, type: number, count: number, value: number) =>
    concat(
      u(tag, 2, true),
      u(type, 2, true),
      u(count, 4, true),
      u(value, 4, true),
    );
  const sample = (...extra: Uint8Array[]) =>
    concat(
      enc.encode("II"),
      u(42, 2, true),
      u(8, 4, true),
      u(3 + extra.length, 2, true),
      entry(256, 3, 1, 640),
      entry(271, 2, 12, 100),
      entry(34853, 4, 1, 112),
      ...extra,
      u(0, 4, true),
      new Uint8Array(100 - 8 - 2 - 36 - extra.length * 12 - 4),
      enc.encode("SECRET-MAKE\0"),
      u(1, 2, true),
      entry(1, 2, 12, 130),
      u(0, 4, true),
      enc.encode("SECRET-GPS!\0"),
    );

  test("drops metadata tags in place and wipes their values", async () => {
    const input = sample();
    const out = await clean(input);

    expect(out.length).toBe(input.length);
    expect(contains(out, "SECRET")).toBe(false);
    expect(new DataView(out.buffer).getUint16(8, true)).toBe(1);
    expect((await inspect(blobOf(out))).segments).toEqual([]);
  });

  test("refuses camera RAW files", async () => {
    await expect(clean(sample(entry(50706, 1, 4, 1)))).rejects.toBeInstanceOf(
      UnsupportedFormatError,
    );
  });
});

// MP4-family builders
const box = (type: string, ...content: (Uint8Array | string)[]) => {
  const body = concat(
    ...content.map((c) => (typeof c === "string" ? enc.encode(c) : c)),
  );
  return concat(u(body.length + 8, 4), enc.encode(type), body);
};
const full = (type: string, version: number, ...content: Uint8Array[]) =>
  box(type, new Uint8Array([version, 0, 0, 0]), ...content);

describe("HEIC / AVIF", () => {
  const exifData = concat(u(0, 4), enc.encode("MM\0*SECRET-GPS-SECRET"));
  const xmpData = enc.encode("<x>SECRET-XMP</x>");

  const infe = (id: number, type: string, rest = "\0") =>
    full("infe", 2, u(id, 2), u(0, 2), enc.encode(type + rest));
  const build = (exifAt: number) =>
    concat(
      box("ftyp", "heic", u(0, 4)),
      full(
        "meta",
        0,
        full("hdlr", 0, u(0, 4), enc.encode("pict"), new Uint8Array(13)),
        full(
          "iinf",
          0,
          u(3, 2),
          infe(1, "hvc1"),
          infe(2, "Exif"),
          infe(3, "mime", "\0application/rdf+xml\0"),
        ),
        full(
          "iloc",
          0,
          new Uint8Array([0x44, 0]),
          u(2, 2),
          u(2, 2),
          u(0, 2),
          u(1, 2),
          u(exifAt, 4),
          u(exifData.length, 4),
          u(3, 2),
          u(0, 2),
          u(1, 2),
          u(exifAt + exifData.length, 4),
          u(xmpData.length, 4),
        ),
      ),
      box("mdat", exifData, xmpData),
    );
  const input = build(build(0).length - exifData.length - xmpData.length);

  test("empties the EXIF and XMP items without moving anything", async () => {
    const out = await clean(input);

    expect(out.length).toBe(input.length);
    expect(contains(out, "SECRET")).toBe(false);
    expect(contains(out, "hdlr")).toBe(true);
    expect((await inspect(blobOf(out))).segments).toEqual([]);
  });

  test("removeExif leaves XMP", async () => {
    const out = await bytesOf(await removeExif(blobOf(input)));

    expect(contains(out, "SECRET-GPS")).toBe(false);
    expect(contains(out, "SECRET-XMP")).toBe(true);
  });
});

describe("MP4 tracks and dates", () => {
  const ftyp = box("ftyp", "isom", u(0, 4));
  const samples = enc.encode("SECRET-GPS-1SECRET-GPS-2");
  const mdat = box("mdat", samples);
  const mvhd = full("mvhd", 0, u(111, 4), u(222, 4), u(1000, 4), u(5, 4));
  const track = (format: string) =>
    box(
      "trak",
      box(
        "mdia",
        box(
          "minf",
          box(
            "stbl",
            full("stsd", 0, u(1, 4), box(format, new Uint8Array(8))),
            full("stsz", 0, u(12, 4), u(2, 4)),
            full("stsc", 0, u(1, 4), u(1, 4), u(2, 4), u(1, 4)),
            full("stco", 0, u(1, 4), u(ftyp.length + 8, 4)),
          ),
        ),
      ),
    );

  test("removes GPS tracks, including their samples", async () => {
    const input = concat(ftyp, mdat, box("moov", mvhd, track("gpmd")));
    const out = await clean(input);

    expect(out.length).toBe(input.length);
    expect(contains(out, "SECRET-GPS")).toBe(false);
    expect(contains(out, "trak")).toBe(false);
    expect((await inspect(blobOf(out))).segments).toEqual([]);
  });

  test("leaves video tracks alone", async () => {
    const out = await clean(concat(ftyp, mdat, box("moov", track("avc1"))));

    expect(contains(out, "SECRET-GPS-1")).toBe(true);
  });

  test("zeroes creation and modification times only", async () => {
    const input = concat(ftyp, box("moov", mvhd));
    const out = await clean(input);
    const view = new DataView(out.buffer, ftyp.length + 8 + 12);

    expect([0, 4, 8, 12].map((o) => view.getUint32(o))).toEqual([
      0, 0, 1000, 5,
    ]);
  });
});

describe("WebM / MKV extras", () => {
  const el = (id: number[], ...data: Uint8Array[]) => {
    const body = concat(...data);
    return concat(
      new Uint8Array(id),
      new Uint8Array([0x80 | body.length]),
      body,
    );
  };
  const header = el(
    [0x1a, 0x45, 0xdf, 0xa3],
    el([0x42, 0x82], enc.encode("webm")),
  );
  const title = el([0x7b, 0xa9], enc.encode("SECRET"));
  const unknown = (id: number[]) =>
    concat(new Uint8Array(id), new Uint8Array([0xff]));
  const cluster = [0x1f, 0x43, 0xb6, 0x75];
  const segment = [0x18, 0x53, 0x80, 0x67];
  const info = [0x15, 0x49, 0xa9, 0x66];
  const block = el([0xa3], new Uint8Array(20));

  test("finds metadata written after unknown-size Clusters", async () => {
    const input = concat(
      header,
      unknown(segment),
      unknown(cluster),
      block,
      unknown(cluster),
      block,
      el(info, title),
    );
    const out = await clean(input);

    expect(out.length).toBe(input.length);
    expect(contains(out, "SECRET")).toBe(false);
  });

  test("accepts a recording that stops in the middle of a block", async () => {
    const input = concat(
      header,
      unknown(segment),
      el(info, title),
      unknown(cluster),
      block.subarray(0, 7),
    );
    expect(contains(await clean(input), "SECRET")).toBe(false);
  });

  test("voids a checksum that would no longer match", async () => {
    const crc = el([0xbf], new Uint8Array([1, 2, 3, 4]));
    const out = await clean(
      concat(header, el(segment, el(info, crc, title))),
    );
    const infoAt = header.length + 5;

    expect(out[infoAt + 5]).toBe(0xec);
  });
});

describe("reader", () => {
  test("returns the same bytes as the file, in any order", async () => {
    const data = new Uint8Array(1_000_000).map((_, i) => i % 251);
    const r = createReader(new Blob([data]));
    const reads: [number, number][] = [
      [0, 64],
      [4000, 200],
      [999_990, 50],
      [10, 300_000],
      [500_000, 8],
      [500_008, 8],
      [499_000, 16],
    ];

    for (const [offset, length] of reads) {
      expect(await r.read(offset, length)).toEqual(
        data.subarray(offset, offset + length),
      );
    }
  });
});

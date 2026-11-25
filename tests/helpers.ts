/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */

import { removeExif } from "../src";

const enc = new TextEncoder();

/** Joins byte arrays into one. */
export function concat(...parts: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** Turns a Blob back into bytes so we can look at them. */
export async function bytesOf(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** True if `needle` appears anywhere in `haystack`. Used to check text is gone. */
export function contains(haystack: Uint8Array, text: string): boolean {
  const needle = enc.encode(text);
  outer: for (let i = 0; i <= haystack.length - needle.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

export const blob = (bytes: Uint8Array<ArrayBuffer>, type: string) =>
  new Blob([bytes], { type });

export async function strip(bytes: Uint8Array<ArrayBuffer>, type = "") {
  return bytesOf(await removeExif(blob(bytes, type)));
}

// JPEG

/** One JPEG segment: FF <marker> <2-byte length> <content> */
export function jpegSegment(
  marker: number,
  content: Uint8Array | string,
): Uint8Array {
  const body = typeof content === "string" ? enc.encode(content) : content;
  const len = body.length + 2;
  return concat(new Uint8Array([0xff, marker, len >> 8, len & 0xff]), body);
}

export const SOI = new Uint8Array([0xff, 0xd8]);
export const EOI = new Uint8Array([0xff, 0xd9]);
/** SOS header + a few bytes of fake image data. */
export const SCAN = concat(
  jpegSegment(0xda, new Uint8Array(10)),
  new Uint8Array([1, 2, 3, 4]),
);

export const jfif = () =>
  jpegSegment(0xe0, concat(enc.encode("JFIF\0"), new Uint8Array(9)));
export const exif = (secret = "SECRET-GPS") =>
  jpegSegment(0xe1, "Exif\0\0MM\0*" + secret);
export const xmp = (secret = "SECRET-XMP") =>
  jpegSegment(0xe1, "http://ns.adobe.com/xap/1.0/\0<x>" + secret + "</x>");
export const icc = () =>
  jpegSegment(0xe2, concat(enc.encode("ICC_PROFILE\0"), new Uint8Array(20)));
export const iptc = () => jpegSegment(0xed, "Photoshop 3.0\0SECRET-IPTC");
export const comment = (text = "SECRET-COMMENT") => jpegSegment(0xfe, text);
export const dqt = () => jpegSegment(0xdb, new Uint8Array(65));

/** A JPEG built from the given segments: SOI + segments + scan + EOI. */
export function makeJpeg(...segments: Uint8Array[]): Uint8Array<ArrayBuffer> {
  return concat(SOI, ...segments, SCAN, EOI);
}

// PNG

export const PNG_SIGNATURE = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);

/** One PNG chunk: <4-byte length> <type> <data> <CRC>. The CRC is left as zeros. */
export function pngChunk(
  type: string,
  data: Uint8Array | string = new Uint8Array(0),
): Uint8Array {
  const body = typeof data === "string" ? enc.encode(data) : data;
  const out = new Uint8Array(12 + body.length);
  new DataView(out.buffer).setUint32(0, body.length);
  out.set(enc.encode(type), 4);
  out.set(body, 8);
  return out;
}

/** A PNG built from the given chunks: signature + IHDR + chunks + IEND. */
export function makePng(...chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  return concat(
    PNG_SIGNATURE,
    pngChunk("IHDR", new Uint8Array(13)),
    ...chunks,
    pngChunk("IEND"),
  );
}

// WebP

/** One WebP chunk: <fourcc> <4-byte little-endian size> <data> [padding byte if size is odd] */
export function webpChunk(
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

/** A WebP built from the given chunks: "RIFF" + size + "WEBP" + chunks. */
export function makeWebp(...chunks: Uint8Array[]): Uint8Array<ArrayBuffer> {
  const body = concat(enc.encode("WEBP"), ...chunks);
  const head = new Uint8Array(8);
  head.set(enc.encode("RIFF"), 0);
  new DataView(head.buffer).setUint32(4, body.length, true);
  return concat(head, body);
}

/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */
export type SegmentType =
  "exif" | "xmp" | "exmp" | "iptc" | "comment" | "vendor" | "other";

export type Format = "webp" | "png" | "jpeg" | "avi" | "isobmff" | "ebml";

export type Segment = {
  kind: SegmentType;
  offset: number;
  length: number;
  dataOffset?: number;
  dataLength?: number;
};

export type Patch = {
  kind: SegmentType;
  offset: number;
  length: number;
  bytes: Uint8Array<ArrayBuffer>;
};

export interface Reader {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface FormatHandler {
  name: Format;
  detect(head: Uint8Array): boolean;
  findSegments(r: Reader): Promise<Segment[]>;
}

/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */
export type SegmentType =
  "exif" | "xmp" | "exmp" | "iptc" | "comment" | "vendor" | "other";

export type Format =
  "webp" | "png" | "jpeg" | "gif" | "tiff" | "avi" | "isobmff" | "ebml";

export type Segment = {
  kind: SegmentType;
  offset: number;
  length: number;
  dataOffset?: number;
  dataLength?: number;
};

/** Replaces `length` bytes at `offset` with `bytes` followed by `zeros` zero bytes. */
export type Patch = {
  kind: SegmentType;
  offset: number;
  length: number;
  bytes: Uint8Array<ArrayBuffer>;
  zeros?: number;
};

export type RemoveOptions = {
  /**
   * Keep the EXIF orientation tag (and nothing else from EXIF), so photos don't
   * end up sideways. Applies to JPEG, PNG and WebP. Default: `true`.
   */
  keepOrientation?: boolean;
};

/** A segment plus what a format handler needs to remove it. Not part of the public API. */
export type Item = Segment & {
  /** Remove exactly these ranges instead of the format's default treatment. */
  patches?: Patch[];
  /** Cut the bytes out, even in formats that normally overwrite. */
  cut?: boolean;
};

export interface Reader {
  size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
}

export interface FormatHandler {
  name: Format;
  detect(head: Uint8Array): boolean;
  findSegments(r: Reader): Promise<Item[]>;
  /** Turns the segments chosen for removal into byte patches. */
  toPatches(
    r: Reader,
    selected: Item[],
    options: Required<RemoveOptions>,
  ): Patch[] | Promise<Patch[]>;
}

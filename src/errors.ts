/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */
export class ExifExtractorError extends Error {
  readonly code: string = "EXIF_EXTRACTOR_ERROR";
  override name = "ExifExtractorError";
}

export class UnsupportedFormatError extends ExifExtractorError {
  override readonly code = "UNSUPPORTED_FORMAT";
  override name = "UnsupportedFormatError";
}

export class CorruptFileError extends ExifExtractorError {
  override readonly code = "CORRUPT_FILE";
  override name = "CorruptFileError";

  constructor(
    message: string,
    readonly format: string,
    readonly offset?: number,
  ) {
    super(
      `${format}: ${message}${offset !== undefined ? ` at byte ${offset}` : ""}`,
    );
  }
}

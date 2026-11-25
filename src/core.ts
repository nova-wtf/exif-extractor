/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */
import { UnsupportedFormatError } from "./errors.js";
import { avi } from "./formats/avi.js";
import { ebml } from "./formats/ebml.js";
import { gif } from "./formats/gif.js";
import { isobmff } from "./formats/isobmff.js";
import { jpeg } from "./formats/jpeg.js";
import { png } from "./formats/png.js";
import { tiff } from "./formats/tiff.js";
import { webp } from "./formats/webp.js";
import { createReader } from "./reader.js";
import type { FormatHandler, Item, Reader } from "./types.js";

const handlers = [jpeg, png, webp, gif, tiff, avi, isobmff, ebml];

export async function analyze(
  blob: Blob,
): Promise<{ handler: FormatHandler; reader: Reader; items: Item[] }> {
  const reader = createReader(blob);
  const head = await reader.read(0, 64);
  const handler = handlers.find((h) => h.detect(head));
  if (!handler) {
    throw new UnsupportedFormatError("unsupported format");
  }

  const items = await handler.findSegments(reader);
  return { handler, reader, items };
}

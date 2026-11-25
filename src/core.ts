/**
 * SPDX-License-Identifier: PolyForm-Shield-1.0.0
 * Copyright (c) 2026 Arda Emek and Lorns Hanna (https://nova.wtf)
 */
import { avi } from "./formats/avi.js";
import { ebml } from "./formats/ebml.js";
import { isobmff } from "./formats/isobmff.js";
import { jpeg } from "./formats/jpeg.js";
import { png } from "./formats/png.js";
import { webp } from "./formats/webp.js";
import { createReader } from "./reader.js";
import type { Format, Segment } from "./types.js";

const handlers = [jpeg, png, webp, avi, isobmff, ebml];

export async function findAllSegments(
  blob: Blob,
): Promise<{ format: Format; segments: Segment[] }> {
  const r = createReader(blob);
  const head = await r.read(0, Math.min(64, r.size));
  const handler = handlers.find((h) => h.detect(head));
  if (!handler) {
    throw new Error("unsupported format");
  }

  const segments = await handler.findSegments(r);
  return { format: handler.name, segments };
}

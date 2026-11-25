# @nova-wtf/exif-extractor

Remove EXIF, XMP and other metadata from images and videos, in the browser and on the server.

- **No dependencies, no WebAssembly, no native code.** Plain TypeScript that runs anywhere `Blob` and `Uint8Array` exist: browsers, Web Workers, Node, Deno, Bun.
- **No re-encoding.** The image and video data are never decoded or touched, so there's no quality loss and it's fast.
- **Doesn't load files into memory.** It reads only the small headers it needs. The result is built from slices of the original `Blob`, so a 4 GB video costs a few kilobytes of memory.
- **Never modifies your input.** You always get a new `Blob` back.

## Supported formats

| Format          | Extensions                  | What's removed                                                             | How                                               |
| --------------- | --------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------- |
| JPEG            | `.jpg` `.jpeg` `.jfif`      | EXIF, XMP, Extended XMP, IPTC, comments, vendor APP segments               | cut                                               |
| PNG / APNG      | `.png`                      | EXIF, XMP, text chunks (`tEXt` `zTXt` `iTXt`), `tIME`, known vendor chunks | cut                                               |
| WebP            | `.webp`                     | EXIF, XMP                                                                  | cut, and the RIFF size and VP8X flags are updated |
| AVI             | `.avi`                      | `INFO` list, XMP, stream names and stream data                             | overwritten with `JUNK`                           |
| MP4 / MOV / 3GP | `.mp4` `.m4v` `.mov` `.3gp` | `udta` (GPS, make, model), `meta` (Apple metadata), XMP                    | overwritten with `free`                           |
| WebM / MKV      | `.webm` `.mkv`              | `Tags`, `DateUTC`, `Title`, `SegmentUUID`, track names                     | overwritten with `Void`                           |

Formats are detected from the file's bytes, never from its name or MIME type.

**Cut** means the metadata is removed and the file gets smaller. **Overwritten** means it's replaced by a filler block of the same size that every reader skips. Video formats store byte positions of their frames, so removing bytes would break playback; overwriting keeps every position the same.

The parts a file needs to display correctly are always kept: ICC color profiles, JFIF and Adobe headers, PNG transparency and color chunks, animation data, and all video and audio headers.

## Install

```sh
npm install @nova-wtf/exif-extractor
```

It works the same with any package manager (`pnpm add`, `yarn add`, `bun add`), in any runtime with `Blob` and `Uint8Array`: browsers, Web Workers, Node 18+, Deno and Bun.

## Usage

### Remove all metadata

```ts
import { removeMetadata } from "@nova-wtf/exif-extractor";

const clean = await removeMetadata(file); // File or Blob in, Blob out
```

This is what you want for privacy: it removes GPS, device info, dates, author names, comments and everything else the format handlers know about.

### Remove only EXIF

```ts
import { removeExif } from "@nova-wtf/exif-extractor";

const withoutExif = await removeExif(file);
```

Only EXIF is removed; XMP, comments and other metadata stay. Note that **XMP can contain GPS too**, so use `removeMetadata` if the goal is privacy.

### See what's in a file

```ts
import { inspect } from "@nova-wtf/exif-extractor";

const { format, segments } = await inspect(file);
// format: "jpeg"
// segments: [
//   { kind: "exif", offset: 20, length: 12034, dataOffset: 30, dataLength: 12024 },
//   { kind: "xmp",  offset: 12054, length: 2410, ... },
// ]
```

Nothing is changed. Each segment has a `kind` (`"exif"`, `"xmp"`, `"exmp"`, `"iptc"`, `"comment"`, `"vendor"` or `"other"`), its position and size in the file, and for EXIF and XMP, where the actual data starts.

### Errors

```ts
import {
  removeMetadata,
  UnsupportedFormatError,
  CorruptFileError,
} from "@nova-wtf/exif-extractor";

try {
  file = await removeMetadata(file);
} catch (e) {
  if (e instanceof UnsupportedFormatError) {
    // not a format this package handles (zip, pdf, HEIC, …): use the original
  } else if (e instanceof CorruptFileError) {
    // the file claims to be a supported format but its structure is broken
    console.warn(e.format, e.offset, e.message);
  } else {
    throw e;
  }
}
```

| Error                    | `code`               | When                                                                                           |
| ------------------------ | -------------------- | ---------------------------------------------------------------------------------------------- |
| `UnsupportedFormatError` | `UNSUPPORTED_FORMAT` | no handler recognizes the file                                                                 |
| `CorruptFileError`       | `CORRUPT_FILE`       | the file is truncated, has impossible sizes, or hits a safety limit; has `format` and `offset` |
| `ExifExtractorError`     |                      | base class of both                                                                             |

A file is never returned half-processed: either you get a fully cleaned file, or an error.

## Examples

### In the browser, before uploading

Run it in a Web Worker so large files don't block the page:

```ts
// strip.worker.ts
import { removeMetadata } from "@nova-wtf/exif-extractor";

self.onmessage = async (e: MessageEvent<File>) => {
  try {
    self.postMessage({ ok: true, file: await removeMetadata(e.data) });
  } catch (err) {
    self.postMessage({ ok: false, error: String(err) });
  }
};
```

Strip first, then upload the result. If you upload in parts (multipart), split the **cleaned** Blob, since its size can differ from the original.

### On the server

```ts
import {
  removeMetadata,
  UnsupportedFormatError,
} from "@nova-wtf/exif-extractor";

export async function POST({ request }) {
  const form = await request.formData();
  let file = form.get("file") as File;

  try {
    file = new File([await removeMetadata(file)], file.name, {
      type: file.type,
    });
  } catch (e) {
    if (!(e instanceof UnsupportedFormatError)) throw e;
  }

  // … store `file`
}
```

This works in any server that uses the standard `Request` API (SvelteKit, Next.js route handlers, Hono, Deno, Bun, …).

`request.formData()` reads the upload into memory, so set a size limit. For very large uploads, write the request to a temporary file first and pass a `Blob` backed by that file, so only the small headers are read:

```ts
// Node 19.8+
import { openAsBlob } from "node:fs";
const clean = await removeMetadata(await openAsBlob(path));

// Bun
const clean = await removeMetadata(Bun.file(path));
```

## Limitations

These are known and documented, not bugs:

- **JPEG orientation is not kept.** Removing EXIF also removes the rotation tag, so photos taken in portrait may display sideways. Keeping only the orientation tag is planned.
- **HEIC / AVIF are not supported yet.** Their metadata is stored differently from MP4 (as items inside `meta`), so they're rejected with `UnsupportedFormatError` instead of being damaged.
- **JPEG trailers are not checked.** Extra data after the end of the image, such as Google/Samsung Motion Photos (a short MP4 with audio) or MPF secondary images, keeps its own metadata.
- **GPS stored as a video track** (GoPro, DJI drones) is not removed. Only box-level metadata is.
- **Live WebM recordings:** metadata written after the first unknown-size Cluster is not found.
- **WebM/MKV headers:** the EBML header is expected in the common layout (1-byte sizes), which is what ffmpeg, browsers and mkvmerge write. Other layouts are rejected rather than guessed.
- **MKV checksums:** files from mkvmerge contain CRC-32 elements that no longer match after stripping. Players ignore them; strict validators may warn.
- **PNG:** chunk types that aren't on the known list are kept.
- **Other formats** (GIF, TIFF, RAW, PDF, archives, …) are rejected with `UnsupportedFormatError`.

## Checking the result

[ExifTool](https://exiftool.org) is the easiest way to see what's left in a file:

```sh
exiftool -a -G1 -ee cleaned.jpg
```

After `removeMetadata` there should be no `[GPS]`, `[IFD0]` make/model or `[XMP]` groups.

## Development

```sh
npm install
npm test         # run the tests (Vitest)
npm run build    # compile to dist/
```

The tests build small files byte by byte for every format and check that metadata is gone, the file structure is still valid, the media data is untouched, and broken files throw instead of hanging.

## License

PolyForm Shield License 1.0.0 © nova.wtf

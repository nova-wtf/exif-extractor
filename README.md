# @nova-wtf/exif-extractor

Remove EXIF, XMP and other metadata from images and videos, in the browser and on the server.

- **No dependencies, no WebAssembly, no native code.** Plain TypeScript that runs anywhere `Blob` and `Uint8Array` exist: browsers, Web Workers, Node, Deno, Bun.
- **No re-encoding.** The image and video data are never decoded or touched, so there's no quality loss and it's fast.
- **Doesn't load files into memory.** It reads only headers and indexes (JPEGs are also scanned in small chunks to find hidden trailers). The result is built from slices of the original `Blob`, so a 4 GB video costs well under a megabyte of memory.
- **Never modifies your input.** You always get a new `Blob` back.

## Supported formats

| Format          | Extensions                          | What's removed                                                                                       | How                                                  |
| --------------- | ----------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| JPEG            | `.jpg` `.jpeg` `.jfif`              | EXIF, XMP, Extended XMP, IPTC, comments, vendor APP segments, trailers such as motion photo videos   | cut, and the MPF index is updated                    |
| PNG / APNG      | `.png`                              | EXIF, XMP, text chunks, `tIME`, unknown ancillary chunks, data after the image                       | cut                                                  |
| WebP            | `.webp`                             | EXIF, XMP, unknown chunks, data after the image                                                      | cut, and the RIFF size and VP8X flags are updated    |
| GIF             | `.gif`                              | comments, XMP, application data (looping and color profiles are kept), data after the image          | cut                                                  |
| TIFF            | `.tif` `.tiff`                      | EXIF and GPS directories, make, model, dates, author, XMP, IPTC, Photoshop data                      | directory rewritten in place, values zeroed          |
| HEIC / AVIF     | `.heic` `.heif` `.avif`             | EXIF, XMP and other metadata items                                                                   | emptied in place                                     |
| MP4 / MOV / 3GP | `.mp4` `.m4v` `.mov` `.3gp`         | `udta` (GPS, make, model), `meta`, XMP, creation dates, GPS and sensor tracks (GoPro, DJI, CAMM, Apple) | boxes become `free`; dates and samples are zeroed |
| AVI             | `.avi`                              | `INFO` list, XMP, stream names and data, recording date                                              | overwritten with `JUNK`                              |
| WebM / MKV      | `.webm` `.mkv`                      | `Tags`, `DateUTC`, `Title`, `SegmentUUID`, track names                                               | overwritten with `Void`                              |

Formats are detected from the file's bytes, never from its name or MIME type.

**Cut** means the metadata is removed and the file gets smaller. **Overwritten** (also "in place") means the file keeps its size. Video, TIFF and HEIC files store byte positions of their data, so removing bytes would break them.

The parts a file needs to display correctly are kept: ICC color profiles, JFIF and Adobe headers, PNG transparency and color chunks, HDR gain map images, animation data, and all video and audio headers.

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

### Orientation

Photos taken in portrait rely on the EXIF orientation tag. For JPEG, PNG and WebP (extended format) both functions keep that one tag and drop the rest of the EXIF, so `inspect` still lists a tiny `exif` segment afterwards. To remove it as well:

```ts
await removeMetadata(file, { keepOrientation: false });
```

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

Nothing is changed. `format` is one of `"jpeg"`, `"png"`, `"webp"`, `"gif"`, `"tiff"`, `"avi"`, `"isobmff"` (MP4, MOV, HEIC, AVIF) or `"ebml"` (WebM, MKV). Each segment has a `kind` (`"exif"`, `"xmp"`, `"exmp"`, `"iptc"`, `"comment"`, `"vendor"` or `"other"`), its position and size in the file, and for EXIF and XMP, where the actual data starts.

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
    // not a format this package handles (zip, pdf, camera RAW, …): use the original
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

`request.formData()` reads the upload into memory, so set a size limit. For very large uploads, write the request to a temporary file first and pass a `Blob` backed by that file, so the file isn't loaded into memory:

```ts
// Node 19.8+
import { openAsBlob } from "node:fs";
const clean = await removeMetadata(await openAsBlob(path));

// Bun
const clean = await removeMetadata(Bun.file(path));
```

## Limitations

- **Camera RAW** (CR2, CR3, DNG and similar TIFF-based files) is rejected, because decoders depend on the camera data. BigTIFF is rejected too.
- **Other formats** (BMP, SVG, PDF, audio, office documents, archives, …) are rejected with `UnsupportedFormatError`.
- **Content is never edited:** anything visible or audible in the picture or sound stays.
- **Fragmented MP4:** GPS and sensor tracks are unlinked, but samples stored in movie fragments are not zeroed.
- **Apple Live Photos:** removing the timed metadata track can break the pairing between the photo and its video.
- **Ultra HDR JPEG:** `removeMetadata` removes the XMP that some viewers use to find the gain map; they will show the standard image. ISO 21496-1 gain map data is kept.
- **MKV attachments and chapters** are kept.

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

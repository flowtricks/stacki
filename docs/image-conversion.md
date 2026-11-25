# Desktop image conversion

The Assets panel converts individual images or a selection of up to 100 images
into WebP or AVIF. In select mode, the entire image tile toggles selection;
unsupported file types are disabled and Select all includes only eligible images.
The compression icon opens a format dialog, with AVIF selected initially and WebP
as the alternative. Images already in that format are skipped. A per-image menu
opens the same dialog. It processes one image at a time at 95% of its original width
and height and quality 95. Original images move to the operating system trash
only after the replacement and reference updates succeed. GIFs, SVGs, animated
images, and multipage images are excluded rather than silently flattened.

Conversions refuse existing destination names. They rewrite exact public URLs,
relative paths and configured project aliases in source text, including CSS,
Markdown, and collection frontmatter. Query strings and fragments remain intact.
Generated folders, dependencies, Studio, and symlinks are excluded from scanning.
Dynamically assembled paths cannot be discovered by static reference rewriting.

Text updates go through document actors with witnessed source checksums. If an
update fails, completed text edits are rolled back where their checksums still
match; both images remain available even if another edit prevents rollback.
The error reports incomplete conversion. No failed conversion deletes its original.
Limits are 50 MB compressed input/output, 40 million decoded pixels, 30 seconds
of codec processing per image, 10,000 scanned entries, 64 MB of source text, and
512 changed source files per conversion. Cloudflare Studio offers bulk deletion;
image encoding is currently a desktop capability.

## Codec dependencies

`sharp` supplies real WebP and AVIF encoding, EXIF orientation, resizing, and
input limits. Browser canvas cannot guarantee both output formats and Node has
no built-in equivalent. `@img/sharp-wasm32` supplies the architecture-independent
fallback for both Apple Silicon and Intel Mac applications. Each Mac package
excludes architecture-specific sharp binaries to use that same fallback on Intel
and Apple Silicon. Other desktop platforms can use their native sharp package.
The dependencies add codec/WASM download size and CPU work; conversion is bounded
and serial to contain memory and CPU use. Their bundled licenses are retained.

Codec reference: https://sharp.pixelplumbing.com/api-output/

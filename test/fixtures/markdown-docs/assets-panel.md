---
title: Assets
description: Browsing, uploading and organising the files under public/ and src/, and picking one for a prop.
group: interface
order: 6
keywords: ["images", "upload", "public", "media", "files", "svg"]
---

The Assets panel (<kbd>J</kbd>) browses the files in your project: `public/`
for anything served as-is, and `src/` for anything Astro processes.

## Working with files

- **Upload** copies files into the folder you are looking at.
- **New folder** creates one.
- **Rename** by clicking the name; the file is renamed on disk.
- **Drag** a file onto a folder to move it.

Images show as thumbnails; other files show their type. Opening a text file
(CSS, JS, JSON, Markdown) opens it in the code editor with live preview still
running.

## Which folder to put an image in

| Folder       | What Astro does                                   | Use it for                                      |
| ------------ | ------------------------------------------------- | ----------------------------------------------- |
| `src/assets` | Optimises, hashes, and gives you width and height | Photos and artwork in components                |
| `public`     | Serves the file untouched at the same path        | Favicons, `og` images, files you link to by URL |

Stacki writes the right kind of reference for wherever the file is: an import
for something under `src/`, a plain path for something in `public/`.

## Picking an asset for a prop

Any prop that takes an image gets a picker rather than a text field. Choosing an
asset from `src/` writes the import and fills in the intrinsic width and height
where the component asks for them.

The same picker is used by the [style panel](/docs/styling) for background
images.

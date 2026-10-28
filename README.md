# PDF Editor

A browser-based PDF editor with full Khmer support. Everything runs in your browser — PDFs you open
are never uploaded anywhere.

**Use it online:** https://tengsivtean.github.io/pdf-editor/

## Run locally

Serve the folder with any static server (pdf.js needs `http://`, not `file://`):

```bash
python -m http.server 8765 --directory D:\pdf-editor
```

Then open http://localhost:8765 in Chrome or Edge (needed for "Load fonts from this computer").

## Features

- **Edit existing text** (Edit text, `E`): hover shows editable lines. Clicking one only makes it active —
  the text stays exactly as it is, with the cursor where you clicked — until you type or delete. Then the
  original words are removed from the page itself — nothing is painted over them, so map lines,
  colours and anything else behind them stay visible. Size, colour and bold/italic/serif style are
  detected from the page. Clearing the text erases it; deleting the edit (select it, `Del`) restores
  the original.
- **Text inside images** (scans, maps exported as pictures, labels drawn as shapes): with Edit text,
  drag a box over the words. The box is filled with the surrounding background color and a text box
  opens, sized and coloured from the old words and centred where they were. Leave it empty to just
  erase. Works best on plain backgrounds; on patterns or hatching the cover is a solid color.
- **Legacy Khmer fonts** (Limon, ABC, Baidok, Truth…), common in maps and older government documents:
  their text is converted to Unicode when you click it, so you edit real Khmer. The edit is saved as
  Unicode Khmer (the PDF only contains the legacy letters it already used), sized to fit the original
  width. Limon R-series headings default to bold; pick a computer font such as Khmer OS Muol Light
  in the font menu first if you want that style.
- **Add text** (`T`), freehand draw, highlight, boxes, images and drawn signatures. Select (`V`) moves
  anything; drag an image's corner to resize; double-click text to edit it.
- **Built-in Khmer fonts**: 90 freely licensed families in `fonts/library` (Khmer OS, Moul, Koulen,
  Bayon, Siemreap, Kantumruy, Khmer Busra, Noto…), listed in the font menu under "Khmer fonts (built
  in)" and in **Aa…** / "Browse all fonts…", a searchable list that previews each font. Fonts load
  only when shown or used, and the chosen font is embedded in the downloaded PDF. Licenses:
  `fonts/library/LICENSES.md`.
  - Fonts licensed for personal use only can go in `fonts/local/` (same `manifest.json` format). The
    editor loads them when that folder exists; it is kept out of this repository.
- **Fonts**: built-in Sans/Serif/Mono, every font installed on the computer ("Load fonts from this
  computer…", Chrome/Edge), or an uploaded .ttf/.otf. Bold and italic toggles. Chosen fonts are
  embedded in the downloaded PDF.
- **Khmer** (and other complex scripts): typed Khmer is shaped with HarfBuzz, the same engine browsers
  use, so subscripts (្ម ្រ), split vowels (ោ ៀ) and ligatures render correctly. Text the chosen font
  can't cover uses the bundled Noto Sans Khmer. Khmer values in form fields work too.
- **Pages**: reorder by dragging thumbnails, rotate, duplicate, delete, insert blank pages, extract.
- **Merge** ("+ Add PDF" or drop files) and **split** (every page, or ranges like `1-3, 4`, as a .zip).
- **Forms**: fill text fields, checkboxes, dropdowns and radio groups.
- **Zoom**: −/+ buttons, the zoom menu (50–600%, Fit width, Fit page), Ctrl + mouse wheel or touchpad
  pinch (zooms around the cursor), Ctrl + = / Ctrl + − / Ctrl + 0 (100%).
- **Grid** (`G`): an on-screen grid in 2 mm / 5 mm / 10 mm / 20 mm / 1 inch steps, with a stronger
  line every 5 steps. **Snap** makes boxes, highlights, new text, images and moved items line up
  with it. The grid is never included in the downloaded PDF.
- Clicking text to edit puts the cursor where you clicked; nothing is selected, so you change or
  delete characters yourself.
- Undo (Ctrl+Z), Download (Ctrl+S).

## How it writes text

- Latin text is real PDF text in the chosen font.
- Shaped text (Khmer…) is written in two layers, like OCR'd PDFs: the glyphs are drawn as vector
  outlines exactly as HarfBuzz positioned them, and an invisible copy of the text sits over them in
  logical order. Copy, paste and search return the exact Unicode text in every viewer.

## Limits

- Edited text is removed from the file where it is real text. Words inside pictures (scans,
  maps exported as images) can only be covered with a colour patch (drag a box with Edit text). If the
  editor ever cannot locate a word, it leaves the original in place and says so — it never paints over it.
- Other copies of the text (bookmarks, form fields, metadata) are not changed.
- Text extracted from an existing Khmer PDF is only as good as that PDF's own font mapping.
- Forms are flattened on download, so the output is no longer fillable.
- Password-protected PDFs can't be opened.

## License

This editor is licensed under the **GNU General Public License v2.0 or later** (`LICENSE`), because it
includes the GPL-licensed Khmer legacy-font converter.

## Third-party files

- `vendor/hb.js`, `vendor/hb.wasm`, `vendor/hbjs.js` — harfbuzzjs 0.4.15 (MIT).
- `vendor/khmer-unicode-converter/` — khmer-unicode-converter 1.0.1 by Seanghay Yath, a port of the
  Khmer Software Initiative's KhmerConverter; GPL-2.0-or-later.
- `fonts/NotoSansKhmer-*.ttf` — Noto Sans Khmer, SIL Open Font License (`fonts/OFL.txt`).
- `fonts/library/` — Khmer fonts under the SIL Open Font License, GNU LGPL 2.1 or Apache 2.0, each
  listed with its own copyright notice in `fonts/library/LICENSES.md`.
- From CDNs: pdf.js 3.11.174, pdf-lib 1.17.1, @pdf-lib/fontkit 1.1.1, JSZip 3.10.1.

# Jam for Cam — Business Card Generator

A single-file, offline web tool that lets Jam for Cam staff fill in their details, pick a brand palette, and download print-ready PDFs of their business card.

**To hand off:** send `dist/JamforCam_BusinessCard_Generator.html`. It opens in any modern browser, works offline, and has everything (fonts, templates, PDF engine) built in.

## What it outputs

Two PDFs per person:

- `FirstnameLastname_JamforCam_BusinessCard_Front.pdf`
- `FirstnameLastname_JamforCam_BusinessCard_Back.pdf`

Print spec:

- 3.5 × 2 in trim, 0.125 in bleed, 0.125 in safe area
- Crop marks at each corner, starting at the bleed edge, in registration (100/100/100/100)
- TrimBox and BleedBox set in the PDF
- Vector only: live text with Special Gothic embedded as a subset, and the logo as paths
- Colors written as DeviceCMYK, with no RGB in the file
- Kerning from the font's own GPOS table, matching Illustrator

## What the client can change

- First name, Last name (required)
- Title, Email, Phone (optional; empty lines close up toward the bottom of the card)
- Palette (one of nine, below)

Built-in checks:

- Phone is formatted live as `123–456–7890`. Only digits are accepted, the leading `1` country code is dropped, and the number is capped at 10 digits.
- Title is flagged if it contains an email, a phone number or a web address, with one-click "Move to Email / Phone".
- Email gets a format check.
- Text past the safe area gets a warning. Text off the card, or a character the font doesn't have, blocks the download.

## Palettes

Defined at the top of the inline script in `src/app.template.html` (`const PALETTES`).

Brand colors were converted to **FOGRA39 coated** CMYK (relative colorimetric). Each entry's `hex` is a soft proof of that CMYK build, so the preview shows the printed color, not the screen color.

| Palette | Front background | Logo | Back | Name |
|---|---|---|---|---|
| Red | 0/93/69/0 | White | White | Red |
| Yellow | 4/19/91/0 | 100K | White | 100K |
| Lime | 24/0/86/0 | 100K | White | Lime |
| Purple | White | 47/48/0/0 | White | Purple |
| Blue | 59/6/0/0 | 100K | White | Blue |
| Pink | 7/17/0/0 | 100K | White | 100K |
| Orange | 0/74/99/0 | 100K | White | Orange |
| Black & White | White | 100K | White | 100K |
| White on Black | 60/40/40/100 | White | White | 100K |

Title, email and phone are always 100K.

## Templates

`templates/card-front.svg` and `templates/card-back.svg` are exported from Illustrator at trim size (252 × 144 pt). The tool finds elements by layer name (Illustrator: *Object IDs → Layer Names*):

| Layer | Use |
|---|---|
| `front-bg` | Recolored per palette; extended to bleed automatically |
| `Logo` | Rendered as vector; recolored per palette |
| `Firstname`, `Lastname` | Name lines (share one color) |
| `Title`, `Email`, `Phone` | Contact block, anchored to the bottom baseline |
| `GUIDES` | Ignored |

Text keeps the template's font, size and position. Keep editable text live (not outlined).

## Building

Requires Python 3 and fontTools (`pip install fonttools`).

```
python3 scripts/build.py
```

This subsets the fonts in `fonts/` to Latin, extracts their metrics and kerning, and inlines everything into `dist/JamforCam_BusinessCard_Generator.html`. Rebuild after changing anything in `src/`, `templates/` or `fonts/`.

## Structure

```
src/engine.js           template parsing, text layout, SVG preview, PDF writer
src/app.template.html   UI, palettes, validation (placeholders filled at build)
templates/              front/back SVG templates
fonts/                  Special Gothic Regular + Medium (full TTFs, SIL OFL 1.1)
vendor/                 pdf-lib 1.17.1 (MIT)
scripts/                build
dist/                   the built, hand-off-ready tool
```

## Notes

- The template's left text margin (about 6.5–8 pt) sits inside the usual 0.125 in safe area. That's intentional per the design, but some printers may flag it.
- Purple (and other bright screen colors) can't be fully reproduced in CMYK. Use a Pantone spot if exact color matters.
- Special Gothic by Alistair McCready is licensed under the SIL Open Font License 1.1 (`fonts/OFL.txt`), which allows it to be redistributed and embedded in this tool and in the PDFs it makes.

# Wowfarer

Decode your own RestedXP guide export and load it into the free RestedXP addon
as a companion addon, using only exports you are authorised to decode and use.

Decoding runs on your machine. The decoder does not upload your files,
BattleTag or decoded text. Loading the website still involves ordinary web
requests to its host. No paid guide library is hosted here.

## What's in this repo

| Path | What it is |
|---|---|
| `packages/decoder` | The decoder as a TypeScript library and a CLI. No runtime dependencies beyond `fflate`. |
| `site` | The one-page website (Astro). Runs the decoder in your browser. |

## How it works

A RestedXP export is one file:

```
<guide count>|<checksum>:<base64>%|<format marker>
```

The Base64 payload is a stream cipher over a zlib stream. The cipher key is
derived from the BattleTag the export was sold to, which is also the suffix of
the filename. The decoder reverses those steps, checks the Adler-32 the file
carries against both the zlib trailer and the inflated text, and splits the
result into guides on NUL bytes.

The output is a **companion addon**: a folder with a `.toc` that depends on
`RXPGuides` and one Lua file per guide. Each file calls
`RXPGuides.RegisterGuide(...)`, the same public function RestedXP's own bundled
guide files use. Drop it in `Interface/AddOns`, `/reload`, done.

The format is documented by the public RXPGuides source
(`GuideLoader.lua`, <https://github.com/RestedXP/RXPGuides>, CC BY-NC-SA 4.0).
This project implements the export format in TypeScript and does not bundle
the publisher's addon or a paid guide library.

## CLI

```sh
yarn install
node packages/decoder/src/cli.ts "My Guides!Name#1234" --out ./decoded --text
```

Options:

```
-o, --out <dir>          New output directory (required, must not exist)
--battle-tag Name#1234   Tag the export was sold to; default: read from filename
--addon-name <Name>      Companion addon folder name (default Wowfarer_Guides)
--text                   Also write plain .rxp.txt files
```

Pass several exports at once and identical guides are written only once.

## Tests

```sh
yarn test
```

Round-trip tests build a synthetic export from our own text and decode it, so
CI needs no RestedXP content. If you put your own exports in `./exports`
(gitignored) or set `WOWFARER_EXPORTS`, the optional local-export test decodes
them. Expected counts, sizes and checksums can be stored in the ignored
`.local/export-expectations.json` file, or a file selected by
`WOWFARER_EXPECTATIONS`. Keep private export files and their fingerprints
out of published source.

## Terms and legal notices

The site's [Terms of Use and Legal Notices](https://wowfarer.com/legal)
(`site/src/pages/legal.astro`) contains the website terms, intellectual
property notices and privacy notice.

Wowfarer is an independently maintained, noncommercial project with no
donations. It reads the export locally using the associated BattleTag and
packages text through the addon's existing guide-registration interface.
It offers no paid guide library or sharing service. Website illustrations
use fictional example steps.

Use the decoder only where you have the rights to decode, copy and use the
content. Third-party licence terms apply to the extent they are applicable
and enforceable; statutory rights and exceptions remain available.

## Fonts

The site uses Spectral, Inter and JetBrains Mono, all under the SIL Open Font
License. They install from npm via Fontsource and are served with the site.

## License

Wowfarer's original software is MIT licensed. See `LICENSE`. Dependencies
and fonts retain their own licences. Guide content in generated files remains subject
to its rightsholders' licences; it does not become MIT licensed when decoded.

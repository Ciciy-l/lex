# Lex DMG background

`render-background.mjs` is the sole generator of the committed `background.pdf`.
It uses Desktop's existing locked `@napi-rs/canvas` dependency, not AppKit or
installed fonts. From a dependency-ready checkout, run:

```sh
node apps/desktop/resources/dmg/render-background.mjs
node apps/desktop/resources/dmg/render-background.mjs --check
```

The packager consumes the committed PDF; it does not regenerate it. Commit both
source and regenerated output when changing this asset. `--check` renders in
memory and compares every byte. Determinism is checked with the same locked
toolchain; a canvas upgrade or another platform requires rechecking the output.

The approved sources are `../icon.png` and
`../../src/renderer/assets/login/lex-wordmark.svg`. The SVG is loaded by the
existing image renderer, not a partial custom parser. No legacy splash art,
font substitution or generated logo is used. The icon keeps its alpha and
aspect ratio; its source resolution exceeds 2× its displayed size. The wordmark
also exceeds 2×; the arrow remains vector. Only the neutral fade is precomposed
at 2× because PDF canvas gradients do not preserve its alpha.

Keep the 900×610 PDF page, top-left 660×460 default design area, and packager
layout together: app center (175,335), Applications center (485,335), icon size
110, arrow x300–360. The main app ICNS and installation identity are separate
and unchanged. Independently rasterize the PDF for visual inspection after
generation. That inspection does not replace a macOS Finder installation test
or validate code signing, notarization or Gatekeeper trust.

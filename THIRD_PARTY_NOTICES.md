# Third-party notices

Ruby includes material from the following third-party works.

## Kumo (Cloudflare)

- Source: <https://github.com/cloudflare/kumo> (package `@cloudflare/kumo`), read at commit
  `947065ad39694fdc688b1128cc9c360f566a4f73` on 2026-10-26. Documentation: <https://kumo-ui.com/>.
- Licence: MIT.
- What Ruby uses: design token values from `packages/kumo/src/styles/theme-kumo.css` and `kumo-binding.css`
  (neutral, blue, red, emerald and orange colours, the light and dark surface, line, text and tint tokens, the type
  scale, radii, shadows and transition timing). They are converted from oklch to sRGB hex in `src/app.css`, and a few
  are darkened to meet WCAG AA (`docs/design/DESIGN_SYSTEM.md`). Ruby's Svelte components (`src/lib/ui/kit/`) are its
  own code: they follow Kumo's component sizes and states, but no Kumo React code, package, logo or brand mark is
  included.

```text
MIT License Copyright (c) 2026 Cloudflare, Inc.

Permission is hereby granted, free of
charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use, copy, modify, merge,
publish, distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to the
following conditions:

The above copyright notice and this permission notice
(including the next paragraph) shall be included in all copies or substantial
portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF
ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO
EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR
OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
```

## Geist and Geist Mono (Vercel)

- Source: npm `geist@1.7.2`, self-hosted from `static/fonts/geist/` and `static/fonts/geist-mono/`.
- Copyright (c) 2023 Vercel, in collaboration with basement.studio.
- Licence: SIL Open Font License 1.1. The full text ships next to each font file
  (`static/fonts/*/1.7.2/OFL.txt`).

## npm dependencies

Ruby's runtime dependencies (`drizzle-orm`, Apache-2.0; `markdown-it` and its dependencies, MIT, BSD-2-Clause and
PSF-2.0) are installed from npm and keep their own licences. `argparse` (PSF-2.0, Copyright (c) Python Software
Foundation) is only used by markdown-it's command-line tool and is not part of the Worker bundle.
`test/licences.test.ts` fails when a production dependency carries a licence outside the permissive list. No icon set,
UI framework or other code is vendored into the repository.

# Third-party notices

The following components are redistributed in this selected public edition. They remain under their own licences; the first-party terms do not alter those rights. Full licence texts are in `third_party/licenses/` and the Tesseract data licence is preserved beside the runtime.

| Component | Version | Licence | Upstream |
| --- | --- | --- | --- |
| pdf.js | 3.11.174 | Apache-2.0 | https://github.com/mozilla/pdf.js |
| @cantoo/pdf-lib | 2.5.3 | MIT | https://github.com/cantoo-scribe/pdf-lib |
| Tesseract.js and core | 5.1.1 | Apache-2.0 | https://github.com/naptha/tesseract.js |
| English Tesseract language data | tessdata legacy family | Apache-2.0 | https://github.com/tesseract-ocr/tessdata |
| regenerator-runtime, bundled in the Tesseract worker | unspecified | MIT | https://github.com/facebook/regenerator |
| Plus Jakarta Sans | 2.071 | OFL-1.1 | https://github.com/tokotype/PlusJakartaSans |

The Tesseract WebAssembly core also incorporates permissively licensed Leptonica, IJG libjpeg, giflib, libpng, libtiff, libwebp, zlib and openlibm portions. Their licence texts and notices are retained in `third_party/licenses/`. See `docs/third-party-manifest.json` for the machine-readable inventory.

The `@cantoo/pdf-lib` browser distribution bundles the following runtime dependencies: `@pdf-lib/standard-fonts` 1.0.0, `@pdf-lib/upng` 1.0.1, `color` 4.2.3, `color-convert` 2.0.1, `color-name` 1.1.4, `color-string` 1.9.1, `simple-swizzle` 0.2.2, `is-arrayish` 0.3.2, `crypto-js` 4.2.0, `node-html-better-parser` 1.5.6, `html-entities` 2.4.0, `pako` 1.0.11 and `tslib` 2.8.1. These components use MIT, MIT/Zlib or 0BSD terms. The MIT and Zlib texts are already retained in `third_party/licenses/`; the tslib 0BSD text is retained as `third_party/licenses/tslib-0BSD.txt`.

The bundle payload matches the published `@cantoo/pdf-lib` 2.5.3 UMD distribution at SHA-256 `9a682e892f837627ac71a1b7e604c2f9654f343648eadee221d7e115c89bb0ee`. `fontkit` and `fflate` are not embedded in this selected bundle.

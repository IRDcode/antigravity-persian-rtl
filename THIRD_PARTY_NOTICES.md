# Third-Party Notices

This repository bundles or depends on the following open-source software and typefaces:

## 1. Vazirmatn Font
- **Project:** [Vazirmatn](https://github.com/rastikerdar/vazirmatn) by Saber Rastikerdar
- **License:** SIL Open Font License 1.1 (OFL-1.1)
- **Files:** `src/Vazirmatn-Variable.woff2` (embedded offline inside Antigravity Desktop `dist/Vazirmatn-Variable.woff2` during patching) and glyph subsets inside `assets/*.svg`.

## 2. @electron/asar
- **Project:** [@electron/asar](https://github.com/electron/asar)
- **License:** MIT License (`Copyright (c) GitHub Inc. / Electron contributors`)
- **Usage:** Runtime ASAR header parsing and archive verification inside `src/patcher.mjs`.

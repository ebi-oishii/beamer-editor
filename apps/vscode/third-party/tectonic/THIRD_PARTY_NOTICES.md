# Tectonic 0.17.0: verified engine notices

The platform-specific extension packages contain an unmodified Tectonic executable.
Tectonic is a separate process; these notices concern that executable.

Upstream source: [Tectonic commit 8c0126a9653239a2e6e0a5274af9b8510f643030](https://github.com/tectonic-typesetting/tectonic/tree/8c0126a9653239a2e6e0a5274af9b8510f643030), tag `tectonic@0.17.0`.

This is a **partial notice collection**. It preserves the notices verified so far,
and must not be taken as completion of the redistribution audit. External Rust and
native-library notices and the complete corresponding-source delivery remain to
be completed. The review status and source provenance are recorded in
`docs/tectonic-redistribution-audit.md` in the Beamer Editor source repository.

## Included texts

- `LICENSE`: the upstream Tectonic MIT license, unmodified. The upstream
  `Cargo.toml` identifies Copyright 2016–2023 the Tectonic Project. The license
  explicitly notes that derived components have other licenses.
- `ENGINE-NOTICES.txt`: original leading copyright/license comments from the
  Tectonic engine and bridge source files, grouped only when their text is
  identical. Each group names its source files. This includes XeTeX, SyncTeX,
  BibTeX, (x)dvipdfmx/PDF I/O, TECkit, and Tectonic modifications.
- `GPL-2.0.txt`: the GNU General Public License, version 2. Source:
  [GCC 14.2.0 COPYING](https://github.com/gcc-mirror/gcc/blob/releases/gcc-14.2.0/COPYING).
- `LGPL-2.1.txt`: the GNU Lesser General Public License, version 2.1. Source:
  [TECkit License_LGPLv21.txt](https://github.com/silnrsi/teckit/blob/master/license/License_LGPLv21.txt).

## License distinctions

The notices in `crates/engine_xdvipdfmx/xdvipdfmx/dvipdfmx.c` and the
`crates/pdf_io/pdf_io/dpx-*` files specify GPL version 2 or later. They are not
covered solely by the root MIT notice. Their original author notices are retained
in `ENGINE-NOTICES.txt`.

The `crates/engine_xetex/xetex/teckit-*` files identify Copyright 2002–2016 SIL
International (2002–2014 for `teckit-c-Engine.h`) and offer CPL or LGPL licensing.
The upstream [TECkit licensing explanation](https://github.com/silnrsi/teckit/blob/master/license/LICENSING.txt)
specifies LGPL 2.1 or later as an alternative. Including the LGPL text here does
not assert that the corresponding-source/relinking requirements have been met.

The TeX packages fetched by Tectonic at runtime are not included in these VSIX
files. They have separate licenses in their respective distributions.

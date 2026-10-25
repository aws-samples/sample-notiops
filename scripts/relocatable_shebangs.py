#!/usr/bin/env python3
"""Rewrite console-script shebangs in a zip so they do not carry the build machine's interpreter path.

`agentcore package` installs the agent's dependencies with uv, and uv writes each console-script
wrapper (`bin/*`) with the interpreter it installed for as the first line. Cross-packaging on macOS
(→ linux/aarch64) gives `#!/usr/bin/env python3`, but on a Linux build machine it is the absolute path
of that machine's venv, i.e. the builder's home directory and directory layout, inside a zip that is
published on the GitHub Release. The final "no builder-local paths" check of package_artifacts.sh stops
the build when that happens; this script makes the artifact independent of where it was built.

Rewritten, for top-level `bin/` entries only:
  · `#!/<absolute path>/python…`                          → `#!/usr/bin/env python3`
  · uv's trampoline for long paths:
        #!/bin/sh
        '''exec' '/<absolute path>/python…' "$0" "$@"
        ' '''
    (the first three lines)                               → `#!/usr/bin/env python3`
Everything else (other files, wrappers that already use `env`, non-Python scripts) is copied
byte for byte, with the original entry metadata (timestamps, permission bits, compression).

Usage: relocatable_shebangs.py <zip>      (rewrites the zip in place; prints how many entries changed)
"""
from __future__ import annotations

import os
import re
import sys
import tempfile
import zipfile

ENV_SHEBANG = b"#!/usr/bin/env python3"
_ABS_PYTHON = re.compile(rb"^#!(/[^\s'\"]*python[0-9.]*)(\s.*)?$")
_TRAMPOLINE = re.compile(rb"^#!/bin/sh\n'''exec' '(/[^']*python[0-9.]*)' \"\$0\" \"\$@\"\n' '''\n")


def rewrite(data: bytes) -> bytes | None:
    """Return the rewritten script, or None when it does not need rewriting."""
    m = _TRAMPOLINE.match(data)
    if m:
        return ENV_SHEBANG + b"\n" + data[m.end():]
    first, sep, rest = data.partition(b"\n")
    m = _ABS_PYTHON.match(first.rstrip(b"\r"))
    if m:
        return ENV_SHEBANG + sep + rest
    return None


def relocate(zip_path: str) -> int:
    changed = 0
    fd, tmp = tempfile.mkstemp(prefix=".relocate-", suffix=".zip", dir=os.path.dirname(os.path.abspath(zip_path)))
    os.close(fd)
    try:
        with zipfile.ZipFile(zip_path) as src, zipfile.ZipFile(tmp, "w") as dst:
            for info in src.infolist():
                data = src.read(info)
                if info.filename.startswith("bin/") and not info.is_dir():
                    new = rewrite(data)
                    if new is not None:
                        data = new
                        changed += 1
                dst.writestr(info, data, compress_type=info.compress_type)
        os.replace(tmp, zip_path)
    finally:
        if os.path.exists(tmp):
            os.unlink(tmp)
    return changed


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__.rsplit("Usage:", 1)[1].strip())
    n = relocate(sys.argv[1])
    print(f"  relocatable shebangs: {n} bin/ wrapper(s) rewritten to {ENV_SHEBANG.decode()}")

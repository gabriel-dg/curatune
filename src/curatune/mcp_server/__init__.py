"""curatune's local MCP server (stdio): a thin entry point next to the CLI.

It needs the optional `mcp` extra (`pip install "curatune[mcp]"`). Nothing else in curatune imports
this package, so the library and the CLI work without it.
"""

from __future__ import annotations

import logging
import sys


def main() -> int:
    try:
        from .server import build_server
    except ImportError as exc:
        if exc.name and exc.name.split(".")[0] in ("mcp", "mcp_types"):
            print('curatune-mcp needs the MCP extra: pip install "curatune[mcp]"', file=sys.stderr)
            return 1
        raise
    # stdout carries the protocol; everything else goes to stderr (clients keep it in their logs).
    logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    build_server().run("stdio")
    return 0

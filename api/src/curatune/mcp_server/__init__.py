"""curatune's local MCP server (stdio): a thin entry point next to the CLI.

It needs the optional `mcp` extra (`pip install "curatune[mcp]"`). Nothing else in curatune imports
this package, so the library and the CLI work without it.
"""

from __future__ import annotations

import argparse
import importlib.util
import logging
import sys


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="curatune-mcp", description="curatune's local MCP server (stdio).")
    parser.add_argument(
        "--demo",
        action="store_true",
        help="Serve a synthetic account in memory: no Spotify account, no token, no network.",
    )
    args = parser.parse_args(argv)
    # Checked before importing the server, which imports the extra's dependencies (anyio, pydantic) first.
    if importlib.util.find_spec("mcp") is None:
        print('curatune-mcp needs the MCP extra: pip install "curatune[mcp]"', file=sys.stderr)
        return 1
    from .server import build_demo_server, build_server
    # stdout carries the protocol; everything else goes to stderr (clients keep it in their logs).
    logging.basicConfig(stream=sys.stderr, level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
    (build_demo_server() if args.demo else build_server()).run("stdio")
    return 0

"""Structural rules of the MCP layer. These run without the `mcp` extra.

- The MCP server never reaches the private write primitives or the HTTP layer directly: every write
  goes through the same library functions the CLI uses.
- The library and the CLI never import `mcp` or the server, so they work without the extra.
"""

import ast
import subprocess
import sys
from pathlib import Path

import curatune

PACKAGE = Path(curatune.__file__).parent
SERVER = PACKAGE / "mcp_server"


def imported_modules(path: Path) -> set[str]:
    tree = ast.parse(path.read_text(encoding="utf-8"))
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom):
            base = "." * node.level + (node.module or "")
            sep = "" if base.endswith(".") else "."
            names.add(base)
            names.update(f"{base}{sep}{alias.name}" for alias in node.names)
    return names


def test_server_never_imports_write_primitives_or_http():
    for path in SERVER.glob("*.py"):
        for name in imported_modules(path):
            parts = name.lstrip(".").split(".")
            assert "_writes" not in parts, f"{path.name} imports {name}"
            assert parts[0] != "requests", f"{path.name} imports {name}"


def test_library_and_cli_never_import_the_server_or_mcp():
    for path in PACKAGE.glob("*.py"):
        for name in imported_modules(path):
            parts = name.lstrip(".").split(".")
            assert parts[0] not in ("mcp", "mcp_types"), f"{path.name} imports {name}"
            assert "mcp_server" not in parts, f"{path.name} imports {name}"


def run_python(code: str) -> subprocess.CompletedProcess:
    return subprocess.run([sys.executable, "-c", code], capture_output=True, text=True, timeout=60)


def test_importing_the_library_and_cli_does_not_load_mcp():
    result = run_python("import sys, curatune, curatune.cli, curatune.mcp_server.numbering; print('mcp' in sys.modules)")
    assert result.returncode == 0, result.stderr
    assert result.stdout.strip() == "False"


def test_server_without_the_extra_explains_how_to_install_it():
    # Make `import mcp` fail, as it would without the extra, then start the server.
    code = "import sys; sys.modules['mcp'] = None; from curatune.mcp_server import main; sys.exit(main())"
    result = run_python(code)
    assert result.returncode == 1
    assert 'pip install "curatune[mcp]"' in result.stderr
    assert result.stdout == ""  # stdout belongs to the protocol

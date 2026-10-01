"""Agent-facing files stay in sync: one shared skill, one Claude Code entry point, one AGENTS.md."""

from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
SHARED_SKILL = ROOT / ".agents" / "skills" / "curatune" / "SKILL.md"
CLAUDE_SKILL = ROOT / ".claude" / "skills" / "curatune" / "SKILL.md"


def frontmatter(path):
    lines = path.read_text(encoding="utf-8").splitlines()
    assert lines[0] == "---", f"{path} must start with YAML frontmatter"
    end = lines.index("---", 1)
    fields = {}
    for line in lines[1:end]:
        key, _, value = line.partition(":")
        fields[key.strip()] = value.strip()
    return fields


def test_claude_entry_point_matches_shared_skill():
    shared, claude = frontmatter(SHARED_SKILL), frontmatter(CLAUDE_SKILL)
    assert claude["name"] == shared["name"] == "curatune"
    assert claude["description"] == shared["description"]


def test_shared_skill_has_only_portable_frontmatter():
    # allowed-tools uses Claude Code permission syntax; it belongs in the Claude entry point only.
    assert set(frontmatter(SHARED_SKILL)) == {"name", "description"}


def test_claude_entry_point_defers_to_shared_skill():
    assert ".agents/skills/curatune/SKILL.md" in CLAUDE_SKILL.read_text(encoding="utf-8")


@pytest.mark.parametrize("name", ["CLAUDE.md", "GEMINI.md"])
def test_agent_context_files_only_import_agents_md(name):
    lines = [l for l in (ROOT / name).read_text(encoding="utf-8").splitlines() if l.strip()]
    assert lines == ["@AGENTS.md", "@AGENTS.local.md"]

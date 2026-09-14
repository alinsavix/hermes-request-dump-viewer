"""Exercise the published archive, not just the build configuration."""

from __future__ import annotations

import subprocess
import tarfile
from pathlib import Path

import yaml

ROOT = Path(__file__).parents[1]


def test_manifest_stays_compatible_with_v1_installer():
    """Work around Hermes #85879/#90451 without changing the capture hook."""
    manifest = yaml.safe_load((ROOT / "plugin.yaml").read_text())
    assert manifest["manifest_version"] == 1
    assert manifest["api_version"] == 1
    assert manifest["hooks"] == ["pre_api_request"]
    assert manifest["provides_hooks"] == ["pre_api_request"]


def test_sdist_includes_complete_locked_test_inputs(tmp_path):
    subprocess.run(
        ["uv", "build", "--sdist", "--out-dir", str(tmp_path)],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
        timeout=60,
    )
    archives = list(tmp_path.glob("*.tar.gz"))
    assert len(archives) == 1
    with tarfile.open(archives[0]) as archive:
        members = {member.name.split("/", 1)[-1]: member for member in archive.getmembers() if member.isfile()}
        required = {"pyproject.toml", "uv.lock", "package.json", "package-lock.json", "tests/frontend/diff.test.cjs"}
        assert required <= members.keys(), f"Source archive is missing test inputs: {sorted(required - members.keys())}"
        for name in required:
            stream = archive.extractfile(members[name])
            assert stream is not None
            assert stream.read() == (ROOT / name).read_bytes()

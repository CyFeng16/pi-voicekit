# /// script
# requires-python = ">=3.11"
# dependencies = ["datasets", "huggingface_hub"]
# ///
"""Fetch the benchmark slices declared in ``bench/manifest.jsonl``.

The corpora are third-party audio with their own licences, so they are never committed and never
published: ``bench/.gitignore`` excludes ``bench/data/`` and the npm tarball only carries
``extensions``, ``README.md``, ``LICENSE`` and ``package.json``. What is tracked is the *definition*
of the benchmark — the manifest — so a checkout stays small while the corpus stays reproducible:
every slice pins a dataset revision, a deterministic selection rule and a reference rule, and each
fetched file gets a sha256 recorded next to it.

The dependencies live in the PEP 723 block above, so uv installs them and nothing has to be added to
the repository or the developer's environment:

    uv run bench/fetch.py
    uv run bench/fetch.py --only fleurs-zh
    uv run bench/fetch.py --out /tmp/bench-data

Audio is read with ``decode=False`` so no ffmpeg/torchcodec is installed and no resampling happens:
the source wav bytes are written straight to disk, and the reference text comes from the columns the
manifest names.
"""

from __future__ import annotations

import argparse
import hashlib
import importlib
import json
import pathlib
import sys
from collections.abc import Iterator
from typing import Any

MANIFEST = pathlib.Path(__file__).resolve().parent / "manifest.jsonl"
DEFAULT_OUT = pathlib.Path(__file__).resolve().parent / "data"

# Safety valve for the streaming scan: a slice whose label never shows up must fail loudly instead
# of walking a multi-million-row dataset to the end.
MAX_SCAN = 3000


def read_manifest(only: list[str]) -> list[dict[str, Any]]:
    """Parse the tracked manifest, one JSON object per line."""
    slices: list[dict[str, Any]] = []
    for number, line in enumerate(MANIFEST.read_text(encoding="utf-8").splitlines(), start=1):
        if not line.strip():
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError as error:
            raise SystemExit(f"{MANIFEST}:{number}: not valid JSON — {error}") from error
        if only and entry["id"] not in only:
            continue
        slices.append(entry)
    if only:
        found = {entry["id"] for entry in slices}
        missing = [name for name in only if name not in found]
        if missing:
            raise SystemExit(f"unknown slice id(s): {', '.join(missing)}")
    return slices


def clean_reference(text: str, rule: str) -> str:
    """Apply the manifest's reference rule.

    ``drop-spaces-between-cjk`` removes the spaces a dataset may put between hanzi, without touching
    spaces that separate Chinese from Latin text — the mixed-language dictation this project targets
    keeps those.
    """
    if rule != "drop-spaces-between-cjk":
        return text
    out: list[str] = []
    for index, char in enumerate(text):
        between_cjk = (
            0 < index < len(text) - 1
            and "\u4e00" <= text[index - 1] <= "\u9fff"
            and "\u4e00" <= text[index + 1] <= "\u9fff"
        )
        if char == " " and between_cjk:
            continue
        out.append(char)
    return "".join(out)


def audio_column(dataset: Any) -> str | None:
    """Name of the dataset's Audio feature, whatever the dataset calls it."""
    for name, feature in dataset.features.items():
        if type(feature).__name__ == "Audio":
            return name
    return None


def audio_bytes(row: dict[str, Any], column: str, repo: str) -> bytes | None:
    """The wav bytes for one row, or None when the row carries no audio."""
    value = row.get(column)
    if isinstance(value, dict):
        if value.get("bytes"):
            return value["bytes"]
        if value.get("path"):
            return read_hub_file(value["path"], repo)
    if isinstance(value, str) and value.endswith(".wav"):
        return read_hub_file(value, repo)
    return None


def require(module: str) -> Any:
    """Import a dependency declared in the PEP 723 block, or say how to get it.

    The packages are installed on demand by uv and are deliberately absent from the repository and
    from the developer's environment, so the import is dynamic: a plain ``import datasets`` would
    look like a broken dependency to a static analyser, and running the script with a system
    interpreter would fail with a bare ImportError instead of the command that works.
    """
    try:
        return importlib.import_module(module)
    except ModuleNotFoundError as error:
        name = pathlib.Path(__file__).name
        message = f"{module} is not installed — run this script with uv: uv run bench/{name}"
        raise SystemExit(message) from error


def read_hub_file(path: str, repo: str) -> bytes:
    hf_hub_download = require("huggingface_hub").hf_hub_download

    return pathlib.Path(hf_hub_download(repo, path, repo_type="dataset")).read_bytes()


def pick_text(row: dict[str, Any], columns: list[str]) -> str:
    """First non-empty value among the manifest's candidate text columns."""
    for column in columns:
        value = row.get(column)
        if value:
            return str(value).strip()
    return ""


def selected_rows(spec: dict[str, Any], stream: Iterator[dict[str, Any]]) -> Iterator[dict[str, Any]]:
    """Yield the rows the manifest's selection rule picks, in dataset order."""
    select = spec["select"]
    kind = select["kind"]
    if kind == "first":
        for index, row in enumerate(stream):
            if index >= select["count"]:
                return
            yield row
        return
    if kind == "first-per-label":
        wanted = select["count"]
        label_column = select["labelColumn"]
        wanted_label = str(select["label"]).strip().lower()
        for seen, row in enumerate(stream):
            if seen > MAX_SCAN:
                print(f"{spec['id']}: stopped after {MAX_SCAN} rows without finding {wanted_label}", file=sys.stderr)
                return
            if str(row.get(label_column) or "").strip().lower() != wanted_label:
                continue
            yield row
            wanted -= 1
            if wanted <= 0:
                return
        return
    raise SystemExit(f"unknown selection kind: {kind}")


def fetch_slice(spec: dict[str, Any], out_dir: pathlib.Path) -> dict[str, Any]:
    datasets = require("datasets")

    repo = spec["dataset"]
    dataset = datasets.load_dataset(
        repo,
        spec.get("config"),
        split=spec["split"],
        revision=spec["revision"],
        streaming=True,
    )
    column = audio_column(dataset)
    if column is None:
        raise RuntimeError(f"{repo}: no Audio feature found")
    stream = iter(dataset.cast_column(column, datasets.Audio(decode=False)))

    directory = out_dir / spec["id"]
    directory.mkdir(parents=True, exist_ok=True)

    rows: list[dict[str, Any]] = []
    for row in selected_rows(spec, stream):
        payload = audio_bytes(row, column, repo)
        if payload is None:
            continue
        row_id = f"{spec['id']}-{len(rows):02d}"
        path = directory / f"{row_id}.wav"
        path.write_bytes(payload)
        reference = clean_reference(
            pick_text(row, spec.get("textColumns") or []),
            spec.get("referenceRule") or "as-shipped",
        )
        rows.append(
            {
                "id": row_id,
                "slice": spec["id"],
                "language": spec["language"],
                "dataset": repo,
                "revision": spec["revision"],
                "license": spec["license"],
                # The manifest lives inside the slice directory, so the audio is named by its
                # basename: the digest below then depends only on the fetched content, not on
                # where the run wrote it.
                "audio": path.name,
                "sha256": hashlib.sha256(payload).hexdigest(),
                "bytes": len(payload),
                "reference": reference,
            }
        )

    slice_manifest = directory / "manifest.jsonl"
    body = "".join(json.dumps(row, ensure_ascii=False) + "\n" for row in rows)
    slice_manifest.write_text(body, encoding="utf-8")

    return {
        "id": spec["id"],
        "language": spec["language"],
        "rows": len(rows),
        "bytes": sum(row["bytes"] for row in rows),
        "manifest": str(slice_manifest),
        "digest": hashlib.sha256(body.encode("utf-8")).hexdigest()[:16],
        "expected": spec["select"],
    }


def main() -> int:
    for module in ("datasets", "huggingface_hub"):  # fail fast, before any slice work starts
        require(module)

    parser = argparse.ArgumentParser(description="Fetch the benchmark slices from bench/manifest.jsonl")
    parser.add_argument("--only", action="append", default=[], help="slice id to fetch (repeatable)")
    parser.add_argument("--out", default=str(DEFAULT_OUT), help="output directory (default bench/data)")
    args = parser.parse_args()

    out_dir = pathlib.Path(args.out).expanduser().resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    failures = 0
    results: list[dict[str, Any]] = []
    for spec in read_manifest(args.only):
        try:
            result = fetch_slice(spec, out_dir)
        except Exception as error:  # one slice failing must not hide the others
            failures += 1
            print(f"{spec['id']}: FAILED {type(error).__name__}: {error}", file=sys.stderr)
            continue
        wanted = result["expected"]["count"]
        status = "ok" if result["rows"] == wanted else f"WANTED {wanted}"
        print(f"{result['id']:<14} [{result['language']:<5}] rows {result['rows']:<3} {status}  digest {result['digest']}")
        results.append(result)

    if results:
        total_rows = sum(row["rows"] for row in results)
        print(f"total: {total_rows} rows, {sum(r['bytes'] for r in results) / 1e6:.1f} MB -> {out_dir}")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())

#!/usr/bin/env python3
"""P0 S15: can the /insights output be read as an optional adapter input?

Reads <usage-data>/session-meta/*.json and facets/*.json, keeps only an
allowlist of numeric/label fields, and writes aggregate counts. Free-text
fields (first_prompt, brief_summary, friction_detail, underlying_goal,
primary_success, project_path) may be parsed with the file but are never
copied, printed or written. A missing folder is not an error (fail-open).

usage: s15-insights-read.py <usage-data dir> <out json>
"""
import json
import pathlib
import sys

META_NUMERIC = {
    "duration_minutes", "user_message_count", "assistant_message_count", "git_commits",
    "git_pushes", "input_tokens", "output_tokens", "user_interruptions", "tool_errors",
    "lines_added", "lines_removed", "files_modified", "bash_would_prompt_count",
    "file_edit_tool_count", "destructive_command_count",
}
META_FLAGS = {"uses_task_agent", "uses_mcp", "uses_web_search", "uses_web_fetch"}
FACET_LABELS = {"outcome", "claude_helpfulness", "session_type"}
FACET_COUNTS = {"friction_counts", "goal_categories"}
NEVER = {"first_prompt", "brief_summary", "friction_detail", "underlying_goal", "primary_success", "project_path"}


def read_dir(path: pathlib.Path):
    if not path.is_dir():
        return None
    rows = []
    for f in sorted(path.glob("*.json")):
        try:
            rows.append(json.loads(f.read_text()))
        except (OSError, ValueError):
            continue
    return rows


def main() -> int:
    base, out = pathlib.Path(sys.argv[1]).expanduser(), pathlib.Path(sys.argv[2])
    meta, facets = read_dir(base / "session-meta"), read_dir(base / "facets")
    result = {"present": {"sessionMeta": meta is not None, "facets": facets is not None}}
    if meta is not None:
        sums = {k: 0 for k in META_NUMERIC}
        flags = {k: 0 for k in META_FLAGS}
        for row in meta:
            for k in META_NUMERIC:
                v = row.get(k)
                if isinstance(v, (int, float)) and not isinstance(v, bool):
                    sums[k] += v
            for k in META_FLAGS:
                flags[k] += 1 if row.get(k) is True else 0
        result["sessionMeta"] = {"files": len(meta), "sums": sums, "flagCounts": flags}
    if facets is not None:
        labels = {k: {} for k in FACET_LABELS}
        counts = {k: {} for k in FACET_COUNTS}
        for row in facets:
            for k in FACET_LABELS:
                v = row.get(k)
                if isinstance(v, str) and len(v) <= 40:
                    labels[k][v] = labels[k].get(v, 0) + 1
            for k in FACET_COUNTS:
                v = row.get(k)
                if isinstance(v, dict):
                    for name, n in v.items():
                        if isinstance(n, (int, float)) and len(name) <= 60:
                            counts[k][name] = counts[k].get(name, 0) + n
        result["facets"] = {"files": len(facets), "labels": labels, "counts": counts}
    text = json.dumps(result, ensure_ascii=False, indent=1)
    assert not any(f'"{k}"' in text for k in NEVER), "a free-text field leaked"
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(text)
    print(f"S15 read: sessionMeta={result['present']['sessionMeta']} facets={result['present']['facets']}")
    return 0


if __name__ == "__main__":
    sys.exit(main())

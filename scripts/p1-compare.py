#!/usr/bin/env python3
"""debrief P1: compare recorded usage with the same session's transcripts.

usage: p1-compare.py <debrief root> [transcripts dir]

For every session folder under <root>/runs/<slug>/<sessionId>/, sums the run
files' usage per loop and model (four counters and request count) and the
transcript's per request (deduped by requestId + message.id): the main file
for the main loop, subagents/agent-<id>.jsonl for each agent. Prints numbers
only. Exits 1 on any mismatch.
"""
import json
import os
import pathlib
import sys


def transcript(path: pathlib.Path):
    by, order = {}, []
    if not path.exists():
        return None
    for line in path.open():
        try:
            o = json.loads(line)
        except ValueError:
            continue
        if o.get("type") != "assistant":
            continue
        m = o.get("message") or {}
        u = m.get("usage")
        if not u:
            continue
        key = (o.get("requestId"), m.get("id"))
        if key not in by:
            order.append(key)
        by[key] = (m.get("model"), u)
    out = {}
    for key in order:
        model, u = by[key]
        acc = out.setdefault(model, [0, 0, 0, 0, 0])
        acc[0] += u.get("input_tokens", 0)
        acc[1] += u.get("output_tokens", 0)
        acc[2] += u.get("cache_read_input_tokens", 0)
        acc[3] += u.get("cache_creation_input_tokens", 0)
        acc[4] += 1
    return out


def main() -> int:
    root = pathlib.Path(sys.argv[1])
    config = pathlib.Path(os.environ.get("CLAUDE_CONFIG_DIR") or pathlib.Path.home() / ".claude")
    tdir_arg = sys.argv[2] if len(sys.argv) > 2 else None
    failures = 0
    for session in sorted((root / "runs").glob("*/*")):
        slug = session.parent.name
        tdir = pathlib.Path(tdir_arg) if tdir_arg else config / "projects" / slug
        recorded = {}
        for f in sorted(session.glob("*.json")):
            run = json.loads(f.read_text())
            for loop, by_model in run["usage"].items():
                for model, u in by_model.items():
                    acc = recorded.setdefault(loop, {}).setdefault(model, [0, 0, 0, 0, 0])
                    for i, k in enumerate(("in", "out", "cacheRead", "cacheWrite", "steps")):
                        acc[i] += u[k] if k != "steps" else u["steps"] - u["nullUsageSteps"]
        for loop, by_model in sorted(recorded.items()):
            path = tdir / f"{session.name}.jsonl" if loop == "main" else tdir / session.name / "subagents" / f"agent-{loop}.jsonl"
            expected = transcript(path)
            label = "main" if loop == "main" else "agent"
            if expected is None:
                print(f"{label}: no transcript to compare")
                failures += 1
                continue
            for model in sorted(set(by_model) | set(expected)):
                got, want = by_model.get(model), expected.get(model)
                ok = got == want
                failures += 0 if ok else 1
                print(f"{label:<5} {model:<22} {'EQUAL' if ok else 'DIFF '} recorded {got} transcript {want}")
    print("mismatches:", failures)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())

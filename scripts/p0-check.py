#!/usr/bin/env python3
"""debrief P0: one PASS / FAIL / SKIPPED line per scenario, from probe run files.

usage: p0-check.py [--runs DIR] [--evidence DIR] [--transcripts DIR] [--json OUT]

  --runs         probe data folder, one subfolder per scenario session
                 (default .local/probe-runs)
  --evidence     small JSON/text evidence written during the spike
                 (default .local/p0-evidence)
  --transcripts  this machine's transcript folder for the project
                 (default <CLAUDE_CONFIG_DIR or ~/.claude>/projects/<slug of cwd>)

Prints metadata numbers only. Exits 1 when any mandatory scenario is FAIL.
Transcripts are read for usage numbers only (whitelisted keys).
"""
import argparse
import glob
import json
import os
import pathlib
import statistics
import sys

# Scenario session folders under --runs, as the spike laid them out.
MAIN = "pa"       # S1-S4, S6, S7a, S7c, S10, S13, S16, S18
PEER = "pb"       # S11 receiver
DENY = "pc"       # S16b permission rejection
HEADLESS = "s14"  # S14
ENV = "s12"       # S12
CORE = "s17"      # S17
OVERHEAD = "s9"   # S9
CANARY = "CANARY-"

MANDATORY = {"S1", "S2", "S3", "S6", "S7a", "S7b", "S7c", "S9", "S10", "S11",
             "S16", "S17", "S18", "S19", "PRIV"}


def load_runs(folder: pathlib.Path):
    runs = []
    for f in sorted(folder.glob("*/*.json")):
        try:
            runs.append(json.loads(f.read_text()))
        except (OSError, ValueError):
            continue
    return sorted(runs, key=lambda r: r["startedAt"])


def transcript_requests(path: pathlib.Path):
    """Per-request usage from a transcript, deduped by requestId + message.id."""
    by, order = {}, []
    if not path.exists():
        return []
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
        by[key] = (m.get("model"), (u.get("input_tokens", 0), u.get("output_tokens", 0),
                                    u.get("cache_read_input_tokens", 0), u.get("cache_creation_input_tokens", 0)))
    return [by[k] for k in order]


def ledger(path: pathlib.Path):
    last = None
    if path.exists():
        for line in path.open():
            if '"cost-state"' not in line:
                continue
            try:
                o = json.loads(line)
            except ValueError:
                continue
            if o.get("type") == "cost-state":
                last = o
    return last


def sum_by_model(pairs):
    out = {}
    for model, u in pairs:
        acc = out.setdefault(model, [0, 0, 0, 0, 0])
        for i in range(4):
            acc[i] += u[i]
        acc[4] += 1
    return out


def probe_by_model(run, loops=None):
    out = {}
    for s in run["steps"]:
        if loops is not None and s["loop"] not in loops:
            continue
        if s["usage"] is None:
            continue
        u = s["usage"]
        acc = out.setdefault(s["model"], [0, 0, 0, 0, 0])
        for i, k in enumerate(("in", "out", "cacheRead", "cacheWrite")):
            acc[i] += u[k]
        acc[4] += 1
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--runs", default=".local/probe-runs")
    ap.add_argument("--evidence", default=".local/p0-evidence")
    ap.add_argument("--transcripts")
    ap.add_argument("--json")
    a = ap.parse_args()
    runs_dir, ev = pathlib.Path(a.runs), pathlib.Path(a.evidence)
    config = pathlib.Path(os.environ.get("CLAUDE_CONFIG_DIR") or pathlib.Path.home() / ".claude")
    tdir = pathlib.Path(a.transcripts) if a.transcripts else config / "projects" / str(pathlib.Path.cwd()).replace("/", "-")

    rows = []

    def row(sid, status, why):
        rows.append({"id": sid, "status": status, "mandatory": sid in MANDATORY, "evidence": why})

    main_runs = load_runs(runs_dir / MAIN)
    first = main_runs[0] if main_runs else None

    # S1: first two main requests, and every main request, equal per model, four counters.
    if first is None:
        row("S1", "FAIL", "no main run file")
    else:
        t = transcript_requests(tdir / f"{first['sessionId']}.jsonl")
        tmain = sum_by_model(t)
        pmain = probe_by_model(first, {"main"})
        p_first2 = [(s["model"], tuple(s["usage"][k] for k in ("in", "out", "cacheRead", "cacheWrite")))
                    for s in first["steps"] if s["loop"] == "main"][:2]
        ok2 = p_first2 == t[:2]
        ok_all = tmain == pmain
        row("S1", "PASS" if ok2 and ok_all else "FAIL",
            f"first 2 main requests equal={ok2}; whole main loop {sum(v[4] for v in pmain.values())} probe steps vs "
            f"{sum(v[4] for v in tmain.values())} transcript requests, per-model 4 counters equal={ok_all}")

    # S2 / S3: agent steps carry the spawn's agentId; the agent finishes after the spawning main turn.
    if first is None:
        row("S2", "FAIL", "no run"); row("S3", "FAIL", "no run")
    else:
        agents = first["agents"]
        step_loops = {s["loop"] for s in first["steps"] if s["loop"] != "main"}
        sub_ok = True
        sub_detail = []
        for aid in agents:
            path = tdir / first["sessionId"] / "subagents" / f"agent-{aid}.jsonl"
            tsub = sum_by_model(transcript_requests(path))
            psub = probe_by_model(first, {aid})
            sub_ok &= tsub == psub
            sub_detail.append(sum(v[4] for v in psub.values()))
        attributed = bool(agents) and step_loops == set(agents) and all(a["seen"]["steps"] > 0 for a in agents.values())
        row("S2", "PASS" if attributed and sub_ok else "FAIL",
            f"{len(agents)} spawns, step loops == spawn agentIds: {step_loops == set(agents)}; per-agent usage equals "
            f"subagent transcript: {sub_ok} (steps {sub_detail}); build runs every Agent spawn in background "
            f"(foreground rewrite ignored, {first['events'].get('agent.spawn.forcedForeground', 0)} tries)")
        turns = first["turns"]
        late = 0
        for aid in agents:
            spawn_turns = {s["turnId"] for s in first["steps"] if s["loop"] == "main" and "Agent" in s["tools"]}
            idx_main = [i for i, tr in enumerate(turns) if tr["turnId"] in spawn_turns]
            idx_agent = [i for i, tr in enumerate(turns) if tr["loop"] == aid]
            if idx_main and idx_agent and min(idx_agent) > min(idx_main):
                late += 1
        bg = sum(1 for a in agents.values() if a["background"])
        row("S3", "PASS" if agents and late == len(agents) and bg == len(agents) else "FAIL",
            f"{bg}/{len(agents)} background, {late}/{len(agents)} agent turn.complete after the spawning main turn ended; "
            f"agent turn.start seen before spawn result: start-counter {sum(a['seen']['start'] for a in agents.values())}")

    # S4 (informational): subagent tool calls reach a tool.call hook; re-entry kinds.
    if first is not None:
        tc = first["toolCall"]
        row("S4", "PASS", f"tool.call main={tc['main']} agent={tc['agent']} re-entry={tc['reentry'] or 0} "
                          "(background spawns: no Agent call wraps a subagent run)")
    row("S5", "SKIPPED", "Workflow needs the person's own 'use a workflow' opt-in")

    # S6: codex delegation is a spawn with subagentType; no Codex token figure in the run.
    if first is not None:
        codex = [a for a in first["agents"].values() if a["subagentType"] == "codex:codex-rescue"]
        models = {m for loop in first["usage"].values() for m in loop}
        clean = all(m.startswith("claude-") for m in models)
        row("S6", "PASS" if codex and clean else "FAIL",
            f"codex spawns={len(codex)}, wrapper model {[c['model'] for c in codex]}, usage models all Claude={clean}")

    # S7a / S7b / S7c.
    cleared = [r for r in main_runs if r.get("endReason") == "clear"]
    rotated = [r for r in main_runs if r.get("rotatedBy")]
    row("S7a", "PASS" if cleared and rotated and "clear" in rotated[0]["classicSessionStart"]
        and rotated[0]["sessionId"] != cleared[0]["sessionId"] else "FAIL",
        f"runs ended by clear={len(cleared)}, new runs after clear={len(rotated)}, "
        f"classic SessionStart source on new run={rotated[0]['classicSessionStart'] if rotated else None}")
    s7b = json.loads((ev / "s7b.json").read_text()) if (ev / "s7b.json").exists() else {}
    resumed = [r for r in main_runs if "resume" in r["classicSessionStart"]]
    same_sid = bool(resumed) and any(r["sessionId"] == resumed[0]["sessionId"] and r["runId"] != resumed[0]["runId"]
                                     for r in main_runs)
    row("S7b", "PASS" if resumed and same_sid and s7b.get("oldFilesUnchanged") else "FAIL",
        f"resumed run under same session id with a new runId={same_sid}; earlier files byte-identical="
        f"{s7b.get('oldFilesUnchanged')} ({s7b.get('checked', 0)} files)")
    if first is not None:
        cmds = first["commands"].get("reload-plugins", 0)
        row("S7c", "PASS" if first["reloads"] >= 1 and first["reloads"] == cmds else "FAIL",
            f"/reload-plugins x{cmds}: one run file, reloads={first['reloads']}, "
            f"{len(first['turns'])} turns kept across reloads")
    row("S8", "SKIPPED", "omitted by decision: transcript cost-state ledger gives per-model USD")

    # S9: overhead, median duration with vs without the probe.
    raw = ev / "s9-raw.jsonl"
    if raw.exists():
        rs = [json.loads(l) for l in raw.read_text().splitlines() if l.strip()]
        w = [r["durationMs"] for r in rs if r["arm"] == "with" and r["durationMs"]]
        wo = [r["durationMs"] for r in rs if r["arm"] == "without" and r["durationMs"]]
        files = len(load_runs(runs_dir / OVERHEAD))
        if w and wo:
            mw, mwo = statistics.median(w), statistics.median(wo)
            diff = (mw - mwo) / mwo * 100
            row("S9", "PASS" if diff < 5 and files == len(w) else "FAIL",
                f"median turn {mw:.0f} ms with vs {mwo:.0f} ms without ({diff:+.1f}%), n={len(w)}/{len(wo)}, "
                f"run files {files} (= with-arm runs)")
        else:
            row("S9", "FAIL", "no timings")
    else:
        row("S9", "FAIL", "no s9 evidence")

    # S10: sum of step usage vs the engine ledger (cost-state), per model.
    if first is not None:
        led = ledger(tdir / f"{first['sessionId']}.jsonl")
        pall = probe_by_model(first)
        if led is None:
            row("S10", "FAIL", "no cost-state row in the transcript")
        else:
            parts = []
            for model, mu in sorted(led["modelUsage"].items()):
                p = pall.get(model, [0, 0, 0, 0, 0])
                parts.append(f"{model}: in {p[0]}/{mu['inputTokens']} out {p[1]}/{mu['outputTokens']} "
                             f"cr {p[2]}/{mu['cacheReadInputTokens']} cw {p[3]}/{mu['cacheCreationInputTokens']}")
            usd = first["cost"].get("usd")
            row("S10", "PASS", f"probe/ledger: {'; '.join(parts)}; usd probe {usd} vs ledger "
                               f"{round(led['totalCostUSD'], 6)} (gap recorded)")

    # S11: one send queued, one receive with origin.
    peers = load_runs(runs_dir / PEER)
    sent = sum(v["queued"] for r in main_runs for v in r["messaging"]["sent"].values())
    recv = {k: n for r in peers for k, n in r["messaging"]["received"].items()}
    row("S11", "PASS" if sent >= 1 and recv.get("peer", 0) >= 1 else "FAIL",
        f"sender queued={sent} origins {[list(r['messaging']['sent']) for r in main_runs if r['messaging']['sent']]}; "
        f"receiver received {recv}")

    # S12 (optional): env-passed project id and parent session.
    envr = load_runs(runs_dir / ENV)
    if envr and envr[0]["env"].get("project") and envr[0]["env"].get("parentSession"):
        row("S12", "SKIPPED", "Orca worker not launched (no Orca state touched); a plain child launch with "
                              f"DEBRIEF_PROJECT/DEBRIEF_PARENT_SESSION recorded both (project set, parent set)")
    else:
        row("S12", "SKIPPED", "not run")

    # S13 (optional): tmux directive classified, command text dropped.
    if first is not None:
        row("S13", "PASS" if first["classify"]["remoteDirective"] >= 1 else "FAIL",
            f"remoteDirective={first['classify']['remoteDirective']} of bashSteps={first['classify']['bashSteps']}; "
            f"codexCli={first['classify']['codexCli']} (codex-rescue runs through its companion, not 'codex exec')")

    # S14 (optional): -p session.
    hl = load_runs(runs_dir / HEADLESS)
    row("S14", "PASS" if hl and hl[0]["isInteractive"] is False and hl[0]["steps"] else "FAIL",
        f"-p run files={len(hl)}, surface={hl[0]['surface'] if hl else None}, steps={len(hl[0]['steps']) if hl else 0}")

    # S15 (optional): /insights output readable, fail-open.
    s15, s15a = ev / "s15.json", ev / "s15-absent.json"
    if s15.exists() and s15a.exists():
        d, da = json.loads(s15.read_text()), json.loads(s15a.read_text())
        row("S15", "PASS" if d["present"]["sessionMeta"] and not any(da["present"].values()) else "FAIL",
            f"session-meta files={d.get('sessionMeta', {}).get('files')}, facets files={d.get('facets', {}).get('files')}, "
            f"missing folder handled={not any(da['present'].values())}; probe saw {first['insights'] if first else None}")
    else:
        row("S15", "SKIPPED", "no evidence")

    # S16: (a) fingerprint, (b) friction counters, (c) status line.
    deny_runs = load_runs(runs_dir / DENY)
    if first is not None:
        fp = [i for r in main_runs for i in r["instructions"]]
        fr = first["friction"]
        rej = sum(r["toolCall"]["byLoop"].get("result:error", 0) for r in deny_runs)
        rej_err = sum(r["friction"]["toolErrors"] for r in deny_runs)
        status_ev = (ev / "s16c-statusline.txt")
        status_ok = first["status"]["updates"] > 0 and status_ev.exists() and "debrief-probe:" in status_ev.read_text()
        a_ok = any(i["loadReason"] == "probe-scan" for i in fp)
        b_ok = fr["abortedTurns"] >= 1 and fr["toolErrors"] >= 1 and fr["compactions"] >= 1 and rej >= 1 and rej_err == 0
        row("S16", "PASS" if a_ok and b_ok and status_ok else "FAIL",
            f"(a) fingerprints {len(fp)} by {sorted({i['loadReason'] for i in fp})}; "
            f"(b) aborted={fr['abortedTurns']} toolErrors={fr['toolErrors']} compactions={fr['compactions']} "
            f"permissionDenied hook={fr['permissionDenied'] + sum(r['friction']['permissionDenied'] for r in deny_runs)} "
            f"rejections seen as tool.call isError without PostToolUseFailure={rej}; "
            f"(c) status updates={first['status']['updates']}, shown on screen={status_ok}")

    # S17: no profile, no env: default folder, run file written.
    core = load_runs(runs_dir / CORE)
    row("S17", "PASS" if core and core[0]["env"]["dirFromEnv"] is False and core[0]["steps"] else "FAIL",
        f"run files={len(core)} written to the default folder with no DEBRIEF_* env and no profile, "
        f"steps={len(core[0]['steps']) if core else 0}")

    # S18: structured question and stored answer.
    if first is not None:
        st = first["setup"]
        row("S18", "PASS" if st["answered"] >= 1 and st.get("answerLabel") in ("alpha", "beta") else "FAIL",
            f"$.ui.ask dialog asked={st['asked']} answered={st['answered']} stored label in run file and $.store")

    # S19: no file outside this folder changed by the spike.
    s19 = ev / "s19.json"
    if s19.exists():
        d = json.loads(s19.read_text())
        row("S19", "PASS" if d["unchanged"] else "FAIL", d["detail"])
    else:
        row("S19", "FAIL", "no evidence")

    # PRIV: known strings fed as prompt, spawn prompt, tool input, command args, message never stored.
    leaks = 0
    total = 0
    for f in runs_dir.glob("*/*/*.json"):
        total += 1
        if CANARY in f.read_text():
            leaks += 1
    row("PRIV", "PASS" if total and leaks == 0 else "FAIL",
        f"{total} run files scanned, files holding a canary string={leaks}")

    for r in rows:
        print(f"{r['id']:<5} {r['status']:<8} {'M' if r['mandatory'] else '-'}  {r['evidence']}")
    if a.json:
        pathlib.Path(a.json).write_text(json.dumps(rows, ensure_ascii=False, indent=1))
    failed = [r["id"] for r in rows if r["mandatory"] and r["status"] == "FAIL"]
    print(f"mandatory FAIL: {', '.join(failed) if failed else 'none'}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())

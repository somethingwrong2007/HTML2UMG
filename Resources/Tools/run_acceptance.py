#!/usr/bin/env python3
"""End-to-end acceptance run for Html2UMG.

    html --[node converter]--> layout.json --[UE commandlet]--> WBP + render.png
                                                                      |
                                             browser screenshot ------+--> pngdiff

Usage:
    python run_acceptance.py --html Plugins/Html2UMG/Resources/Converter/test/03-dashboard.html \
                             --blueprint /Game/UI/Html2UMGTest/WBP_Dashboard

Prints a single report and exits non-zero if any stage failed.
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
PLUGIN_DIR = os.path.normpath(os.path.join(HERE, "..", ".."))
PROJECT_DIR = os.path.normpath(os.path.join(PLUGIN_DIR, "..", ".."))
def discover_project() -> str:
    """The .uproject hosting this plugin; override with HTML2UMG_UPROJECT."""
    override = os.environ.get("HTML2UMG_UPROJECT")
    if override:
        return os.path.abspath(override)
    matches = sorted(name for name in os.listdir(PROJECT_DIR) if name.endswith(".uproject"))
    if len(matches) == 1:
        return os.path.join(PROJECT_DIR, matches[0])
    preferred = os.path.basename(PROJECT_DIR) + ".uproject"
    return os.path.join(PROJECT_DIR, preferred if preferred in matches else (matches[0] if matches else preferred))


# Override with HTML2UMG_ENGINE / HTML2UMG_UPROJECT when the local layout differs.
ENGINE_DIR = os.environ.get("HTML2UMG_ENGINE", r"E:\Epic Games\UE_5.8")
UPROJECT = discover_project()
EDITOR_CMD = os.path.join(ENGINE_DIR, r"Engine\Binaries\Win64\UnrealEditor-Cmd.exe")
EDITOR_EXE = os.path.join(ENGINE_DIR, r"Engine\Binaries\Win64\UnrealEditor.exe")
CONVERT_JS = os.path.join(PLUGIN_DIR, r"Resources\Converter\cli\convert.js")


def log(stage: str, message: str) -> None:
    print(f"[{stage}] {message}", flush=True)


def run(cmd: list[str], timeout: int, cwd: str | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout, cwd=cwd,
                          encoding="utf-8", errors="replace")


def normalize_blueprint(value: str) -> str:
    """Repair a /Game/ path mangled by MSYS path conversion (Git-Bash rewrites a leading '/')."""
    text = (value or "").replace("\\", "/")
    index = text.find("/Game/")
    if index > 0:
        return text[index:]
    return text


def stage_convert(args, work: str) -> tuple[bool, str, str]:
    """Returns (ok, json_path, shot_path)."""
    json_path = os.path.join(work, "layout.json")
    shot_path = os.path.join(work, "browser.png")
    cmd = [
        args.node, CONVERT_JS, args.html,
        "-o", json_path,
        "--viewport", args.viewport,
        "--shot", shot_path,
        "--blueprint", args.blueprint,
    ]
    if args.probe:
        cmd += ["--probe", args.probe]
    if args.strict:
        cmd += ["--strict"]
    log("convert", " ".join(cmd))
    try:
        result = run(cmd, timeout=args.convert_timeout)
    except subprocess.TimeoutExpired:
        log("convert", f"TIMEOUT after {args.convert_timeout}s")
        return False, json_path, shot_path

    for line in (result.stdout or "").splitlines():
        log("convert", line)
    if result.returncode not in (0, 2):
        for line in (result.stderr or "").splitlines()[-25:]:
            log("convert", "stderr: " + line)
        return False, json_path, shot_path

    if not os.path.isfile(json_path):
        log("convert", "no layout.json produced")
        return False, json_path, shot_path

    with open(json_path, "r", encoding="utf-8") as handle:
        data = json.load(handle)

    def count(node):
        return 1 + sum(count(child) for child in node.get("children", []))

    log("convert", f"ok: {count(data['root'])} nodes, {len(data.get('warnings', []))} warnings, "
                   f"assets={len(data.get('assets', {}).get('textures', []))}tex/"
                   f"{len(data.get('assets', {}).get('fonts', []))}font")
    return True, json_path, shot_path


def stage_import(args, work: str, json_path: str) -> tuple[bool, str]:
    """Returns (ok, png_path). Tries with RHI so the widget can actually be rendered."""
    if args.mode == "editor":
        return stage_import_editor(args, work, json_path)

    png_path = os.path.join(work, "umg.png")
    base = [
        EDITOR_CMD, UPROJECT, "-run=Html2UMG",
        f"-json={json_path}",
        f"-blueprint={args.blueprint}",
        f"-viewport={args.viewport}",
        f"-out-png={png_path}",
        "-unattended", "-nosplash",
    ]
    if args.project_dir:
        base += [f"-abslog={os.path.join(work, 'editor.log')}"]
    # -nullrhi imports fine but leaves no renderer, so the fidelity PNG needs RHI.
    cmd = base + ["-RenderOffscreen", "-windowed", "-ResX=128", "-ResY=128"]
    log("import", " ".join(cmd))
    try:
        result = run(cmd, timeout=args.import_timeout, cwd=PROJECT_DIR)
    except subprocess.TimeoutExpired:
        log("import", f"TIMEOUT after {args.import_timeout}s")
        return False, png_path

    interesting = [ln for ln in (result.stdout or "").splitlines()
                   if any(k in ln for k in ("Html2UMG", "Error", "error", "Warning", "SUCCESS", "FAILED", "Widgets"))]
    for line in interesting[-40:]:
        log("import", line)
    if result.returncode != 0:
        log("import", f"exit={result.returncode}")
        return False, png_path
    if not os.path.isfile(png_path):
        log("import", "import succeeded but no PNG was rendered")
        return False, png_path
    return True, png_path


def stage_import_editor(args, work: str, json_path: str) -> tuple[bool, str]:
    """Import + render in ONE editor transaction.

    The full editor is required (not -run=): font-file import builds a Slate font atlas and
    FWidgetRenderer needs Slate/RHI, neither of which exists inside a commandlet.
    """
    png_path = os.path.join(work, "umg.png")
    log_path = os.path.join(work, "editor.log")
    if os.path.isfile(png_path):
        os.remove(png_path)

    # NOTE: Unreal splits -ExecCmds on COMMAS. A ';' would be swallowed into the last argument.
    exec_cmds = (f"Html2UMG.ImportAndRender {json_path} {args.blueprint} {png_path} {args.viewport}"
                 f", QUIT_EDITOR")
    cmd = [
        EDITOR_EXE, UPROJECT,
        f"-ExecCmds={exec_cmds}",
        "-unattended", "-nosplash", "-windowed", "-ResX=1280", "-ResY=720",
        f"-abslog={log_path}",
    ]
    log("import", " ".join(cmd))
    try:
        result = run(cmd, timeout=args.import_timeout, cwd=PROJECT_DIR)
    except subprocess.TimeoutExpired:
        log("import", f"TIMEOUT after {args.import_timeout}s")
        return False, png_path

    tail: list[str] = []
    if os.path.isfile(log_path):
        with open(log_path, "r", encoding="utf-8", errors="replace") as handle:
            for line in handle:
                if "LogHtml2UMG" in line or "Fatal error" in line or "Assertion failed" in line:
                    tail.append(line.rstrip())
    for line in tail[-30:]:
        log("import", line)

    if any("FAILED" in line for line in tail):
        return False, png_path
    if not os.path.isfile(png_path):
        log("import", "no PNG was written - see the editor log above")
        return False, png_path
    return True, png_path


def stage_diff(args, work: str, shot_path: str, png_path: str) -> bool:
    if not os.path.isfile(shot_path):
        log("diff", "missing browser screenshot; skipping comparison")
        return True
    cmd = [args.python, os.path.join(HERE, "pngdiff.py"), shot_path, png_path,
           "--out", os.path.join(work, "out.png")]
    if args.max_diff is not None:
        cmd += ["--max-diff", str(args.max_diff)]
    log("diff", " ".join(cmd))
    result = run(cmd, timeout=300)
    for line in (result.stdout or "").splitlines():
        log("diff", line)
    if result.returncode == 2:
        for line in (result.stderr or "").splitlines():
            log("diff", "stderr: " + line)
        return False
    return result.returncode == 0


def main(argv: list[str]) -> int:
    parser = argparse.ArgumentParser(description="Html2UMG acceptance run")
    parser.add_argument("--html", required=True)
    parser.add_argument("--blueprint", default="/Game/UI/Html2UMGTest/WBP_Acceptance")
    parser.add_argument("--viewport", default="1920x1080")
    parser.add_argument("--probe", default=None)
    parser.add_argument("--workdir", default=os.path.join(tempfile.gettempdir(), "h2u-acceptance"))
    parser.add_argument("--node", default="node")
    parser.add_argument("--python", default=sys.executable)
    parser.add_argument("--convert-timeout", type=int, default=180)
    parser.add_argument("--import-timeout", type=int, default=900)
    parser.add_argument("--max-diff", type=float, default=None)
    parser.add_argument("--mode", choices=["editor", "commandlet"], default="editor",
                        help="editor = full import+render in one editor transaction (fonts + png); "
                             "commandlet = headless -run=Html2UMG (layout + textures only)")
    parser.add_argument("--strict", action="store_true")
    parser.add_argument("--project-dir", action="store_true", default=True)
    parser.add_argument("--skip-convert", action="store_true")
    parser.add_argument("--skip-import", action="store_true")
    args = parser.parse_args(argv)
    args.blueprint = normalize_blueprint(args.blueprint)
    args.html = args.html.replace("\\", "/")

    if not os.path.isfile(UPROJECT):
        log("env", f"uproject not found: {UPROJECT}")
        return 2
    if not os.path.isfile(CONVERT_JS) and not args.skip_convert:
        log("env", f"converter not found: {CONVERT_JS}")
        return 2

    work = os.path.abspath(args.workdir)
    if os.path.isdir(work) and not args.skip_convert:
        shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work, exist_ok=True)
    log("env", f"workdir: {work}")

    started = time.time()
    json_path = os.path.join(work, "layout.json")
    shot_path = os.path.join(work, "browser.png")
    png_path = os.path.join(work, "umg.png")

    if not args.skip_convert:
        ok, json_path, shot_path = stage_convert(args, work)
        if not ok:
            print("\nRESULT: FAIL (convert)")
            return 1
    else:
        log("convert", f"skipped, using {json_path}")

    if not args.skip_import:
        ok, png_path = stage_import(args, work, json_path)
        if not ok:
            print("\nRESULT: FAIL (import)")
            return 1
    else:
        log("import", "skipped")

    ok = stage_diff(args, work, shot_path, png_path)
    elapsed = time.time() - started
    print(f"\nRESULT: {'PASS' if ok else 'FAIL (fidelity)'} in {elapsed:.0f}s")
    print(f"artifacts: {work}")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))

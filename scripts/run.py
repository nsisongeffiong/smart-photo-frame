#!/usr/bin/env python3
"""Project-local pipeline runner."""
import sys, os, subprocess
from pathlib import Path

PROJECT_ROOT = Path(__file__).parent.parent.resolve()

# Derive shared dir relative to project location: projects/<name>/scripts/run.py
# → scripts/ → project/ → projects/ → ai-workspace/ → .shared/
_derived = PROJECT_ROOT.parent.parent / ".shared"
SHARED_DIR   = Path(os.getenv("AI_WORKSPACE_SHARED", str(_derived)))
ORCHESTRATOR = SHARED_DIR / "orchestrate.py"
VENV_PYTHON  = SHARED_DIR / ".venv" / "bin" / "python3"

if not ORCHESTRATOR.exists():
    print(f"ERROR: Shared orchestrator not found at {ORCHESTRATOR}")
    print(f"       Set AI_WORKSPACE_SHARED env var if your workspace is in a non-standard location")
    sys.exit(1)

if len(sys.argv) < 2:
    print(f'Usage: python {Path(__file__).name} "task description"')
    print(f'       python {Path(__file__).name} --from-stage 3 "task description"')
    sys.exit(1)

# ── Initialise brand submodule if present but empty ──
brand_dir = PROJECT_ROOT / "brand"
if brand_dir.exists() and not any(brand_dir.iterdir()):
    print("[INFO]  Initialising brand submodule...")
    result = subprocess.run(
        ["git", "submodule", "update", "--init", "--recursive"],
        cwd=str(PROJECT_ROOT)
    )
    if result.returncode != 0:
        print("[WARN]  Brand submodule init failed -- pipeline will continue without brand assets")

env = {**os.environ, "PROJECT_ROOT": str(PROJECT_ROOT)}
result = subprocess.run([str(VENV_PYTHON), str(ORCHESTRATOR)] + sys.argv[1:], env=env, cwd=str(PROJECT_ROOT))
sys.exit(result.returncode)

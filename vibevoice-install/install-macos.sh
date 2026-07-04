#!/usr/bin/env bash
#
# install-macos.sh — Reproducible installer for Microsoft VibeVoice on macOS
#
# VibeVoice (https://github.com/microsoft/VibeVoice) is Microsoft's open-source
# frontier voice-AI family (text-to-speech + speech recognition). This script
# clones the repo, creates an isolated Python virtual environment, installs the
# `vibevoice` package with all dependencies, and verifies the install.
#
# Everything is installed OUTSIDE this git repository:
#   - source:  ~/VibeVoice          (override with $VIBEVOICE_DIR)
#   - venv:    ~/vibevoice-venv      (override with $VIBEVOICE_VENV)
#
# Usage:
#   bash install-macos.sh
#
# Re-running is safe: an existing clone is updated and an existing venv reused.

set -euo pipefail

REPO_URL="https://github.com/microsoft/VibeVoice.git"
TARGET_DIR="${VIBEVOICE_DIR:-$HOME/VibeVoice}"
VENV_DIR="${VIBEVOICE_VENV:-$HOME/vibevoice-venv}"

info() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[warn]\033[0m %s\n' "$*"; }
err()  { printf '\033[1;31m[error]\033[0m %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# 1. Platform check
# ---------------------------------------------------------------------------
if [[ "$(uname -s)" != "Darwin" ]]; then
  err "This installer targets macOS. Detected: $(uname -s)."
  err "On Linux/Windows, install with: python3 -m venv venv && venv/bin/pip install -e <clone>"
  exit 1
fi
ARCH="$(uname -m)"
if [[ "$ARCH" == "arm64" ]]; then
  info "macOS on Apple Silicon ($ARCH) — PyTorch will use MPS (Metal) acceleration."
else
  info "macOS on Intel ($ARCH) — PyTorch will run on CPU (no Metal acceleration)."
fi

# ---------------------------------------------------------------------------
# 2. Prerequisites: git + Python >= 3.10
# ---------------------------------------------------------------------------
if ! command -v git >/dev/null 2>&1; then
  err "git not found. Install the Xcode Command Line Tools first:  xcode-select --install"
  exit 1
fi

PYBIN=""
PYVER=""
for c in python3.12 python3.11 python3.10 python3; do
  if command -v "$c" >/dev/null 2>&1; then
    ver="$("$c" -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || echo "0.0")"
    major="${ver%%.*}"
    minor="${ver##*.}"
    if [[ "$major" -eq 3 && "$minor" -ge 10 ]]; then
      PYBIN="$c"; PYVER="$ver"; break
    fi
  fi
done
if [[ -z "$PYBIN" ]]; then
  err "Python >= 3.10 not found (VibeVoice requires it)."
  err "Install one, e.g.:  brew install python@3.11   (or use pyenv)"
  exit 1
fi
info "Using $PYBIN (Python $PYVER)"

# ffmpeg is optional but improves pydub's audio format support.
if ! command -v ffmpeg >/dev/null 2>&1; then
  warn "ffmpeg not found (optional; pydub uses it for some audio formats). Install: brew install ffmpeg"
fi

# ---------------------------------------------------------------------------
# 3. Clone (or update) the VibeVoice source
# ---------------------------------------------------------------------------
if [[ -d "$TARGET_DIR/.git" ]]; then
  info "Updating existing clone at $TARGET_DIR"
  git -C "$TARGET_DIR" pull --ff-only || warn "Could not fast-forward; keeping existing checkout."
else
  info "Cloning VibeVoice into $TARGET_DIR"
  git clone --depth 1 "$REPO_URL" "$TARGET_DIR"
fi

# ---------------------------------------------------------------------------
# 4. Virtual environment
# ---------------------------------------------------------------------------
if [[ ! -d "$VENV_DIR" ]]; then
  info "Creating virtual environment at $VENV_DIR"
  "$PYBIN" -m venv "$VENV_DIR"
else
  info "Reusing existing virtual environment at $VENV_DIR"
fi
VPY="$VENV_DIR/bin/python"

# ---------------------------------------------------------------------------
# 5. Install dependencies
# ---------------------------------------------------------------------------
info "Upgrading pip / setuptools / wheel"
"$VPY" -m pip install --upgrade pip setuptools wheel

# On macOS the default PyPI torch wheel is the right one:
#   - Apple Silicon -> arm64 wheel with MPS (Metal) support
#   - Intel         -> x86_64 CPU wheel
info "Installing PyTorch"
"$VPY" -m pip install torch

info "Installing vibevoice (editable) + remaining dependencies"
"$VPY" -m pip install -e "$TARGET_DIR"

# ---------------------------------------------------------------------------
# 6. Verify
# ---------------------------------------------------------------------------
info "Verifying installation"
"$VPY" - <<'PY'
import importlib
import torch

for m in ("torch", "transformers", "diffusers", "vibevoice"):
    mod = importlib.import_module(m)
    print(f"  OK  {m:12s} {getattr(mod, '__version__', '(installed)')}")

if torch.backends.mps.is_available():
    device = "mps (Apple Silicon / Metal)"
elif torch.cuda.is_available():
    device = "cuda"
else:
    device = "cpu"
print(f"  torch device available: {device}")
PY

# ---------------------------------------------------------------------------
# 7. Next steps
# ---------------------------------------------------------------------------
cat <<EOF

$(info "VibeVoice installed successfully.")

  Source repo:  $TARGET_DIR
  Virtualenv:   $VENV_DIR

Always run through the venv's interpreter, for example:

  $VENV_DIR/bin/python $TARGET_DIR/demo/vibevoice_asr_inference_from_file.py --help

Model weights are downloaded automatically from HuggingFace on first run
(several GB; see the microsoft/vibevoice-* collection). Demos available in:

  $TARGET_DIR/demo/

Docs:

  $TARGET_DIR/docs/  (vibevoice-tts.md, vibevoice-asr.md, vibevoice-realtime-0.5b.md, setup_gradio_demo.md)
EOF

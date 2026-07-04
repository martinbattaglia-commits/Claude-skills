# VibeVoice — reproducible install

Helper to install [Microsoft **VibeVoice**](https://github.com/microsoft/VibeVoice)
on your own machine. VibeVoice is Microsoft's open-source frontier voice-AI
family: long-form, multi-speaker **text-to-speech** plus **speech recognition**
(ASR).

> This lives inside the `claude-seo` repo only as a convenience installer — it
> is a standalone tool and is not part of the SEO skill itself. Nothing here
> downloads model weights or vendors VibeVoice's source into this repo; the
> script clones upstream and installs into your home directory.

## macOS (MacBook)

```bash
bash vibevoice-install/install-macos.sh
```

What it does:

1. Verifies you're on macOS with `git` and **Python ≥ 3.10**.
2. Clones VibeVoice into `~/VibeVoice` (or `$VIBEVOICE_DIR`).
3. Creates a virtualenv at `~/vibevoice-venv` (or `$VIBEVOICE_VENV`).
4. Installs **PyTorch** (Apple Silicon gets the MPS/Metal build automatically;
   Intel gets the CPU build) and the `vibevoice` package with all dependencies.
5. Verifies that `torch`, `transformers`, `diffusers`, and `vibevoice` import,
   and reports the available compute device (`mps` / `cuda` / `cpu`).

Re-running is safe: an existing clone is fast-forwarded and an existing venv is
reused.

### Custom locations

```bash
VIBEVOICE_DIR="$HOME/code/VibeVoice" VIBEVOICE_VENV="$HOME/.venvs/vibevoice" \
  bash vibevoice-install/install-macos.sh
```

## Using it after install

Always call the venv's Python:

```bash
~/vibevoice-venv/bin/python ~/VibeVoice/demo/vibevoice_asr_inference_from_file.py --help
```

Demos live in `~/VibeVoice/demo/`:

| Script | Purpose |
|---|---|
| `vibevoice_asr_inference_from_file.py` | Speech-to-text (ASR) from an audio file |
| `vibevoice_asr_gradio_demo.py` | ASR with a Gradio web UI |
| `vibevoice_realtime_demo.py` | Real-time / streaming TTS demo |
| `realtime_model_inference_from_file.py` | TTS inference from a text file |

Reference docs are in `~/VibeVoice/docs/` (`vibevoice-tts.md`,
`vibevoice-asr.md`, `vibevoice-realtime-0.5b.md`, `setup_gradio_demo.md`).

## Notes

- **Model weights** are **not** installed by this script. They download
  automatically from HuggingFace on first run (several GB — see the
  [`microsoft/vibevoice-*` collection](https://huggingface.co/collections/microsoft/vibevoice-68a2ef24a875c44be47b034f)).
- **Apple Silicon** gives real acceleration via **MPS (Metal)**. On Intel Macs
  everything runs on CPU, which is slow for the diffusion-based TTS model.
- `ffmpeg` is optional (`brew install ffmpeg`); `pydub` uses it for some audio
  formats.

### Verified environment

The install flow was verified end-to-end (import-level) with these versions;
pins are intentionally left loose so macOS resolves platform-correct wheels:

| Package | Version |
|---|---|
| Python | 3.11 |
| torch | 2.12.1 |
| transformers | 4.57.6 |
| diffusers | 0.39.0 |
| vibevoice | 1.0.0 |

"""
Remote MuseTalk inference server (for GPU hosts like AutoDL).

Wraps the same inference logic as musetalk_worker.py (models loaded once,
reused across requests) behind a small HTTP API so a CPU-only backend
elsewhere can use it as AVATAR_ENGINE=musetalk_remote.

Run on the GPU box (from the ai-avatar-system repo root, or the MuseTalk
clone root — both work):

    pip install fastapi uvicorn python-multipart
    export MUSETALK_TOKEN=$(python -c "import secrets; print(secrets.token_hex(32))")
    python musetalk_server.py --port 6006

Expose the port (AutoDL: 控制台 → 自定义服务 → 6006, or an SSH tunnel) and
point the backend at it:

    MUSETALK_REMOTE_URL=https://xxxx.mu.tunnel  (or http://localhost:6006 via tunnel)
    MUSETALK_REMOTE_TOKEN=<same MUSETALK_TOKEN>

API:
    GET  /health          -> {"status": "loading"|"ready", "device": "cuda:0", ...}
    POST /animate         -> multipart form: image=<file>, audio=<file>, image_hash=<str>
                             returns video/mp4 stream
"""
import argparse
import hashlib
import logging
import os
import sys
import tempfile
import threading
from pathlib import Path

import uvicorn
from fastapi import Depends, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger("musetalk_server")

TOKEN = os.environ.get("MUSETALK_TOKEN", "")
STATE: dict = {"ready": False, "error": None, "device": None}

# Model handles, populated by _load_models() on startup.
_MODELS: dict = {}


# ── auth ──────────────────────────────────────────────────────────────────────

def _check_token(authorization: str) -> None:
    """Bearer-token guard. 401 on mismatch; also 500-ish if no token was set."""
    if not TOKEN:
        raise HTTPException(status_code=500, detail="MUSETALK_TOKEN env var not set on server")
    expected = f"Bearer {TOKEN}"
    if authorization != expected:
        raise HTTPException(status_code=401, detail="invalid or missing token")


# ── model loading (mirrors musetalk_worker.py main()) ─────────────────────────

def _find_musetalk_dir() -> Path:
    """Locate the MuseTalk clone. Checks, in order:
    1. $MUSETALK_PATH (absolute or relative to cwd)
    2. ./models/MuseTalk relative to this file (repo layout: backend/models/MuseTalk)
    3. ./MuseTalk relative to cwd (running from inside the clone's parent)
    4. cwd itself (running from inside the clone root — scripts/setup_musetalk.sh
       copies musetalk_worker.py there, so this file may live there too)
    """
    candidates = []
    env_path = os.environ.get("MUSETALK_PATH", "")
    if env_path:
        candidates.append(Path(env_path))
    candidates.append(Path(__file__).resolve().parent / "models" / "MuseTalk")
    candidates.append(Path.cwd() / "MuseTalk")
    candidates.append(Path.cwd())

    for p in candidates:
        if (p / "scripts" / "inference.py").exists() or (p / "musetalk").is_dir():
            return p.resolve()
    raise FileNotFoundError(
        "MuseTalk clone not found — run scripts/setup_musetalk.sh first, or set "
        "MUSETALK_PATH. Tried: " + ", ".join(str(c) for c in candidates)
    )


def _load_models() -> None:
    """Load all MuseTalk models into (GPU) memory once. Heavy: ~60s on GPU."""
    import torch  # local import so --help / tests don't pay for torch import
    from transformers import WhisperModel

    try:
        # Locate the clone and put it on sys.path BEFORE importing musetalk.*
        # (order matters — importing first fails with ModuleNotFoundError).
        musetalk_dir = _find_musetalk_dir()
        sys.path.insert(0, str(musetalk_dir))
        # MuseTalk internals use cwd-relative model paths (e.g.
        # './models/face-parse-bisent/...'), so mirror the worker's behaviour
        # and run from inside the clone.
        os.chdir(musetalk_dir)

        from musetalk.utils.audio_processor import AudioProcessor
        from musetalk.utils.face_parsing import FaceParsing
        from musetalk.utils.utils import load_all_model as _lam

        device = torch.device("cuda:0" if torch.cuda.is_available() else "cpu")
        STATE["device"] = str(device)
        use_float16 = device.type == "cuda"

        models_dir = musetalk_dir / "models"
        vae, unet, pe = _lam(
            unet_model_path=str(models_dir / "musetalkV15" / "unet.pth"),
            vae_type=str(models_dir / "sd-vae"),
            unet_config=str(models_dir / "musetalkV15" / "musetalk.json"),
            device=device,
        )
        if use_float16:
            pe = pe.half()
            vae.vae = vae.vae.half()
            unet.model = unet.model.half()
            logger.info("float16 enabled — ~2x faster on GPU")
        pe = pe.to(device)
        vae.vae = vae.vae.to(device)
        unet.model = unet.model.to(device)

        weight_dtype = unet.model.dtype
        whisper_dir = str(models_dir / "whisper")
        audio_processor = AudioProcessor(feature_extractor_path=whisper_dir)
        whisper = WhisperModel.from_pretrained(whisper_dir)
        whisper = whisper.to(device=device, dtype=weight_dtype).eval()
        whisper.requires_grad_(False)

        _MODELS.update(
            vae=vae,
            unet=unet,
            pe=pe,
            audio_processor=audio_processor,
            whisper=whisper,
            fp=FaceParsing(),
            timesteps=torch.tensor([0], device=device),
            device=device,
            weight_dtype=weight_dtype,
        )
        STATE["ready"] = True
        logger.info(f"MuseTalk models ready on {device} (dir={musetalk_dir})")
    except Exception as e:
        STATE["error"] = f"{e}"
        logger.exception("Model loading FAILED — /animate will return 503")


# ── inference (mirrors musetalk_worker.py _run_job) ───────────────────────────

_INFER_LOCK = threading.Lock()  # one job at a time; models are not reentrant


def _run_inference(image_path: str, audio_path: str, output_path: str, coord_cache: str) -> None:
    import copy
    import pickle
    import shutil

    import cv2
    import numpy as np
    import torch

    from musetalk.utils.blending import get_image
    from musetalk.utils.preprocessing import coord_placeholder, get_landmark_and_bbox, read_imgs

    FPS = 25
    EXTRA_MARGIN = 10
    BATCH_SIZE = 8
    AUDIO_PAD_L = 2
    AUDIO_PAD_R = 2

    m = _MODELS
    vae, unet, pe = m["vae"], m["unet"], m["pe"]
    audio_processor, whisper, fp = m["audio_processor"], m["whisper"], m["fp"]
    timesteps, device, weight_dtype = m["timesteps"], m["device"], m["weight_dtype"]

    # face coordinates — cached per avatar (client sends the same hash each time)
    if coord_cache and os.path.exists(coord_cache):
        with open(coord_cache, "rb") as f:
            coord_list = list(pickle.load(f))
        frame_list = list(read_imgs([image_path]))
    else:
        _coords, _frames = get_landmark_and_bbox([image_path], 0)
        coord_list, frame_list = list(_coords), list(_frames)
        if coord_cache:
            os.makedirs(os.path.dirname(coord_cache), exist_ok=True)
            with open(coord_cache, "wb") as f:
                pickle.dump(coord_list, f)

    if not frame_list or all(c == coord_placeholder for c in coord_list):
        raise RuntimeError("No face detected in avatar image")

    # audio features
    whisper_input_features, librosa_length = audio_processor.get_audio_feature(audio_path)
    whisper_chunks = audio_processor.get_whisper_chunk(
        whisper_input_features, device, weight_dtype, whisper, librosa_length,
        fps=FPS,
        audio_padding_length_left=AUDIO_PAD_L,
        audio_padding_length_right=AUDIO_PAD_R,
    )

    # VAE-encode face crops
    input_latent_list = []
    for bbox, frame in zip(coord_list, frame_list):
        if bbox == coord_placeholder:
            continue
        x1, y1, x2, y2 = bbox
        y2 = min(y2 + EXTRA_MARGIN, frame.shape[0])
        crop = cv2.resize(frame[y1:y2, x1:x2], (256, 256), interpolation=cv2.INTER_LANCZOS4)
        input_latent_list.append(vae.get_latents_for_unet(crop))

    if not input_latent_list:
        raise RuntimeError("No valid face crops produced")

    frame_list_cycle = frame_list + list(reversed(frame_list))
    coord_list_cycle = coord_list + list(reversed(coord_list))
    latent_list_cycle = input_latent_list + list(reversed(input_latent_list))

    from musetalk.utils.utils import datagen

    gen = datagen(
        whisper_chunks=whisper_chunks,
        vae_encode_latents=latent_list_cycle,
        batch_size=BATCH_SIZE,
        delay_frame=0,
        device=device,
    )
    res_frame_list = []
    for whisper_batch, latent_batch in gen:
        audio_feat = pe(whisper_batch)
        latent_batch = latent_batch.to(dtype=weight_dtype)
        pred = unet.model(latent_batch, timesteps, encoder_hidden_states=audio_feat).sample
        for f in vae.decode_latents(pred):
            res_frame_list.append(f)

    # blend back + assemble video (ffmpeg, same as the worker)
    frames_dir = output_path + "_frames"
    os.makedirs(frames_dir, exist_ok=True)
    for i, res_frame in enumerate(res_frame_list):
        bbox = coord_list_cycle[i % len(coord_list_cycle)]
        ori = copy.deepcopy(frame_list_cycle[i % len(frame_list_cycle)])
        x1, y1, x2, y2 = bbox
        y2 = min(y2 + EXTRA_MARGIN, ori.shape[0])
        try:
            res_frame = cv2.resize(res_frame.astype(np.uint8), (x2 - x1, y2 - y1))
        except Exception:
            continue
        combined = get_image(ori, res_frame, [x1, y1, x2, y2], mode="jaw", fp=fp)
        cv2.imwrite(f"{frames_dir}/{str(i).zfill(8)}.png", combined)

    tmp_vid = output_path + ".tmp.mp4"
    os.system(f"ffmpeg -y -v warning -r {FPS} -f image2 -i {frames_dir}/%08d.png "
              f"-vcodec libx264 -vf format=yuv420p -crf 18 {tmp_vid}")
    os.system(f"ffmpeg -y -v warning -i {audio_path} -i {tmp_vid} {output_path}")
    shutil.rmtree(frames_dir, exist_ok=True)
    if os.path.exists(tmp_vid):
        os.remove(tmp_vid)


# ── FastAPI app ───────────────────────────────────────────────────────────────

app = FastAPI(title="MuseTalk Remote Server", docs_url=None, redoc_url=None)


@app.get("/health")
async def health():
    if STATE["error"]:
        return JSONResponse({"status": "error", "detail": STATE["error"]}, status_code=500)
    return {
        "status": "ready" if STATE["ready"] else "loading",
        "device": STATE["device"],
        "float16": STATE.get("float16", False),
    }


@app.post("/animate")
async def animate(
    image: UploadFile = File(...),
    audio: UploadFile = File(...),
    image_hash: str = Form(""),
    authorization: str = Depends(_check_token),
):
    if not STATE["ready"]:
        detail = STATE["error"] or "models still loading"
        raise HTTPException(status_code=503, detail=detail)

    with tempfile.TemporaryDirectory(prefix="mt_") as td:
        image_path = os.path.join(td, "in_image" + Path(image.filename or "img").suffix)
        audio_path = os.path.join(td, "in_audio" + Path(audio.filename or "wav").suffix)
        output_path = os.path.join(td, "out.mp4")

        # Stream uploads to disk — avatar photos are ~MBs, audio tens of KBs.
        with open(image_path, "wb") as f:
            f.write(await image.read())
        with open(audio_path, "wb") as f:
            f.write(await audio.read())

        # Per-avatar coord cache keyed by client-supplied hash of the image path.
        # Same avatar → face landmark detection skipped on every subsequent call.
        coord_cache = ""
        if image_hash:
            cache_dir = Path("coord_cache")
            cache_dir.mkdir(exist_ok=True)
            coord_cache = str(cache_dir / f"{image_hash}.pkl")

        # Models are loaded in the startup thread below; inference itself runs
        # in a worker thread so the event loop stays responsive during ~5-15s jobs.
        with _INFER_LOCK:
            try:
                await asyncio_to_thread(_run_inference, image_path, audio_path, output_path, coord_cache)
            except Exception as e:
                logger.exception("Inference failed")
                raise HTTPException(status_code=500, detail=str(e))

        if not os.path.exists(output_path):
            raise HTTPException(status_code=500, detail="inference produced no output")

        return FileResponse(output_path, media_type="video/mp4", filename="animated.mp4")


# uvicorn runs the app in an event loop; heavy model loading must not block it.
import asyncio  # noqa: E402  (placed here so --help stays fast)

def asyncio_to_thread(func, *args):
    return asyncio.get_event_loop().run_in_executor(None, lambda: func(*args))


@app.on_event("startup")
async def _startup():
    threading.Thread(target=_load_models, daemon=True).start()


def main():
    parser = argparse.ArgumentParser(description="Remote MuseTalk inference server")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=int(os.environ.get("MUSETALK_PORT", "6006")))
    args = parser.parse_args()

    if not TOKEN:
        logger.warning(
            "MUSETALK_TOKEN not set — /animate endpoints will refuse requests. "
            "Generate one with: python -c \"import secrets; print(secrets.token_hex(32))\""
        )

    logger.info(f"Starting MuseTalk remote server on {args.host}:{args.port}")
    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()

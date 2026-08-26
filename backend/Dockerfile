FROM nvidia/cuda:11.8.0-cudnn8-runtime-ubuntu22.04

ENV DEBIAN_FRONTEND=noninteractive
WORKDIR /app

# Install Python 3.10 + system dependencies
RUN apt-get update && apt-get install -y \
    python3.10 \
    python3.10-dev \
    python3-pip \
    ffmpeg \
    libsm6 \
    libxext6 \
    libxrender-dev \
    libgomp1 \
    git \
    wget \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    && ln -sf python3.10 /usr/bin/python3 \
    && ln -sf python3 /usr/bin/python \
    && ln -sf pip3 /usr/bin/pip

# Copy requirements + pre-downloaded wheels.
# The wheels/ dir is populated on the host (pip download for cp310/manylinux)
# because in-build downloads kept corrupting on this network. Installing
# offline (--no-index) makes the build deterministic and network-independent.
# chatterbox-tts installs with --no-deps: its metadata hard-pins torch 2.6 /
# diffusers 0.29, conflicting with this stack; its real imports are in wheels/.
# torch is the CPU build — MuseTalk runs on a remote GPU server
# (AVATAR_ENGINE=musetalk_remote), local torch only serves whisper int8 and
# the chatterbox TTS fallback.
COPY requirements.txt ./
COPY wheels/ ./wheels/
RUN grep -vE '^(chatterbox-tts)' requirements.txt > req.nodeps.txt && \
    pip install --no-cache-dir --no-index --find-links=wheels \
      torch==2.2.0+cpu torchvision==0.17.0+cpu torchaudio==2.2.0+cpu && \
    pip install --no-cache-dir --no-index --find-links=wheels \
      -r req.nodeps.txt && \
    pip install --no-cache-dir --no-index --no-deps --find-links=wheels \
      chatterbox-tts==0.1.2

# Copy application code
COPY . .

# Create necessary directories
RUN mkdir -p /tmp/avatars /tmp/videos /tmp/audio voice_profiles

# Entrypoint: run migrations then start server
COPY entrypoint.sh .
RUN chmod +x entrypoint.sh

# Expose port
EXPOSE 8000

# Health check — longer start-period for model loading on first boot
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=5 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://localhost:8000/health')"

# Run application via entrypoint (handles migrations automatically)
CMD ["./entrypoint.sh"]

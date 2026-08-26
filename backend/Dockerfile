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

# Copy requirements
COPY requirements.txt .

# Install Python dependencies. chatterbox-tts is excluded here and installed
# with --no-deps below: its wheels hard-pin torch==2.6.0/diffusers==0.29.0,
# which conflicts with this project's torch 2.2 stack. Its other runtime
# imports are listed explicitly in requirements.txt.
# torch is excluded and pinned to the CPU wheel below — this deployment runs
# MuseTalk on a REMOTE GPU server (AVATAR_ENGINE=musetalk_remote); the local
# backend only needs CPU torch (whisper int8 / chatterbox fallback), and the
# CUDA wheels are 4x larger and repeatedly failed to download intact.
RUN grep -vE '^(chatterbox-tts|torch==|torchvision==|torchaudio==)' requirements.txt > req.nodeps.txt && \
    pip install --no-cache-dir --retries 10 --timeout 90 \
      torch==2.2.0+cpu torchvision==0.17.0+cpu torchaudio==2.2.0+cpu \
      --index-url https://download.pytorch.org/whl/cpu && \
    pip install --no-cache-dir --retries 10 --timeout 90 \
      -i https://mirrors.aliyun.com/pypi/simple/ \
      -r req.nodeps.txt && \
    pip install --no-cache-dir --no-deps \
      -i https://mirrors.aliyun.com/pypi/simple/ \
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

# QuChen, built FROM SOURCE (NVIDIA CUDA 13). The engine is compiled here, packaged as an engine component package and then
# installed into the same runtime image as the ready-made ones (docker/Dockerfile): same Terminal, same entrypoint, same /data volume.
#
# Most people want the ready-made images instead (nothing compiled): docs/DOCKER.md.
#
#   docker build -t quchen:src .                                        # RTX 20/30/40/50 (compiles for each, ~25 min)
#   docker build -t quchen:src --build-arg CUDA_ARCHITECTURES=86 .      # one card only (faster); 86 = RTX 30, 89 = RTX 40, 120 = RTX 50
#   docker build -t quchen:src-cuda12 --build-arg CUDA_IMAGE=nvidia/cuda:12.9.1-devel-ubuntu24.04 \
#              --build-arg CUDA_ARCHITECTURES="60;61;70;75;80;86;89" --build-arg BUILD_VISION=0 .   # GTX 10 / P100 / V100 (driver 575+)
#   docker run --rm --gpus all -p 127.0.0.1:8080:8080 --ulimit memlock=-1 --shm-size 2g --stop-timeout 120 \
#              -v quchen-data:/data -e MODEL=IQ3_XXS -e API_KEY=change-me-please-123 quchen:src
#
# docker build has no GPU, so the CUDA architectures are given here instead of read from nvidia-smi. The engine is a fat binary with
# a machine-code part per listed architecture (plus PTX for the newest, which later cards can JIT), and the runtime picks the one
# matching your card. Narrow CUDA_ARCHITECTURES to your card for a faster build. Native code for the CPU that builds the image is NOT
# used (QUCHEN_PORTABLE=ON), so the image runs on any x86-64 CPU with AVX2.
#
# Plain legacy-builder features only (no heredocs, no --mount). AMD (HIP) and Intel (SYCL) source builds: docs/AMD_HIP.md, docs/INTEL.md.

ARG CUDA_IMAGE=nvidia/cuda:13.0.0-devel-ubuntu24.04
ARG RUNTIME_BASE=ubuntu:24.04

# ---- 1. compile the engine and make its component package
FROM ${CUDA_IMAGE} AS engine-build
ENV DEBIAN_FRONTEND=noninteractive PYTHONUNBUFFERED=1 PATH=/venv/bin:$PATH
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential ca-certificates git libgomp1 libatomic1 python3 python3-pip python3-venv unzip \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /src
COPY . .
ARG CUDA_ARCHITECTURES="75;80;86;89;120"
ARG BUILD_VISION=1
ARG ENGINE_VERSION=
RUN python3 -m venv /venv && /venv/bin/pip install --no-cache-dir -r requirements.txt -r requirements-build.txt
# llama.cpp at the pinned commit (ggml for the engine, mtmd for pictures), exactly as setup.py fetches it
RUN /venv/bin/python -c "import setup; print(setup.get_llama_cpp())"
RUN set -e; \
    real=""; for a in $(echo "$CUDA_ARCHITECTURES" | tr ';,' '  '); do real="$real;${a}-real"; done; real=${real#;}; \
    last=$(echo "$CUDA_ARCHITECTURES" | tr ';,' '  ' | awk '{print $NF}'); \
    sm60=OFF; for a in $(echo "$CUDA_ARCHITECTURES" | tr ';,' '  '); do if [ "$a" -lt 75 ]; then sm60=ON; fi; done; \
    /venv/bin/cmake -G Ninja -S . -B build -DCMAKE_BUILD_TYPE=Release -DQUCHEN_ENABLE_CUDA=ON -DQUCHEN_BUILD_TESTS=OFF \
        -DQUCHEN_EXPERIMENTAL_SM60=$sm60 \
        -DQUCHEN_NATIVE_EXPERTS=ON -DQUCHEN_PORTABLE=ON -DQUCHEN_Q6K_EXPERTS=ON -DQUCHEN_MMQ_KQUANTS=ON \
        "-DCMAKE_CUDA_ARCHITECTURES=${real};${last}-virtual" -DQUCHEN_GGML_DIR=/src/third_party/llama.cpp; \
    /venv/bin/cmake --build build --target quchen quchen_kq -j "$(nproc)"; \
    if [ "$BUILD_VISION" = "1" ]; then \
      /venv/bin/cmake -G Ninja -S tools/vision -B build-vision -DCMAKE_BUILD_TYPE=Release -DLLAMA_DIR=/src/third_party/llama.cpp \
          -DQUCHEN_VISION_CUDA=ON -DQUCHEN_PORTABLE=ON -DGGML_CUDA_NCCL=OFF "-DCMAKE_CUDA_ARCHITECTURES=${real};${last}-virtual"; \
      /venv/bin/cmake --build build-vision --target quchen-vision -j "$(nproc)"; \
    fi
RUN set -e; \
    mkdir -p /stage /engine; \
    cp build/quchen /stage/; \
    [ -f build/libquchen_kq.so ] && cp build/libquchen_kq.so /stage/ || true; \
    [ -f build-vision/bin/quchen-vision ] && cp build-vision/bin/quchen-vision /stage/ || true; \
    ver="${ENGINE_VERSION:-$(sed -n 's/^[[:space:]]*project([^)]*VERSION[[:space:]]*\([0-9][0-9.]*\).*/\1/p' CMakeLists.txt | head -1)}"; \
    cudafull=$(nvcc --version | sed -n 's/.*release \([0-9][0-9]*\.[0-9][0-9]*\).*/\1/p' | head -1); cudamajor=${cudafull%%.*}; \
    if [ "$cudamajor" = 13 ]; then mindriver=580.65; else mindriver=575.51; fi; \
    vision_archs=""; [ -f /stage/quchen-vision ] && vision_archs=", \"vision_archs\": \"$CUDA_ARCHITECTURES\""; \
    echo "{\"version\": \"$ver\", \"source\": \"docker build\", \"archs\": \"$CUDA_ARCHITECTURES\", \"cuda\": \"$cudafull\", \"portable\": true${vision_archs}}" > /stage/BUILD.json; \
    python3 packaging/collect_libs.py --binary build/quchen --search /usr/local/cuda/lib64 --out /stage --also 'libcublasLt.so*'; \
    archs=""; for a in $(echo "$CUDA_ARCHITECTURES" | tr ';,' '  '); do archs="$archs --arch sm_$a"; done; \
    last=$(echo "$CUDA_ARCHITECTURES" | tr ';,' '  ' | awk '{print $NF}'); \
    python3 packaging/package_engine.py --src /stage --backend cuda --version "$ver" --out /engine $archs --arch "compute_$last" \
        --min-driver nvidia=$mindriver --variant cuda$cudamajor --platform linux-x86_64 --build-id "docker-source-${ver}-cuda${cudafull}" --include SYSTEM-LIBS.txt --include 'libquchen_kq*' \
        --include quchen-vision; \
    for d in /engine/*/; do python3 packaging/package_engine.py --verify "$d"; python3 packaging/binary_deps.py "$d"; done

# ---- 2. the Terminal (the release archive, built here)
FROM ${RUNTIME_BASE} AS terminal
ARG QUCHEN_COMMIT=
ENV QUCHEN_BUILD_COMMIT=${QUCHEN_COMMIT}
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates git && rm -rf /var/lib/apt/lists/*
COPY . /src/
RUN python3 /src/packaging/package_terminal.py --out /out --cache /cache \
 && mkdir -p /opt/quchen \
 && tar -xzf /out/quchen-terminal-*-linux-x86_64.tar.gz -C /opt/quchen \
 && mv /opt/quchen/quchen-terminal-* /opt/quchen/terminal \
 && /opt/quchen/terminal/bin/quchen --version
# llama.cpp at the commit setup.py pins: fetched here, so the first start does not depend on GitHub. Only gguf-py (the model preparation
# tools) and the file setup.py looks for (ggml/CMakeLists.txt) are kept: 170 MB become a few
RUN cd /opt/quchen/terminal && QUCHEN_CONTROL_INSTALL=1 QUCHEN_INSTALL_DIR=/opt/quchen/seed PYTHONNOUSERSITE=1 \
      /opt/quchen/terminal/python/bin/python3 -c "import setup; print(setup.get_llama_cpp())" \
 && rm -rf /opt/quchen/seed/third_party/*.zip* \
 && cd /opt/quchen/seed/third_party/llama.cpp \
 && find . -mindepth 1 -maxdepth 1 ! -name gguf-py ! -name ggml ! -name 'LICENSE*' -exec rm -rf {} + \
 && find ggml -mindepth 1 -depth ! -type d ! -name CMakeLists.txt -delete && find ggml -mindepth 1 -type d -empty -delete \
 && du -sh /opt/quchen/seed

# ---- 3. the runtime image (the same as docker/Dockerfile's, FLAVOR=cuda)
FROM ${RUNTIME_BASE}
ARG QUCHEN_VERSION=dev
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends tini ca-certificates libgomp1 libatomic1 libnuma1 zlib1g \
    && rm -rf /var/lib/apt/lists/* /var/cache/apt/*
COPY --from=terminal /opt/quchen/terminal /opt/quchen/terminal
COPY --from=terminal /opt/quchen/seed /opt/quchen/seed
COPY --from=engine-build /engine/ /opt/quchen/components/engine/
COPY docker/entrypoint.sh docker/healthcheck.sh /opt/quchen/
COPY docker/quchen-wrapper.sh /usr/local/bin/quchen
RUN chmod 0755 /opt/quchen/entrypoint.sh /opt/quchen/healthcheck.sh /usr/local/bin/quchen
ENV QUCHEN_COMPONENTS_DIR=/opt/quchen/components QUCHEN_INSTALL_DIR=/data/install XDG_STATE_HOME=/data/state \
    XDG_CONFIG_HOME=/data/config HOME=/data/home PORT=8080 LANG=C.UTF-8 PYTHONUNBUFFERED=1 PYTHONNOUSERSITE=1 QUCHEN_IN_DOCKER=1 \
    NVIDIA_VISIBLE_DEVICES=all NVIDIA_DRIVER_CAPABILITIES=compute,utility
VOLUME ["/data"]
EXPOSE 8080
LABEL org.opencontainers.image.title="QuChen" com.quchen.flavor="cuda" com.quchen.build="from-source" org.opencontainers.image.version="${QUCHEN_VERSION}"
HEALTHCHECK --interval=30s --timeout=8s --start-period=2h --retries=3 CMD ["/opt/quchen/healthcheck.sh"]
STOPSIGNAL SIGTERM
ENTRYPOINT ["/usr/bin/tini", "--", "/opt/quchen/entrypoint.sh"]
CMD ["run"]

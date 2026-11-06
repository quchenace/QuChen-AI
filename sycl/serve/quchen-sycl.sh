#!/usr/bin/env bash
# quchen-sycl.sh: the SYCL-built engine as a drop-in `exe` for serve/server.py (--engine quchen). The port's binary
# needs the oneAPI runtime of the dev image, so this runs it there with stdin/stdout attached (the serve protocol is
# lines on those pipes) and stderr going to the server's log. Paths in the config's args are the container's:
# the data root is mounted at /work.
#   QUCHEN_SYCL_ROOT   host directory mounted at /work        (default: two levels above this script's repo)
#   QUCHEN_SYCL_IMAGE  the runtime image                      (default: quchen-sycl-dev)
#   QUCHEN_SYCL_BIN    the engine binary, relative to the repo (default: build-sycl-aot/quchen)
#   QUCHEN_SYCL_NAME   the container's name                   (default: quchen-sycl-serve)
#   QUCHEN_SYCL_SHM    1 (default): the host's /dev/shm is the container's /dev/shm. Pictures: the server (on the host) writes the
#                      image embeddings of a request into /dev/shm and names that file on the engine's GENI line, so the engine in
#                      the container must see the same file. 0: the container keeps a private /dev/shm.
# Passed into the container: every variable of this script's environment that starts with QUCHEN_ (the config's
# "env" block arrives that way: the server puts it in the engine's environment), ONEAPI_ (level_zero:* for a
# two-card split, #423), UR_, IGC_, SYCL_ or ZES_. The port's own defaults (below) are overridden the same way,
# e.g. "env": {"QUCHEN_VERIFY_NO_HOST": "0"} in the config.
set -euo pipefail
here=$(cd "$(dirname "$0")/../.." && pwd)                 # the repo
root=${QUCHEN_SYCL_ROOT:-$(dirname "$here")}
repo_in=/work/$(basename "$here")
name=${QUCHEN_SYCL_NAME:-quchen-sycl-serve}
docker rm -f "$name" >/dev/null 2>&1 || true              # a container left behind by a killed server
args=""
for a in "$@"; do args+=" $(printf '%q' "$a")"; done
# the port's run-time switches: the device-built verify plan, and no host handshakes in it. NO_HOST is for a card on
# the xe driver (the host<->GPU flag stores are not visible there); an i915 card (Arc A-series) runs without it
# (docs/INTEL.md)
# QUCHEN_CACHE_DIR: the engine's measurements that outlive a run (the int8 prompt experts' crossover, measured at
# the first prompt of each format: ~1.4 s of a B70's first 2K prompt) - under the mounted data root, not in the
# throwaway container's home
declare -A setting=([QUCHEN_VERIFY_DEVICE_PLAN]=1 [QUCHEN_VERIFY_NO_HOST]=1 [QUCHEN_STAGER_THREADS]=12
                    [QUCHEN_CACHE_DIR]=/work/.quchen-cache)
while IFS= read -r k; do
    case "$k" in
        QUCHEN_SYCL_*) ;;                                 # this script's own settings
        QUCHEN_*|ONEAPI_*|UR_*|IGC_*|SYCL_*|ZES_*|NEOReadDebugKeys|OverrideDefaultFP64Settings) setting[$k]=${!k} ;;
    esac
done < <(compgen -e)
envs=()
for k in "${!setting[@]}"; do
    # the engine tests the switches by presence: a value of 0 (or empty) means "not set", so it is not passed on
    case "${setting[$k]}" in 0|"") ;; *) envs+=(-e "$k=${setting[$k]}") ;; esac
done
shm=()
if [ "${QUCHEN_SYCL_SHM:-1}" != 0 ] && [ -d /dev/shm ]; then shm=(-v /dev/shm:/dev/shm); fi
exec docker run --rm -i --name "$name" --device /dev/dri --oom-score-adj 1000 --stop-timeout 30 --no-healthcheck \
    --ulimit memlock=-1 \
    -v "$root:/work" \
    "${shm[@]}" \
    "${envs[@]}" \
    "${QUCHEN_SYCL_IMAGE:-quchen-sycl-dev}" \
    "cd $repo_in && exec ${QUCHEN_SYCL_BIN:-build-sycl-aot/quchen}$args"

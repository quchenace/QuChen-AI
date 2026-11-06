#!/bin/sh
# QuChen Terminal: one-line installer for Linux (x86_64, and ARM64 on the NVIDIA DGX Spark) and macOS (Apple silicon).
#
#     curl -fsSL https://github.com/quchenace/QuChen/releases/latest/download/install.sh -o install.sh && sh install.sh
#
# What it does, in order (and nothing else):
#   1. finds out which computer this is (system, processor, graphics card) so it can fetch the right archive;
#   2. downloads the Terminal archive named in the release folder's install-manifest.txt and checks its SHA-256 against it;
#   3. unpacks it into  ${XDG_DATA_HOME:-~/.local/share}/quchen/terminal/<version>  (no administrator rights, nothing outside your home);
#   4. checks the release's signed feed with the Terminal it just unpacked (`quchen update --check`); if that check fails, it removes
#      what it unpacked and stops;
#   5. puts a `quchen` link in ~/.local/bin and prints:  Installed. Run: quchen launch
#
# The engine (the part that talks to your graphics card) and the model are NOT part of this: `quchen launch` fetches the engine for
# your card the first time you choose a model, from the same release folder, signed.
#
# <feed> is where the release folder is hosted: GitHub Releases of quchenace/QuChen (the "latest" release's files), built in as the default.
# Set QUCHEN_FEED to another folder (a URL) to use that instead, for example a local test feed:  QUCHEN_FEED=http://127.0.0.1:8099 sh install.sh
#
# Settings (all optional): QUCHEN_FEED, QUCHEN_DATA_DIR (default ~/.local/share/quchen), QUCHEN_BIN_DIR (default ~/.local/bin),
# QUCHEN_INSTALL_TEST_TRUST=1 (a test feed: also fetch <feed>/test-trust.json and trust only that key for the check in step 4).
set -eu

FEED="${QUCHEN_FEED:-https://github.com/quchenace/QuChen/releases/latest/download}"
FEED="${FEED%/}"
DATA_DIR="${QUCHEN_DATA_DIR:-${XDG_DATA_HOME:-$HOME/.local/share}/quchen}"
BIN_DIR="${QUCHEN_BIN_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
die() { printf 'quchen installer: %s\n' "$*" >&2; exit 1; }

[ -n "$FEED" ] || die "this installer does not know where the QuChen release folder is. Set QUCHEN_FEED to its address and run it again, for example: QUCHEN_FEED=https://example.org/quchen sh install.sh"

# Everything below is one function, called on the last line: a download that stops half-way is a syntax error (nothing runs), not a half installer.
main() {
  # ---- tools
  if command -v curl >/dev/null 2>&1; then
    fetch() { curl -fsSL --retry 3 -o "$2" "$1"; }
  elif command -v wget >/dev/null 2>&1; then
    fetch() { wget -q -O "$2" "$1"; }
  else
    die "neither curl nor wget is installed, so nothing can be downloaded. Install one (for example: sudo apt install curl) and run this again."
  fi
  if command -v sha256sum >/dev/null 2>&1; then
    sha() { sha256sum "$1" | cut -d' ' -f1; }
  elif command -v shasum >/dev/null 2>&1; then
    sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
  else
    die "no sha256sum or shasum was found, so the download cannot be checked. Install coreutils and run this again."
  fi
  command -v tar >/dev/null 2>&1 || die "tar is not installed; install it and run this again."

  # ---- 1. this computer
  os=$(uname -s); arch=$(uname -m)
  case "$os-$arch" in
    Linux-x86_64|Linux-amd64) platform=linux-x86_64 ;;
    Darwin-arm64|Darwin-aarch64) platform=macos-arm64 ;;
    Linux-aarch64|Linux-arm64) platform=linux-aarch64 ;;      # the NVIDIA DGX Spark (GB10); the note below says so for any other ARM computer
    Darwin-x86_64) die "this Mac has an Intel processor. QuChen for Mac needs Apple silicon (M1 or newer), so it could not run a model here." ;;
    *) die "this computer ($os $arch) has no QuChen Terminal. Supported: Linux x86_64 with an NVIDIA or AMD card, Linux ARM64 on an NVIDIA DGX Spark, macOS on Apple silicon (Windows: use install.ps1)." ;;
  esac
  gpu=""
  if command -v nvidia-smi >/dev/null 2>&1; then
    # only a clean answer is a card name: a driver that is not loaded prints an error sentence (on stdout, exit status 9)
    gpu=$(nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null) || gpu=""
    gpu=$(printf '%s' "$gpu" | head -1)
    case "$gpu" in *[Ff]ailed*|*NVIDIA-SMI*|*"couldn't communicate"*|*"No devices"*) gpu="" ;; esac
    [ -n "$gpu" ] && gpu="NVIDIA $gpu"
  fi
  if [ -z "$gpu" ] && [ "$os" = Linux ] && command -v lspci >/dev/null 2>&1; then
    # the PCI class decides, not a word anywhere in the line (an SSD sold as "3D NAND" is not a graphics card)
    gpu=$(lspci 2>/dev/null | grep -iE '^[^ ]+ (vga compatible controller|3d controller|display controller)[^:]*:' | head -1 | sed 's/^[^ ]* [^:]*: *//' || true)
  fi
  if [ -z "$gpu" ] && [ "$os" = Darwin ]; then
    gpu=$(system_profiler SPDisplaysDataType 2>/dev/null | sed -n 's/^ *Chipset Model: //p' | head -1 || true)
  fi
  say "QuChen Terminal installer"
  say "  This computer: $os $arch ($platform)${gpu:+, graphics: $gpu}"
  if [ "$platform" = linux-aarch64 ]; then      # recommend, never force: the Terminal installs on any ARM Linux, its engine is for one machine
    case "$gpu" in
      *GB10*) ;;
      *) say "  Note: QuChen's engine for ARM Linux is built and tested on the NVIDIA DGX Spark (GB10) only. This computer reports ${gpu:-no NVIDIA graphics}: the Terminal installs, but 'quchen launch' may find no engine for it." ;;
    esac
  fi
  say "  Release folder: $FEED"

  # ---- 2. download and check
  work=$(mktemp -d "${TMPDIR:-/tmp}/quchen-install.XXXXXX") || die "cannot make a temporary folder"
  trap 'rm -rf "$work"' EXIT INT TERM
  fetch "$FEED/install-manifest.txt" "$work/manifest.txt" || die "could not read $FEED/install-manifest.txt. Check the address and your internet connection."
  line=$(awk -v p="$platform" '$1 == p { print; exit }' "$work/manifest.txt")
  [ -n "$line" ] || die "this release has no Terminal for $platform."
  set -- $line
  version=$2; rel=$3; want=$4
  say "  Terminal $version ($(( ${5:-0} / 1048576 )) MB)"
  say "Downloading…"
  fetch "$FEED/$rel" "$work/terminal.tar.gz" || die "the download failed. Check your internet connection and run this again; nothing was installed."
  got=$(sha "$work/terminal.tar.gz")
  [ "$got" = "$want" ] || die "the download does not match the release's checksum (got $got, wanted $want). It was not installed; try again, and if it repeats the release folder is damaged."
  say "  Checksum ok."

  # ---- 3. unpack
  dest="$DATA_DIR/terminal/$version"
  mkdir -p "$DATA_DIR/terminal" "$BIN_DIR"
  rm -rf "$dest.incoming"; mkdir -p "$dest.incoming"
  tar -xzf "$work/terminal.tar.gz" -C "$dest.incoming" || die "the archive could not be unpacked (is the disk full?). Nothing was installed."
  if [ ! -f "$dest.incoming/bin/quchen" ]; then                  # an archive with one top folder (a terminal archive instead of the feed's control package)
    inner=$(ls -d "$dest.incoming"/*/ 2>/dev/null | head -1)
    if [ -n "$inner" ] && [ -f "${inner}bin/quchen" ]; then
      mv "${inner%/}" "$dest.inner" && rm -rf "$dest.incoming" && mv "$dest.inner" "$dest.incoming"
    fi
  fi
  [ -f "$dest.incoming/bin/quchen" ] || { rm -rf "$dest.incoming"; die "the archive does not look like a QuChen Terminal (no bin/quchen). Nothing was installed."; }
  chmod +x "$dest.incoming/bin/quchen" 2>/dev/null || true

  # ---- 4. the signed feed, checked with the Terminal just unpacked
  if [ "${QUCHEN_INSTALL_TEST_TRUST:-}" = 1 ]; then
    fetch "$FEED/test-trust.json" "$work/test-trust.json" || { rm -rf "$dest.incoming"; die "the test feed has no test-trust.json"; }
    QUCHEN_UPDATE_TRUSTED_KEYS="$work/test-trust.json"; export QUCHEN_UPDATE_TRUSTED_KEYS
  fi
  say "Checking the release's signature…"
  if ! "$dest.incoming/bin/quchen" update --check --no-engine --feed "$FEED" >"$work/check.txt" 2>&1; then
    sed -e 's/^/    /' "$work/check.txt" >&2
    rm -rf "$dest.incoming"
    die "the release folder's signed feed could not be verified, so nothing was installed. The reason is printed above; if it names a newer feed already accepted here, use the newest release folder, or follow the step it gives. If you trust this source and see no such reason, ask its owner to publish a signed feed."
  fi
  say "  Signature ok."

  # ---- 5. in place
  rm -rf "$dest"
  mv "$dest.incoming" "$dest"
  ln -sfn "$dest" "$DATA_DIR/terminal/current"
  ln -sf "$DATA_DIR/terminal/current/bin/quchen" "$BIN_DIR/quchen"
  case ":$PATH:" in
    *":$BIN_DIR:"*) say "Installed. Run: quchen launch" ;;
    *) say "Installed. Run: $BIN_DIR/quchen launch"
       say "  (To type just 'quchen', add this line to your shell profile: export PATH=\"$BIN_DIR:\$PATH\")" ;;
  esac
}

main "$@"

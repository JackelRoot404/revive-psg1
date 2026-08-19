#!/usr/bin/env bash
# Fail-closed host gate for the official LineageOS 22.2 GSI build.
# Prints only generic capacity facts. Does not sync, patch, or compile.
set -euo pipefail

MIN_RAM_KIB=$((32 * 1024 * 1024))
TIGHT_RAM_KIB=$((24 * 1024 * 1024))
MIN_DISK_BYTES=$((400 * 1024 * 1024 * 1024))

allow_tight=0
build_dir="."

usage() {
  cat <<'EOF'
Usage: tools/check-lineage-host.sh [--allow-tight-memory] [--path DIR]

Exit 0 only when this Linux host can hold an official
lineage_gsi_arm64-user build from the pinned 22.2 manifest.

  --allow-tight-memory  accept 24 GiB RAM if the Soong GOMEMLIMIT patch
                        will be applied. 16 GiB hosts still fail.
  --path DIR            filesystem that would hold the source and out/
                        tree (default: current directory)

This script never downloads source, starts a build, or prints host names,
user names, or network addresses.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --allow-tight-memory) allow_tight=1; shift ;;
    --path)
      build_dir="${2:-}"
      if [[ -z "$build_dir" ]]; then
        echo "error: --path requires a directory" >&2
        exit 2
      fi
      shift 2
      ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

reasons=()
kernel=$(uname -s)
arch=$(uname -m)

if [[ "$kernel" != "Linux" ]]; then
  reasons+=("linux_required:${kernel}")
fi

if [[ "$arch" != "x86_64" ]]; then
  reasons+=("native_amd64_required:${arch}")
fi

if [[ -r /proc/cpuinfo ]] && grep -qiE 'qemu|rosetta|virtual apple' /proc/cpuinfo; then
  reasons+=("translated_or_emulated_cpu")
fi

ram_kib=0
if [[ -r /proc/meminfo ]]; then
  ram_kib=$(awk '/^MemTotal:/{print $2}' /proc/meminfo)
fi
ram_need=$MIN_RAM_KIB
if [[ "$allow_tight" -eq 1 ]]; then
  ram_need=$TIGHT_RAM_KIB
fi
if [[ "$ram_kib" -lt "$ram_need" ]]; then
  reasons+=("ram_kib_below_${ram_need}:${ram_kib}")
fi

if [[ ! -d "$build_dir" ]]; then
  reasons+=("build_path_missing")
  disk_avail=0
else
  disk_avail=$(df -B1 --output=avail "$build_dir" | awk 'NR==2{print $1}')
fi
if [[ "${disk_avail:-0}" -lt "$MIN_DISK_BYTES" ]]; then
  reasons+=("disk_bytes_below_${MIN_DISK_BYTES}:${disk_avail:-0}")
fi

printf 'kernel=%s\n' "$kernel"
printf 'arch=%s\n' "$arch"
printf 'ram_kib=%s\n' "$ram_kib"
printf 'ram_need_kib=%s\n' "$ram_need"
printf 'disk_avail_bytes=%s\n' "${disk_avail:-0}"
printf 'disk_need_bytes=%s\n' "$MIN_DISK_BYTES"
printf 'tight_memory_allowed=%s\n' "$allow_tight"

if [[ ${#reasons[@]} -gt 0 ]]; then
  printf 'ok=no\n'
  printf 'reasons=%s\n' "${reasons[*]}"
  echo "This host cannot hold the official LineageOS 22.2 GSI build." >&2
  echo "Do not start repo sync or lunch on this machine." >&2
  exit 2
fi

printf 'ok=yes\n'
printf 'reasons=\n'
echo "Host gate passed. See docs/handoff/lineage-build.md before syncing." >&2

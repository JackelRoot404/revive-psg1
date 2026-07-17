#!/bin/sh
set -eu

normalize() {
  printf '%s' "$1" | tr '[:lower:]' '[:upper:]' | tr -d '[:space:]_-'
}

assert_eq() {
  [ "$1" = "$2" ] || {
    printf 'expected %s, got %s\n' "$2" "$1" >&2
    exit 1
  }
}

# Synthetic examples only; never add a customer factory serial here.
assert_eq "$(normalize ' PSG1-TEST-0001-A ')" "PSG1TEST0001A"
assert_eq "$(normalize 'psg1_test_0002')" "PSG1TEST0002"
printf 'serial normalizer tests passed\n'

#!/bin/sh
set -eu

media_dir="${NAS_MEDIA_DIR:-/data/private-media}"
mkdir -p "$media_dir"
chown node:node "$media_dir"
chmod 0700 "$media_dir"

exec gosu node "$@"

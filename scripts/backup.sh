#!/bin/sh
# Copies everything (database, snapshots, receipts) out of the Docker volume into one dated archive.
# Usage: ./scripts/backup.sh [destination-folder]      (default: ./backups)
set -eu
DEST="${1:-./backups}"
VOLUME="${VOLUME:-little-honey-books_books-data}"
mkdir -p "$DEST"
STAMP="$(date +%Y-%m-%d-%H%M)"
docker run --rm -v "$VOLUME":/data:ro -v "$(cd "$DEST" && pwd)":/out alpine \
  tar czf "/out/books-$STAMP.tar.gz" -C /data .
echo "Wrote $DEST/books-$STAMP.tar.gz"

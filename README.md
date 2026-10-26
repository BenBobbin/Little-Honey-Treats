# Little Honey Treats books

Self-hosted bookkeeping for Little Honey Treats: invoices and quotes, expenses with receipts, recipes and stock, time and travel, P&L, BAS summary. Cash basis, Australian financial year.

One small Node server (no npm dependencies, needs Node 22.13+), a SQLite database, and the single-page app in `public/`.

## Run it on server1 with Docker

```sh
git clone <your-repo-url> little-honey-books
cd little-honey-books
cp .env.example .env        # then edit .env and set APP_PASSWORD
docker compose up -d --build
```

Open `http://server1:3100` and sign in (change `HOST_PORT` in `.env` if 3100 is taken). Data lives in the Docker volume `little-honey-books_books-data`, so rebuilding or updating the container never touches it.

### Kept separate from your other business on server1
This stack shares nothing with anything else on the host: its own compose project (`little-honey-books`), container, network (`little-honey-books_net`), volume, image, database, password and port. `docker compose down` here only affects this app. Do not use `docker compose down -v`, which would delete this app's data volume.

Update later: `git pull && docker compose up -d --build`

### Behind a reverse proxy (recommended if reachable outside your network)
Put it behind your existing proxy for HTTPS, then in `.env` set `COOKIE_SECURE=true` and `TRUST_PROXY=true`. The live-sync stream is plain HTTP (no websockets), so turn proxy buffering off for `/api/events` (Nginx: `proxy_buffering off;`).

## Backups
- The server writes a database snapshot every day inside the volume (`/data/backups`, last 14 kept). That protects against mistakes, not against losing the disk.
- `./scripts/backup.sh /path/to/folder` packs the whole volume (database, snapshots, receipts) into one dated `.tar.gz`. Run it from cron and copy the result off the machine.
- Settings > Your data > "Download full backup" still works too, but it does not include receipt files.

Restore from a tarball: stop the container, then
`docker run --rm -v little-honey-books_books-data:/data -v "$PWD":/in alpine sh -c "cd /data && tar xzf /in/books-DATE.tar.gz"`

## Run without Docker
```sh
APP_PASSWORD=something-long npm start     # http://localhost:3000
npm test
```

## Notes
- Leaving `APP_PASSWORD` empty turns the login off. Only do that on a machine nobody else can reach.
- Fonts load from Google Fonts. Without internet it falls back to system fonts.
- Receipts are limited to 15 MB each. Images and PDFs open in the browser; anything else downloads.
- Layout: `server.js` (API, login, receipts), `public/index.html` (the app), `public/shim.js` (connects the app to the server).

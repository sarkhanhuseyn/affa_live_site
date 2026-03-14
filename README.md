# AFFA Live Site

Standalone public website for AFFA competition data.

## What it is

- Separate from FAOS
- Static frontend in `site/`
- Real AFFA competition data snapshot generated into `site/data/affa.json`
- Separate operator feed in `site/operator.html`
- Includes:
  - Matches
  - Tables
  - Clubs
  - Players
  - Match detail view
- Operator-entered incidents and lineups
- Shared operator state across devices on the same network

## Included competitions

- Misli Premyer Liqası
- Futzal
- AFFA Gənclər Liqası
- AFFA U-17 Liqası
- AFFA U-16 Liqası
- AFFA U-15 Liqası
- AFFA U-14 Liqası
- AFFA U-13 Liqası
- AFFA U-12 Liqası
- AFFA U-11 Liqası
- AFFA U-10 Liqası
- AFFA U-9 Liqası
- AFFA U-8 Liqası
- AFFA Yüksək Qızlar Liqası
- AFFA U-16 Qızlar Liqası
- AFFA U-14 Qızlar Liqası
- AFFA U-12 qızlar Liqası
- AFFA Region Liqası

## Refresh data

```bash
cd /Users/sarkhanhuseynov/Desktop/faos
source .venv/bin/activate
pip install -r affa_live_site/requirements.txt
python affa_live_site/scripts/fetch_affa_data.py
```

## Run the website on your network

```bash
cd /Users/sarkhanhuseynov/Desktop/faos/affa_live_site
python3 serve_affa_site.py
```

Then open:

- `http://localhost:8080`
- `http://localhost:8080/operator.html`

The server also prints your local network URL such as `http://192.168.x.x:8080`.
Open that address from any phone, tablet, or other computer on the same Wi‑Fi network.

## Notes

- AFFA public match pages do not expose full lineups or detailed event timelines in a reusable HTML structure.
- The public site reads real AFFA snapshot data first, then overlays shared operator updates from `site/data/operator_store.json` through the local API.
- The operator page uses PIN `1234` by default.
- Public and operator pages are mobile-friendly and can be opened from other devices on the same local network when served through `serve_affa_site.py`.
- The importer now discovers competitions dynamically from the AFFA competition index linked from `https://www.affa.az/index.php/yarlar/affa-region-liqas/sasnam/60932`.
- In the latest generated snapshot, 12 competitions currently produced public schedule rows and 6 additional competition entries were discovered but had no parseable public fixture rows on AFFA at import time.

## Permanent public deployment on Railway

Recommended for this project because the site includes a writable operator API in addition to the frontend.

### Files already prepared

- `Procfile` starts the app on Railway
- `serve_affa_site.py` now respects:
  - `PORT`
  - `HOST`
  - `OPERATOR_STORE_PATH`

### Deploy steps

1. Push `affa_live_site` to a GitHub repository.
2. Create a new Railway project from that GitHub repo.
3. Railway should detect the Python app automatically.
4. Use the generated Railway domain first.
5. Later, attach your own custom domain in Railway.

### Important persistence note

For permanent shared operator data, add a Railway Volume and set:

```bash
OPERATOR_STORE_PATH=/data/operator_store.json
```

Without a persistent volume, operator changes may be lost after redeploys or restarts.

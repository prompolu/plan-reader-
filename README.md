# PlanMeasure AI

Extracts doors, windows and other openings — with their tags, widths, heights and
quantities — from architectural drawing sets (PDF, PNG, JPG), shows the evidence
behind every value, lets you review and correct everything, and produces a
printable / downloadable measurement schedule from the reviewed data.

It measures; it does not price. There is deliberately no costing, quoting,
invoicing, labour, material pricing, mark-up, CRM or sales functionality.

## How it works

1. **Upload** one or more drawing files into a project. Files are validated
   (type sniffing, size / page / pixel limits) and stored privately.
2. **Processing** runs as a background job with visible steps: render pages →
   analyse (vector text & linework, or OCR for scans) → classify pages (floor
   plan, elevation, section, schedules, details, …) → detect dimensions → detect
   openings and tags → associate dimensions with openings → read door/window
   schedules → cross-check schedules, elevations and plans → find duplicates and
   conflicts → score confidence.
3. **Review** in the extraction workspace: the drawing viewer highlights each
   opening, its tag and the dimension lines that produced its values. Every
   value lists its evidence (e.g. "dimension line terminates at the opening's
   jambs", "extension lines originate at the opening edges") and a confidence.
   The review queue walks through everything that needs a human decision.
4. **Export** the measurement schedule (grouped by type, tag, size, page or
   floor) to print or to a Summary / Detailed PDF — always from the current,
   user-reviewed values.

Rules the extractor follows:

* **Never invent a measurement.** Missing values are shown as *Needs review*.
  Values derived from the drawing scale are labelled *Inferred from drawing
  scale* and get lower confidence. The vision model (optional) can only choose
  between dimensions that were actually read from the drawing.
* **Conflicts are shown, not resolved** — e.g. a schedule height that disagrees
  with the elevations lists every source; you pick one or enter your own.
* **References are not instances.** An opening seen on a plan, an elevation, a
  schedule and an enlarged detail is counted once.
* Original dimension text is preserved (`2'-10"`, `900`, `0.9 m`), and every
  change is recorded in an audit trail. Re-processing never overwrites values
  you edited or verified; new AI results are offered for acceptance instead.

## Access and privacy

There is no sign-in screen. The first visit creates a **private workspace for
that browser**, held by an `httpOnly`, `SameSite` session cookie with a 256-bit
token (one-year sliding lifetime). Projects and drawings belong to that
workspace: other browsers get 404 for its projects, and files are only served
through short-lived HMAC-signed links that additionally require the owning
session. Uploaded documents are never publicly accessible.

Consequences to be aware of: clearing the site's cookies (or using another
browser/device) starts a new, empty workspace — the old projects are not
reachable from it.

Other protections: CSRF double-submit token on every state-changing request,
rate limits (workspace creation, uploads, exports, API), strict security headers
and CSP, storage keys confined to the project prefix, argon2 password hashing
for the (API-only) account endpoints.

For deployment on a network, run behind HTTPS with `PM_ENV=production`
(which refuses to start without a strong `PM_SECRET_KEY` and `PM_COOKIE_SECURE=true`).

## Architecture

```
frontend/   React 18 + TypeScript + Vite SPA (TanStack Query, custom zoom/pan viewer)
backend/
  planmeasure/main.py        FastAPI app, security headers, serves the built SPA
  planmeasure/api/           REST endpoints (workspace session, projects, documents,
                             pages, openings, review, schedule, exports, signed files)
  planmeasure/pipeline/      extraction pipeline (see below)
  planmeasure/jobs.py        Postgres job queue (FOR UPDATE SKIP LOCKED, heartbeats, retries)
  planmeasure/worker.py      standalone worker: python -m planmeasure.worker
  planmeasure/reports/pdf.py ReportLab Summary / Detailed PDF reports
  planmeasure/demo/          synthetic drawing generator (demo project + benchmark ground truth)
  planmeasure/benchmark/     accuracy benchmark
  migrations/                Alembic migrations (PostgreSQL 16)
```

Pipeline modules are behind small provider interfaces
(`pipeline/interfaces.py`: `DocumentParser`, `OCRProvider`, `VisionProvider`,
`OpeningDetector`, `DimensionDetector`) so any stage can be swapped. Vector PDFs
are read directly with PyMuPDF (characters, drawings, page rotation); scans go
through OpenCV line/arc extraction and Tesseract OCR.

Each processing run is stored as a versioned extraction run (pipeline version,
models used, statistics, warnings), listed under Settings; "Re-extract all" on
the Upload page starts a new run.

## Running it

### Docker (recommended)

```bash
PM_SECRET_KEY=$(openssl rand -hex 32) docker compose up --build
# open http://localhost:8000 and choose "Try the demo project" or upload drawings
```

This starts PostgreSQL, the API (which also serves the web app and runs the
migrations) and a separate processing worker. Drawings live in the `storage`
volume.

### Local development

Requirements: Python 3.11+, Node 20+, PostgreSQL 16, Tesseract (`tesseract-ocr`)
and the DejaVu fonts (`fonts-dejavu-core`, used for PDF reports).

```bash
# database
createuser planmeasure -P            # password: planmeasure
createdb -O planmeasure planmeasure

# backend
cd backend
python -m venv .venv && . .venv/bin/activate
pip install -e ".[dev]"
alembic upgrade head
PM_RUN_WORKER_IN_PROCESS=true uvicorn planmeasure.main:app --reload --port 8000

# frontend (second terminal) - dev server on :5173 proxies /api to :8000
cd frontend
npm install
npm run dev
```

For a single-process setup, `npm run build` and the API serves `frontend/dist`
at http://localhost:8000.

### Configuration

All settings are environment variables with the `PM_` prefix (or a `.env` file
in `backend/`). The most relevant:

| Variable | Default | Purpose |
|---|---|---|
| `PM_DATABASE_URL` | `postgresql+psycopg://planmeasure:planmeasure@localhost:5432/planmeasure` | database |
| `PM_SECRET_KEY` | dev key | signs file links; required (32+ chars) in production |
| `PM_ENV` | `development` | `production` enforces secure settings, hides API docs |
| `PM_COOKIE_SECURE` | `false` | set `true` behind HTTPS |
| `PM_STORAGE_BACKEND` | `local` | `local` or `s3` (`PM_S3_BUCKET`, `PM_S3_ENDPOINT_URL`, …) |
| `PM_STORAGE_DIR` | `./storage` | local storage root (keep it out of any web root) |
| `PM_MAX_UPLOAD_MB` / `PM_MAX_PAGES_PER_DOCUMENT` / `PM_MAX_FILES_PER_UPLOAD` | `200` / `300` / `20` | upload limits |
| `PM_WORKSPACE_SESSION_DAYS` | `365` | lifetime of a browser workspace (sliding) |
| `PM_RUN_WORKER_IN_PROCESS` | `false` | run jobs inside the API process instead of a worker |
| `PM_OCR_PROVIDER` | `tesseract` | `tesseract` or `none` |
| `PM_VISION_PROVIDER` | `none` | `anthropic` to enable the vision model |
| `PM_ANTHROPIC_API_KEY` | – | API key for the vision provider |
| `PM_VISION_MODEL` | `claude-opus-5-5` | model id |
| `PM_MAX_VISION_CALLS_PER_RUN` | `40` | cost guard per processing run |
| `PM_REDIS_URL` | – | share rate-limit counters between processes |

**Vision model.** Optional. When enabled (`pip install ".[anthropic]"`,
`PM_VISION_PROVIDER=anthropic`, `PM_ANTHROPIC_API_KEY=…`) it is consulted only for
ambiguous cases — low-confidence page classification and near-tie dimension
associations — with structured JSON output. It cannot introduce numbers: it
may only choose among dimension ids read from the drawing or answer "none".
Without it, those cases are simply flagged for review.

## Tests

```bash
cd backend && pytest                 # 75 tests: units, pipeline, association, API/security (needs PostgreSQL)
cd frontend && npm test              # unit tests
cd frontend && npm run e2e           # Playwright, against a running server on :8000 (PM_E2E_BASE_URL to override)
```

The end-to-end suite uploads a real PDF drawing set through the UI, waits for
processing, resolves a schedule/elevation conflict, verifies the opening,
checks the measurement schedule and downloads the PDF export; a second test
checks that another browser cannot reach the project or its files.

## Accuracy

See [docs/BENCHMARK.md](docs/BENCHMARK.md). In short, on a **synthetic**
generated dataset: vector PDFs ≈100 % detection and dimension association,
scanned/raster drawings ≈34 % opening recall, and **0 fabricated measurements**
in both. These are measured numbers on generated drawings, not a claim about
real-world accuracy — add real drawings with ground truth to measure that.

## Known limitations

* Scanned drawings (raster/OCR path) find far fewer openings than CAD PDFs.
* Detection is tuned for conventional plan symbols (jambs, door swings, window
  glazing lines, tag bubbles); unusual drafting standards need review.

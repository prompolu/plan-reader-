# PlanMeasure AI

Extracts doors, windows and other openings — with their tags, widths, heights and
quantities — from architectural drawing sets (PDF, PNG, JPG), shows the evidence
behind every value, lets you review and correct everything, and produces a
printable / downloadable measurement schedule from the reviewed data.

It measures; it does not price. There is deliberately no costing, quoting,
invoicing, labour, material pricing, mark-up, CRM or sales functionality.

**No server, no account, no hosting.** PlanMeasure AI is a desktop app
(Windows, macOS) and an installable iPhone / web app. The extraction engine,
the OCR, the storage and the PDF export all run on your device; drawings are
never uploaded anywhere. Projects are saved and opened as **`.planmeasure`
project files**, which you can keep as backups or open on another computer or
phone.

## Getting the app

Every push builds the app with GitHub Actions (**Actions → Build → the latest
run → Artifacts**):

| Download | Install |
|---|---|
| **PlanMeasure-AI-Windows** → `PlanMeasure-AI-Setup-2.0.0.exe` | Run it. Windows SmartScreen may warn about an unsigned app: *More info → Run anyway*. |
| **PlanMeasure-AI-macOS** → `PlanMeasure-AI-2.0.0-mac.dmg` (Apple silicon and Intel, macOS 10.13+) | Open the dmg and drag the app to Applications. The first time, right-click the app → *Open* (it is not notarised). |
| **iPhone / iPad** | Open `https://<owner>.github.io/<repo>/` in Safari → Share → *Add to Home Screen*. After the first visit it works offline. |

The iPhone app is published to GitHub Pages from the `main` branch. Enable it
once under **Settings → Pages → Build and deployment → Source: GitHub
Actions**.

Double-clicking a `.planmeasure` file opens it in the desktop app; the
installers register the file type.

**Activation.** Like Debromp, each device needs an activation code. The first
time the app opens it shows the device's code (e.g. `7K3F-92QX-M4TB`) with
*Copy* and *Send by WhatsApp*; Prompolu makes a permanent or yearly code for
that device in its private generator (`generator.html`, signed with the same
secret key as the Debromp codes) and the client pastes it in. Codes are
checked on the device, offline; a code only works on the device it was made
for. See [docs/LICENSING.md](docs/LICENSING.md).

**Languages: English, French, Spanish.** The app starts in the device's
language and can be switched on the welcome screen or under Settings; the
choice is remembered. Everything follows it — screens, review flags and
evidence, the history, the measurement schedule, PDF exports and the desktop
menu. Text quoted from the drawings (tags, sheet names, dimension text) is
kept exactly as drawn.

## How it works

1. **Add drawings** to a project. Files are checked (type sniffing, size / page
   / pixel limits) and stored in the app's private storage on this device.
2. **Processing** runs in a background thread with visible steps: render pages →
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
5. **Save project file** keeps the drawings, results, your edits and the audit
   trail in one file. **Open project file** brings it back (if the project is
   already in the app you choose: replace it, or open it as a copy).

Rules the extractor follows:

* **Never invent a measurement.** Missing values are shown as *Needs review*.
  Values derived from the drawing scale are labelled *Inferred from drawing
  scale* and get lower confidence.
* **Conflicts are shown, not resolved** — e.g. a schedule height that disagrees
  with the elevations lists every source; you pick one or enter your own.
* **References are not instances.** An opening seen on a plan, an elevation, a
  schedule and an enlarged detail is counted once.
* Original dimension text is preserved (`2'-10"`, `900`, `0.9 m`), and every
  change is recorded in an audit trail. Re-processing never overwrites values
  you edited or verified; new results are offered for acceptance instead.

## Privacy

Drawings, results, edits and the audit trail are stored only on the device, in
the app's own storage (IndexedDB). The app makes no network requests for your
data — the browser tests check that no request leaves the app during a full
workflow — and it has a strict Content Security Policy. The desktop app serves
its files from a private `app://` scheme, runs the page sandboxed with context
isolation, blocks navigation away from the app and denies all device
permissions.

Uninstalling the app, or clearing the site's data in a browser, deletes the
projects stored on that device: keep project files as backups. On iPhone, add
the app to the Home Screen so Safari keeps its storage.

## Architecture

```
app/
  src/engine/        extraction engine (TypeScript): PDF.js page model, vector
                     geometry, OCR (tesseract.js) and OpenCV.js for scans, page
                     classification, dimensions, openings, association,
                     schedules, cross-referencing, confidence
  src/local/         the app's on-device back end: IndexedDB storage, a local
                     API (same routes the screens use), processing jobs in a
                     Web Worker, edits / verification / audit trail, schedule,
                     PDF reports (jsPDF) and project files (.planmeasure zip)
  src/pages, src/components   React 18 screens
  src/i18n/          English / French / Spanish: interface dictionaries and
                     templates for the engine's messages
  src/license/       activation codes (Ed25519, device-bound), public keys,
                     licence state; src/generator/ is the code generator page
  electron/          desktop shell (Electron 26, app:// protocol, file associations)
  e2e/               Playwright tests of the built app in Chromium
  benchmark/         ground-truth drawing sets and scans for the accuracy benchmark
.github/workflows/build.yml   tests, Windows / macOS installers, GitHub Pages
```

The engine is a port of the original Python pipeline; on the benchmark it
produces the same results (see [docs/BENCHMARK.md](docs/BENCHMARK.md)). Each
processing run is stored as a versioned extraction run (pipeline version,
models, statistics, warnings), listed under Settings.

## Development

Requirements: Node 20+.

```bash
cd app
npm install
npm run dev          # http://localhost:5173
npm test             # unit + app-layer tests (IndexedDB and the engine run in Node)
npm run build:e2e && npm run e2e    # the built app in Chromium (test build: also accepts the test key)
npm run benchmark    # extraction accuracy on the 31 vector drawing sets
npm run benchmark:scans             # accuracy on the scanned drawings
npm run check:keys   # after `npm run build`: vendor key in, test key out
npm run desktop      # build and start the desktop app
npm run dist:win     # Windows installer (on Windows)  → app/release/
npm run dist:mac     # macOS dmg (on a Mac)             → app/release/
```

## Accuracy

See [docs/BENCHMARK.md](docs/BENCHMARK.md). In short, on a **synthetic**
generated dataset: vector PDFs 99.8 % opening recall and 100 % precision with
100 % dimension association; scanned drawings 42 % recall at 90 % precision; and
**0 fabricated measurements** in both. These are measured numbers on generated
drawings, not a claim about real-world accuracy — add real drawings with ground
truth to measure that.

## Known limitations

* Scanned drawings (raster/OCR path) find far fewer openings than CAD PDFs, and
  take ~10–25 s per page to read.
* Detection is tuned for conventional plan symbols (jambs, door swings, window
  glazing lines, tag bubbles); unusual drafting standards need review.
* The installers are not code-signed, so Windows and macOS show a warning the
  first time.
* PDF exports use the standard PDF fonts: characters outside Western European
  alphabets are replaced with `?`.

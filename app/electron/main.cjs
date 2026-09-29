/**
 * PlanMeasure AI desktop app (Windows / macOS).
 *
 * The app is the same build as the web app, served from inside the installed
 * application through a private app:// scheme. There is no server: drawings,
 * results and edits are stored on this computer, and projects are saved and
 * opened as .planmeasure files.
 */
const { app, BrowserWindow, Menu, dialog, ipcMain, protocol, session, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const SCHEME = "app";
const HOST = "planmeasure";
const ORIGIN = `${SCHEME}://${HOST}`;
const DIST = path.join(__dirname, "..", "dist");
const PROJECT_EXT = ".planmeasure";

const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval'",
  "worker-src 'self' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "font-src 'self' data:",
  "connect-src 'self' blob: data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".webmanifest": "application/manifest+json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".pfb": "application/octet-stream",
  ".bcmap": "application/octet-stream",
  ".wasm": "application/wasm",
  ".gz": "application/gzip",
  ".pdf": "application/pdf",
};

// app:// behaves like https: fetch, workers, WASM and IndexedDB all work
protocol.registerSchemesAsPrivileged([{ scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);

/** Serve a file from the app bundle (never outside it). */
function serve(request) {
  const url = new URL(request.url);
  if (url.host !== HOST) return new Response("Not found", { status: 404 });
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/" || rel === "") rel = "/index.html";
  const file = path.normalize(path.join(DIST, rel));
  if (!file.startsWith(DIST + path.sep)) return new Response("Not found", { status: 404 });
  let data;
  try {
    data = fs.readFileSync(file);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
  return new Response(data, { status: 200, headers: { "content-type": type, "content-security-policy": CSP, "x-content-type-options": "nosniff", "cache-control": "no-cache" } });
}

// -------------------------------------------------------------------------
// project files opened from Finder / Explorer (double-click, "Open with")
// -------------------------------------------------------------------------

let mainWindow = null;
let rendererReady = false;
const pendingFiles = [];

function projectFileArg(argv) {
  return argv.slice(1).find((a) => a.toLowerCase().endsWith(PROJECT_EXT) && fs.existsSync(a)) || null;
}

function deliverFiles() {
  if (!mainWindow || !rendererReady) return;
  while (pendingFiles.length) {
    const file = pendingFiles.shift();
    try {
      const data = fs.readFileSync(file);
      mainWindow.webContents.send("pm:open-file", { name: path.basename(file), data: new Uint8Array(data) });
    } catch (e) {
      dialog.showErrorBox("Could not open the project file", `${file}\n\n${e.message}`);
    }
  }
}

function queueFile(file) {
  if (!file) return;
  pendingFiles.push(file);
  deliverFiles();
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.focus();
  }
}

async function chooseProjectFile() {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: "Open project file",
    properties: ["openFile"],
    filters: [{ name: "PlanMeasure project", extensions: ["planmeasure"] }],
  });
  if (!r.canceled && r.filePaths[0]) queueFile(r.filePaths[0]);
}

// -------------------------------------------------------------------------
// window
// -------------------------------------------------------------------------

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1000,
    minHeight: 680,
    title: "PlanMeasure AI",
    backgroundColor: "#cfae88",
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      spellcheck: false,
    },
  });
  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.on("closed", () => {
    mainWindow = null;
    rendererReady = false;
  });

  const wc = mainWindow.webContents;
  // stay inside the app; web links open in the default browser
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  wc.on("will-navigate", (e, url) => {
    if (!url.startsWith(ORIGIN + "/")) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  wc.on("did-start-navigation", (_e, _url, _inPlace, isMainFrame) => {
    if (isMainFrame) rendererReady = false;
  });

  mainWindow.loadURL(`${ORIGIN}/index.html`);
}

// menu labels follow the language chosen in the app (English, French, Spanish)
const MENU = {
  en: { file: "File", open: "Open project file…", close: "Close window", quit: "Quit", edit: "Edit", undo: "Undo", redo: "Redo", cut: "Cut", copy: "Copy", paste: "Paste", selectAll: "Select all", view: "View", reload: "Reload", devtools: "Developer tools", actual: "Actual size", zoomIn: "Zoom in", zoomOut: "Zoom out", fullscreen: "Full screen", window: "Window", minimize: "Minimize" },
  fr: { file: "Fichier", open: "Ouvrir un fichier projet…", close: "Fermer la fenêtre", quit: "Quitter", edit: "Édition", undo: "Annuler", redo: "Rétablir", cut: "Couper", copy: "Copier", paste: "Coller", selectAll: "Tout sélectionner", view: "Affichage", reload: "Recharger", devtools: "Outils de développement", actual: "Taille réelle", zoomIn: "Zoom avant", zoomOut: "Zoom arrière", fullscreen: "Plein écran", window: "Fenêtre", minimize: "Réduire" },
  es: { file: "Archivo", open: "Abrir archivo de proyecto…", close: "Cerrar ventana", quit: "Salir", edit: "Edición", undo: "Deshacer", redo: "Rehacer", cut: "Cortar", copy: "Copiar", paste: "Pegar", selectAll: "Seleccionar todo", view: "Ver", reload: "Recargar", devtools: "Herramientas de desarrollo", actual: "Tamaño real", zoomIn: "Acercar", zoomOut: "Alejar", fullscreen: "Pantalla completa", window: "Ventana", minimize: "Minimizar" },
};
let menuLang = "en";

function buildMenu() {
  const isMac = process.platform === "darwin";
  const L = MENU[menuLang] || MENU.en;
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    {
      label: L.file,
      submenu: [{ label: L.open, accelerator: "CmdOrCtrl+O", click: () => chooseProjectFile() }, { type: "separator" }, isMac ? { role: "close", label: L.close } : { role: "quit", label: L.quit }],
    },
    {
      label: L.edit,
      submenu: [
        { role: "undo", label: L.undo },
        { role: "redo", label: L.redo },
        { type: "separator" },
        { role: "cut", label: L.cut },
        { role: "copy", label: L.copy },
        { role: "paste", label: L.paste },
        { role: "selectAll", label: L.selectAll },
      ],
    },
    {
      label: L.view,
      submenu: [
        { role: "reload", label: L.reload },
        { role: "toggleDevTools", label: L.devtools },
        { type: "separator" },
        { role: "resetZoom", label: L.actual },
        { role: "zoomIn", label: L.zoomIn },
        { role: "zoomOut", label: L.zoomOut },
        { type: "separator" },
        { role: "togglefullscreen", label: L.fullscreen },
      ],
    },
    { label: L.window, submenu: [{ role: "minimize", label: L.minimize }, isMac ? { role: "zoom" } : { role: "close", label: L.close }] },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// -------------------------------------------------------------------------
// lifecycle
// -------------------------------------------------------------------------

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", (_e, argv) => {
    queueFile(projectFileArg(argv));
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
  // macOS: files opened from Finder (may arrive before the app is ready)
  app.on("open-file", (e, file) => {
    e.preventDefault();
    queueFile(file);
  });
  const initial = projectFileArg(process.argv);
  if (initial) pendingFiles.push(initial);

  app.whenReady().then(() => {
    protocol.handle(SCHEME, serve);
    // the app needs no camera, microphone, location or notifications
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === "clipboard-sanitized-write"));
    session.defaultSession.on("will-download", (_e, item) => {
      const name = item.getFilename();
      const ext = path.extname(name).slice(1).toLowerCase();
      item.setSaveDialogOptions({
        title: ext === "planmeasure" ? "Save project file" : "Save",
        defaultPath: path.join(app.getPath("documents"), name),
        filters: ext === "planmeasure" ? [{ name: "PlanMeasure project", extensions: ["planmeasure"] }] : ext === "pdf" ? [{ name: "PDF", extensions: ["pdf"] }] : [],
      });
    });
    ipcMain.on("pm:ready", (e) => {
      if (mainWindow && e.sender === mainWindow.webContents) {
        rendererReady = true;
        deliverFiles();
      }
    });
    ipcMain.on("pm:choose-file", () => chooseProjectFile());
    ipcMain.on("pm:language", (_e, lang) => {
      if (MENU[lang] && lang !== menuLang) {
        menuLang = lang;
        buildMenu();
      }
    });
    // until the app tells us its language, follow the system's
    const sys = app.getLocale().slice(0, 2);
    if (MENU[sys]) menuLang = sys;
    buildMenu();
    createWindow();
    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}

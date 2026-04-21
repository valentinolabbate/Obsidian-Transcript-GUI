const {
  App,
  FileSystemAdapter,
  FuzzySuggestModal,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  requestUrl,
  normalizePath,
} = require("obsidian");
const { spawn, exec } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const https = require("https");

const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "wav", "ogg", "flac", "aac", "aiff"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "webm", "mov", "mkv", "avi", "m4v"]);
const MEDIA_EXTENSIONS = new Set([...AUDIO_EXTENSIONS, ...VIDEO_EXTENSIONS]);

const BACKEND_REPO_OWNER = "valentinolabbate";
const BACKEND_REPO_NAME = "Obsidian-Transcript-Server";
const BACKEND_BRANCH = "main";
const BACKEND_DOWNLOAD_URL = `https://github.com/${BACKEND_REPO_OWNER}/${BACKEND_REPO_NAME}/archive/refs/heads/${BACKEND_BRANCH}.tar.gz`;

const DEFAULT_SESSION_PROFILES = [
  {
    name: "Vorlesung",
    templatePath: "",
    storageDir: "10_Studium/1_Semester_Master_WiWi/{course}/Rohdaten",
    outputDir: "10_Studium/1_Semester_Master_WiWi/{course}/Sitzungen",
  },
  {
    name: "Uebung",
    templatePath: "",
    storageDir: "10_Studium/1_Semester_Master_WiWi/{course}/Rohdaten",
    outputDir: "10_Studium/1_Semester_Master_WiWi/{course}/Sitzungen",
  },
  {
    name: "Tutorium",
    templatePath: "",
    storageDir: "10_Studium/1_Semester_Master_WiWi/{course}/Rohdaten",
    outputDir: "10_Studium/1_Semester_Master_WiWi/{course}/Sitzungen",
  },
];

const DEFAULT_SETTINGS = {
  backendUrl: "http://127.0.0.1:8765",
  backendAutoInstall: true,
  backendAutoUpdate: true,
  backendVersion: "",
  inboxFolder: "99_Inbox/Audio",
  defaultSessionType: "Vorlesung",
  openNoteAfterProcessing: true,
  lastRun: null,
  jobHistory: [],
  sessionProfiles: DEFAULT_SESSION_PROFILES.map((profile) => ({ ...profile })),
  courseOptions: [
    "Oekonometrie",
    "Quantitative_Projekte_und_Reihenfolgenplanung",
    "Humanisierung_der_Arbeitswelt",
    "Dienstleistungsproduktion",
  ],
};

function cloneSessionProfile(profile = {}) {
  return {
    name: String(profile.name || "").trim(),
    templatePath: String(profile.templatePath || "").trim(),
    storageDir: String(profile.storageDir || "").trim(),
    outputDir: String(profile.outputDir || "").trim(),
  };
}

function normalizeSessionProfiles(profiles) {
  const fallback = DEFAULT_SESSION_PROFILES.map((profile) => cloneSessionProfile(profile));
  if (!Array.isArray(profiles) || profiles.length === 0) {
    return fallback;
  }

  const normalized = [];
  const seen = new Set();
  for (const profile of profiles) {
    const next = cloneSessionProfile(profile);
    if (!next.name || seen.has(next.name)) {
      continue;
    }
    seen.add(next.name);
    normalized.push({
      ...next,
      storageDir: next.storageDir || fallback[0].storageDir,
      outputDir: next.outputDir || fallback[0].outputDir,
    });
  }

  return normalized.length > 0 ? normalized : fallback;
}

function normalizeSettings(data) {
  const settings = Object.assign({}, DEFAULT_SETTINGS, data || {});
  settings.sessionProfiles = normalizeSessionProfiles(data?.sessionProfiles);
  if (!settings.sessionProfiles.some((profile) => profile.name === settings.defaultSessionType)) {
    settings.defaultSessionType = settings.sessionProfiles[0].name;
  }
  if (!Array.isArray(settings.courseOptions)) {
    settings.courseOptions = [...DEFAULT_SETTINGS.courseOptions];
  }
  return settings;
}

function stripWrappedQuotes(value) {
  return String(value || "").trim().replace(/^['"]|['"]$/g, "");
}

function extractWikiLinkTarget(value) {
  const match = String(value || "").match(/\[\[(.+?)\]\]/);
  return match ? match[1].trim() : stripWrappedQuotes(value);
}

function parseTranscriptStem(fileName) {
  const stem = String(fileName || "")
    .replace(/\.transcript\.md$/i, "")
    .replace(/\.segments\.json$/i, "")
    .trim();
  const parts = stem.split(" – ").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 3) {
    return { date: "", sessionType: "", theme: "" };
  }
  return {
    date: parts[0],
    sessionType: parts[1],
    theme: parts.slice(2).join(" – "),
  };
}

// ── Backend Installer Helpers ───────────────────────────────────────────────

function getPluginDir(app) {
  // In Obsidian plugins, this file lives at:
  // <vault>/.obsidian/plugins/obsidian-transcript-gui/main.js
  // We derive the plugin dir from __dirname of this module.
  // If app is provided, try to derive it from the vault path for extra safety.
  try {
    if (app?.vault?.adapter instanceof FileSystemAdapter) {
      const basePath = app.vault.adapter.getBasePath();
      const candidate = path.join(basePath, ".obsidian", "plugins", "obsidian-transcript-gui");
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  } catch (_e) {
    // ignore
  }

  try {
    return path.dirname(__filename);
  } catch (_e) {
    // Fallback: if __dirname is not available, use a temp path
    return path.join(os.homedir(), ".obsidian-transcript-server");
  }
}

function getBackendInstallDir(app) {
  return path.join(getPluginDir(app), ".backend");
}

function isBackendInstalled(app) {
  const installDir = getBackendInstallDir(app);
  const executable = path.join(installDir, ".venv", "bin", "lecture-pipeline");
  const envFile = path.join(installDir, ".env");
  try {
    fs.accessSync(executable, fs.constants.X_OK);
    fs.accessSync(envFile, fs.constants.R_OK);
    return true;
  } catch (_error) {
    return false;
  }
}

function getBackendExecutablePath(app) {
  return path.join(getBackendInstallDir(app), ".venv", "bin", "lecture-pipeline");
}

function execPromise(command, options = {}) {
  return new Promise((resolve, reject) => {
    exec(command, options, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr || stdout || error.message));
      } else {
        resolve({ stdout, stderr });
      }
    });
  });
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, { headers: { "User-Agent": "obsidian-transcript-gui" } }, (response) => {
      if (response.statusCode === 301 || response.statusCode === 302) {
        return downloadFile(response.headers.location, destPath).then(resolve).catch(reject);
      }
      if (response.statusCode !== 200) {
        reject(new Error(`Download failed: ${response.statusCode}`));
        return;
      }
      response.pipe(file);
      file.on("finish", () => {
        file.close();
        resolve();
      });
    }).on("error", (error) => {
      fs.unlink(destPath, () => {});
      reject(error);
    });
  });
}

async function extractTarGz(tarPath, destDir) {
  await execPromise(`tar -xzf "${tarPath}" -C "${destDir}"`);
}

const KNOWN_BIN_PATHS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/opt/local/bin",
];

async function resolveCommandPath(command) {
  // 1. Try PATH (which)
  try {
    const { stdout } = await execPromise(`which ${command}`);
    const trimmed = stdout.trim();
    if (trimmed) return trimmed;
  } catch (_e) {
    // ignore
  }

  // 2. Try known absolute paths
  for (const base of KNOWN_BIN_PATHS) {
    const absolute = path.join(base, command);
    try {
      fs.accessSync(absolute, fs.constants.X_OK);
      return absolute;
    } catch (_e) {
      // ignore
    }
  }

  return null;
}

async function getCommandVersion(command) {
  try {
    const { stdout } = await execPromise(`${command} --version`);
    const match = stdout.match(/Python\s+(\d+)\.(\d+)/i);
    if (match) {
      return { major: parseInt(match[1], 10), minor: parseInt(match[2], 10), raw: stdout.trim() };
    }
  } catch (_error) {
    // ignore
  }
  return null;
}

async function findPythonCommand() {
  const candidates = [
    "python3.13",
    "python3.12",
    "python3.11",
    "python3.10",
    "python3",
  ];

  let best = null;

  for (const cmd of candidates) {
    const resolved = await resolveCommandPath(cmd);
    if (!resolved) continue;
    const version = await getCommandVersion(resolved);
    if (!version) continue;
    if (version.major < 3) continue;
    if (!best) {
      best = { cmd: resolved, version };
      continue;
    }
    if (version.major > best.version.major) {
      best = { cmd: resolved, version };
    } else if (version.major === best.version.major && version.minor > best.version.minor) {
      best = { cmd: resolved, version };
    }
  }

  return best;
}

function getEnvPath(installDir) {
  return path.join(installDir, ".env");
}

function writeBackendEnv(installDir, vaultRoot, overrides = {}) {
  const envPath = getEnvPath(installDir);
  const lines = [
    `LECTURE_PIPELINE_VAULT_ROOT=${vaultRoot}`,
    `LECTURE_PIPELINE_SEMESTER_PATH=${overrides.semesterPath || "1_Semester_Master_WiWi"}`,
    `LECTURE_PIPELINE_STUDY_ROOT=${overrides.studyRoot || "10_Studium"}`,
    `LECTURE_PIPELINE_INBOX_DIR=${overrides.inboxDir || "99_Inbox/Audio"}`,
    `LECTURE_PIPELINE_LM_STUDIO_BASE_URL=${overrides.lmStudioUrl || "http://127.0.0.1:1234/v1"}`,
    `LECTURE_PIPELINE_LM_STUDIO_MODEL=${overrides.lmStudioModel || "qwen/qwen3.6-35b-a3b"}`,
    `LECTURE_PIPELINE_TRANSCRIPTION_MODEL=${overrides.transcriptionModel || "mlx-community/whisper-large-v3-turbo"}`,
    `LECTURE_PIPELINE_CHUNK_TARGET_CHARS=${overrides.chunkTargetChars || "14000"}`,
    `LECTURE_PIPELINE_IDLE_SHUTDOWN_SECONDS=${overrides.idleShutdownSeconds || "900"}`,
    `HF_TOKEN=${overrides.hfToken || ""}`,
  ];
  fs.writeFileSync(envPath, lines.join("\n") + "\n", "utf8");
}

// ────────────────────────────────────────────────────────────────────────────

class AudioFileSuggestModal extends FuzzySuggestModal {
  constructor(app, files, onChoose) {
    super(app);
    this.files = files;
    this.onChoose = onChoose;
    this.setPlaceholder("Audio- oder Video-Datei waehlen...");
  }

  getItems() {
    return this.files;
  }

  getItemText(file) {
    return file.path;
  }

  onChooseItem(file) {
    this.onChoose(file);
  }
}

class TranscriptFileSuggestModal extends FuzzySuggestModal {
  constructor(app, files, onChoose) {
    super(app);
    this.files = files;
    this.onChoose = onChoose;
    this.setPlaceholder("Transkript-Datei waehlen...");
  }

  getItems() {
    return this.files;
  }

  getItemText(file) {
    return file.path;
  }

  onChooseItem(file) {
    this.onChoose(file);
  }
}

class TranscriptProcessModal extends Modal {
  constructor(app, plugin, initialAudioPath = "") {
    super(app);
    const inferredCourse = plugin.guessCourseFromContext();
    const latestInboxAudio = plugin.getLatestInboxAudio();
    const activeTranscript = plugin.getActiveTranscriptFile();
    this.plugin = plugin;
    this.state = {
      sourceMode: initialAudioPath ? "audio" : activeTranscript ? "transcript" : "audio",
      audioPath: initialAudioPath || (latestInboxAudio ? latestInboxAudio.path : ""),
      transcriptPath: activeTranscript ? activeTranscript.path : "",
      course: inferredCourse || plugin.settings.courseOptions[0] || "",
      date: window.moment ? window.moment().format("YYYY-MM-DD") : new Date().toISOString().slice(0, 10),
      sessionType: plugin.getSessionProfile(plugin.settings.defaultSessionType)?.name || plugin.getSessionProfiles()[0]?.name || "Vorlesung",
      theme: "",
    };
    this.isSubmitting = false;
    this.statusEl = null;
    this.statusMessage = "Bereit.";
    this.statusKind = "neutral";
    this.submitButtonEl = null;
    this.cancelButtonEl = null;
    this.actionButtons = [];
    this.courseListId = `transcript-gui-course-list-${Date.now()}`;
    this.progressBarEl = null;
    this.progressPercentEl = null;
    this.progressStageEl = null;
    this.progressMessageEl = null;
    this.activeJobs = [];
    this.activeJobsSectionEl = null;
    this.activeJobsListEl = null;
    this.activeJobsPollIntervalId = null;
    this.pollToken = 0;
    this.lastTranscriptAutofillPath = "";
    this.isAutofillingTranscript = false;
    this.progressSnapshot = { progress: 0, stage: "idle", message: "Noch kein Job aktiv.", status: "idle" };
  }

  onOpen() {
    this.modalEl.addClass("transcript-gui-modal-host");
    this.modalEl.style.width = "min(1380px, calc(100vw - 2rem))";
    this.modalEl.style.maxWidth = "1380px";
    this.modalEl.style.maxHeight = "calc(100vh - 2rem)";
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("transcript-gui-modal");
    this.actionButtons = [];

    const shellEl = contentEl.createDiv({ cls: "transcript-gui-shell" });
    const heroEl = shellEl.createDiv({ cls: "transcript-gui-hero" });
    const heroTextEl = heroEl.createDiv({ cls: "transcript-gui-hero-copy" });
    const selectedProfile = this.plugin.getSessionProfile(this.state.sessionType);
    heroTextEl.createEl("h2", { text: "Sitzungstranskript importieren" });
    heroTextEl.createEl("p", {
      text: "Audio oder Video uebernehmen, fertige Rohtranskripte weiterverarbeiten und die lokale Pipeline direkt aus Obsidian steuern.",
    });
    heroTextEl.createEl("div", {
      cls: "transcript-gui-hero-note",
      text: "Video-Dateien werden automatisch auf ihre Tonspur reduziert. Fertige Rohtranskripte koennen direkt zusammengefasst werden.",
    });

    const badgeRowEl = heroEl.createDiv({ cls: "transcript-gui-badges" });
    this.createBadge(badgeRowEl, this.state.course ? this.state.course.replaceAll("_", " ") : "Kein Kontext", "Kontext");
    this.createBadge(badgeRowEl, this.state.sessionType, "Typ");
    this.createBadge(badgeRowEl, this.getSelectedSourceKindLabel(), "Quelle");
    this.createBadge(badgeRowEl, this.plugin.settings.inboxFolder, "Inbox");

    const lastRun = this.plugin.settings.lastRun;
    const workspaceEl = shellEl.createDiv({ cls: "transcript-gui-workspace" });
    const mainColumnEl = workspaceEl.createDiv({ cls: "transcript-gui-main-column" });
    const asideColumnEl = workspaceEl.createDiv({ cls: "transcript-gui-aside-column" });
    const formEl = mainColumnEl.createDiv({ cls: "transcript-gui-form" });

    const sourceSectionEl = this.createSection(
      formEl,
      "Quelle",
      "Waehle eine Audio- oder Video-Datei oder ein vorhandenes Rohtranskript aus dem Vault."
    );
    const sourceModeFieldEl = this.createField(sourceSectionEl, "Quelltyp");
    const sourceModeSelectEl = sourceModeFieldEl.createEl("select", { cls: "transcript-gui-select" });
    [
      { value: "audio", label: "Audio oder Video" },
      { value: "transcript", label: "Fertiges Transkript" },
    ].forEach((option) => {
      const optionEl = sourceModeSelectEl.createEl("option", { text: option.label, value: option.value });
      optionEl.value = option.value;
    });
    sourceModeSelectEl.value = this.state.sourceMode;
    sourceModeSelectEl.addEventListener("change", (event) => {
      this.state.sourceMode = event.target.value;
      this.onOpen();
    });

    if (this.state.sourceMode === "audio") {
      const audioFieldEl = this.createField(sourceSectionEl, "Audio- oder Video-Datei", "Pfad relativ zum Vault");
      const audioInputEl = audioFieldEl.createEl("input", { cls: "transcript-gui-input" });
      audioInputEl.type = "text";
      audioInputEl.placeholder = "99_Inbox/Audio/datei.m4a oder datei.mp4";
      audioInputEl.value = this.state.audioPath;
      audioInputEl.addEventListener("input", (event) => {
        this.state.audioPath = event.target.value.trim();
      });
      audioInputEl.addEventListener("change", () => this.onOpen());

      const audioActionsEl = sourceSectionEl.createDiv({ cls: "transcript-gui-inline-actions" });
      this.createActionButton(audioActionsEl, "Neueste Inbox-Datei", async () => {
        const latest = this.plugin.getLatestInboxAudio();
        if (!latest) {
          new Notice("Keine Audio- oder Video-Datei in der Inbox gefunden.");
          return;
        }
        this.state.audioPath = latest.path;
        this.onOpen();
      });
      this.createActionButton(audioActionsEl, "Neueste direkt starten", async () => {
        const latest = this.plugin.getLatestInboxAudio();
        if (!latest) {
          new Notice("Keine Audio- oder Video-Datei in der Inbox gefunden.");
          return;
        }
        this.state.audioPath = latest.path;
        await this.submit();
      });
      this.createActionButton(audioActionsEl, "Im Vault waehlen", () => this.chooseAudioFile());
      sourceSectionEl.createEl("div", {
        cls: "transcript-gui-hint transcript-gui-hint-accent",
        text: "Videos werden nur fuer ihre Tonspur genutzt. Die eigentliche Bildspur wird ignoriert.",
      });
    } else {
      const transcriptFieldEl = this.createField(sourceSectionEl, "Transkript-Datei", "Pfad zu .transcript.md oder .segments.json");
      const transcriptInputEl = transcriptFieldEl.createEl("input", { cls: "transcript-gui-input" });
      transcriptInputEl.type = "text";
      transcriptInputEl.placeholder = "10_Studium/.../Rohdaten/Transkripte/datei.transcript.md";
      transcriptInputEl.value = this.state.transcriptPath;
      transcriptInputEl.addEventListener("input", (event) => {
        this.state.transcriptPath = event.target.value.trim();
      });
      transcriptInputEl.addEventListener("change", () => this.onOpen());

      const transcriptActionsEl = sourceSectionEl.createDiv({ cls: "transcript-gui-inline-actions" });
      this.createActionButton(transcriptActionsEl, "Aktuelle Note nutzen", async () => {
        const activeTranscriptFile = this.plugin.getActiveTranscriptFile();
        if (!activeTranscriptFile) {
          new Notice("Aktive Datei ist kein unterstuetztes Rohtranskript.");
          return;
        }
        await this.autofillFromTranscriptPath(activeTranscriptFile.path, { showNotice: true });
      });
      this.createActionButton(transcriptActionsEl, "Im Vault waehlen", () => this.chooseTranscriptFile());
      this.createActionButton(transcriptActionsEl, "Metadaten laden", async () => {
        await this.autofillFromTranscriptPath(this.state.transcriptPath, { showNotice: true });
      });
      sourceSectionEl.createEl("div", {
        cls: "transcript-gui-hint",
        text: "Ideal, wenn die Transkription bereits vorliegt und nur noch die strukturierte Zusammenfassung erstellt werden soll.",
      });
    }

    const detailsGridEl = formEl.createDiv({ cls: "transcript-gui-grid" });
    const detailsSectionEl = this.createSection(
      detailsGridEl,
      "Sitzungsdaten",
      "Die Metadaten steuern Dateiname, Typ und Zielnote."
    );
    const contextSectionEl = this.createSection(
      detailsGridEl,
      "Kontext",
      "Kontext wird moeglichst automatisch erkannt und kann jederzeit angepasst werden."
    );

    const courseFieldEl = this.createField(contextSectionEl, "Kontext", "Ordnername oder Projektkontext im Vault");
    const courseInputEl = courseFieldEl.createEl("input", { cls: "transcript-gui-input" });
    courseInputEl.type = "text";
    courseInputEl.placeholder = "Oekonometrie";
    courseInputEl.value = this.state.course;
    courseInputEl.setAttribute("list", this.courseListId);
    courseInputEl.addEventListener("input", (event) => {
      this.state.course = event.target.value.trim();
    });
    courseInputEl.addEventListener("change", () => this.onOpen());
    const courseListEl = contextSectionEl.createEl("datalist", { attr: { id: this.courseListId } });
    for (const course of this.plugin.settings.courseOptions) {
      const optionEl = courseListEl.createEl("option");
      optionEl.value = course;
    }

    const themeFieldEl = this.createField(contextSectionEl, "Thema", "Wird fuer Dateiname und Notiz verwendet");
    const themeInputEl = themeFieldEl.createEl("input", { cls: "transcript-gui-input" });
    themeInputEl.type = "text";
    themeInputEl.placeholder = "Paneldaten und Fixed Effects";
    themeInputEl.value = this.state.theme;
    themeInputEl.addEventListener("input", (event) => {
      this.state.theme = event.target.value.trim();
    });
    themeInputEl.addEventListener("change", () => this.onOpen());

    const metaGridEl = detailsSectionEl.createDiv({ cls: "transcript-gui-meta-grid" });
    const dateFieldEl = this.createField(metaGridEl, "Datum");
    const dateInputEl = dateFieldEl.createEl("input", { cls: "transcript-gui-input" });
    dateInputEl.type = "date";
    dateInputEl.value = this.state.date;
    dateInputEl.addEventListener("input", (event) => {
      this.state.date = event.target.value.trim();
    });
    dateInputEl.addEventListener("change", () => this.onOpen());

    const typeFieldEl = this.createField(metaGridEl, "Sitzungstyp");
    const typeSelectEl = typeFieldEl.createEl("select", { cls: "transcript-gui-select" });
    this.plugin.getSessionProfiles().forEach((profile) => {
      const optionEl = typeSelectEl.createEl("option", { text: profile.name, value: profile.name });
      optionEl.value = profile.name;
    });
    typeSelectEl.value = selectedProfile?.name || this.plugin.getSessionProfiles()[0]?.name || "";
    typeSelectEl.addEventListener("change", (event) => {
      this.state.sessionType = event.target.value;
      this.onOpen();
    });

    const contextInfoEl = contextSectionEl.createDiv({ cls: "transcript-gui-info-card" });
    contextInfoEl.createEl("div", { cls: "transcript-gui-info-title", text: "Automatische Erkennung" });
    contextInfoEl.createEl("div", {
      cls: "transcript-gui-info-line",
      text: this.state.course ? `Vorausgewaehlter Kontext: ${this.state.course.replaceAll("_", " ")}` : "Noch kein Kontext erkannt",
    });
    contextInfoEl.createEl("div", {
      cls: "transcript-gui-info-line",
      text: this.state.sourceMode === "transcript" ? "Beim Rohtranskript werden Metadaten aus Frontmatter, Pfad und Dateiname uebernommen." : "Beim Audio-/Video-Import bleibt Thema und Kontext frei editierbar.",
    });
    if (!this.state.course) {
      this.createEmptyState(
        contextInfoEl,
        "Kontext fehlt noch",
        "Waehle einen Kontext manuell oder starte aus einer passenden Note heraus, damit die Ablage direkt korrekt gesetzt ist.",
        "is-compact"
      );
    }

    const history = this.plugin.settings.jobHistory || [];
    const historySectionEl = this.createSection(
      mainColumnEl,
      "Letzte Jobs",
      "Direkte Spruenge zu erzeugten Notizen, Rohtranskripten und Quelldateien."
    );
    if (history.length > 0) {
      const historyGridEl = historySectionEl.createDiv({ cls: "transcript-gui-history-grid" });
      history.slice(0, 6).forEach((entry) => this.renderHistoryEntry(historyGridEl, entry));
    } else {
      this.createEmptyState(
        historySectionEl,
        "Noch keine verarbeiteten Sitzungen",
        "Sobald ein Lauf erfolgreich oder fehlgeschlagen war, erscheint er hier mit Direktlinks zu Notiz, Rohtranskript und Quelle.",
      );
    }

    const asideStackEl = asideColumnEl.createDiv({ cls: "transcript-gui-sticky-stack" });

    this.activeJobsSectionEl = this.createSection(
      asideStackEl,
      "Aktive Jobs",
      "Laufende Jobs bleiben sichtbar, auch wenn du das Fenster zwischendurch schliesst."
    );
    this.activeJobsListEl = this.activeJobsSectionEl.createDiv({ cls: "transcript-gui-active-jobs-list" });
    this.renderActiveJobs();

    const summarySectionEl = this.createSection(
      asideStackEl,
      "Ueberblick",
      "Ein kompakter Check vor dem Start der Pipeline."
    );
    const summaryGridEl = summarySectionEl.createDiv({ cls: "transcript-gui-summary-grid" });
    this.createSummaryItem(summaryGridEl, "Quelle", this.getSelectedSourceKindLabel());
    this.createSummaryItem(summaryGridEl, "Typ", this.state.sessionType || "-");
    this.createSummaryItem(summaryGridEl, "Datum", this.state.date || "-");
    this.createSummaryItem(summaryGridEl, "Kontext", this.state.course ? this.state.course.replaceAll("_", " ") : "-");
    if (this.state.theme) {
      this.createSummaryItem(summaryGridEl, "Thema", this.state.theme, "is-wide");
    }
    if (this.getSelectedSourcePath()) {
      summarySectionEl.createDiv({ cls: "transcript-gui-source-preview", text: this.getSelectedSourcePath(), attr: { title: this.getSelectedSourcePath() } });
    } else {
      this.createEmptyState(
        summarySectionEl,
        "Quelle fehlt",
        "Waehle zuerst eine Audio-/Video-Datei oder ein vorhandenes Rohtranskript aus, bevor du die Pipeline startest.",
        "is-compact"
      );
    }

    const systemSectionEl = this.createSection(
      asideStackEl,
      "System",
      "Aktive Profil- und Backend-Einstellungen fuer diesen Lauf."
    );
    const systemInfoEl = systemSectionEl.createDiv({ cls: "transcript-gui-info-card is-compact" });
    systemInfoEl.createEl("div", {
      cls: "transcript-gui-info-line",
      text: `Backend: ${this.plugin.settings.backendUrl}`,
    });
    systemInfoEl.createEl("div", {
      cls: "transcript-gui-info-line",
      text: `Template: ${selectedProfile?.templatePath || "Standard-Template"}`,
    });
    systemInfoEl.createEl("div", {
      cls: "transcript-gui-info-line",
      text: `Zwischenspeicher: ${selectedProfile?.storageDir || "Standardpfad"}`,
    });
    systemInfoEl.createEl("div", {
      cls: "transcript-gui-info-line",
      text: `Zielordner: ${selectedProfile?.outputDir || "Standardpfad"}`,
    });

    if (lastRun) {
      const lastRunClass = lastRun.status === "failed" ? "transcript-gui-status is-error" : "transcript-gui-status is-success";
      const lastRunEl = asideStackEl.createDiv({ cls: `transcript-gui-run-summary ${lastRunClass}` });
      lastRunEl.createEl("div", { cls: "transcript-gui-run-title", text: "Letzter Lauf" });
      const metaEl = lastRunEl.createDiv({ cls: "transcript-gui-run-meta" });
      metaEl.createSpan({ text: lastRun.timestamp || "unbekannt" });
      metaEl.createSpan({ text: lastRun.status || "unbekannt" });
      if (lastRun.sessionType) {
        metaEl.createSpan({ text: lastRun.sessionType });
      }
      if (lastRun.course) {
        metaEl.createSpan({ text: lastRun.course.replaceAll("_", " ") });
      }
      if (lastRun.notePath) {
        lastRunEl.createDiv({ cls: "transcript-gui-run-path", text: lastRun.notePath });
      }
      if (lastRun.error) {
        lastRunEl.createDiv({ cls: "transcript-gui-run-path", text: lastRun.error });
      }
    } else {
      const lastRunEl = asideStackEl.createDiv({ cls: "transcript-gui-run-summary" });
      lastRunEl.createEl("div", { cls: "transcript-gui-run-title", text: "Letzter Lauf" });
      this.createEmptyState(
        lastRunEl,
        "Noch kein Lauf gestartet",
        "Nach dem ersten Durchlauf findest du hier den letzten Status und den direkten Sprung zur erzeugten Notiz.",
      );
    }

    const footerEl = asideStackEl.createDiv({ cls: "transcript-gui-footer" });
    const progressEl = footerEl.createDiv({ cls: "transcript-gui-progress" });
    const progressHeadEl = progressEl.createDiv({ cls: "transcript-gui-progress-head" });
    this.progressStageEl = progressHeadEl.createEl("div", { cls: "transcript-gui-progress-stage", text: "Bereit" });
    this.progressPercentEl = progressHeadEl.createEl("div", { cls: "transcript-gui-progress-percent", text: "0%" });
    const progressTrackEl = progressEl.createDiv({ cls: "transcript-gui-progress-track" });
    this.progressBarEl = progressTrackEl.createDiv({ cls: "transcript-gui-progress-bar" });
    this.progressMessageEl = progressEl.createEl("div", { cls: "transcript-gui-progress-message", text: "Noch kein Job aktiv." });

    const actionsEl = footerEl.createDiv({ cls: "transcript-gui-actions" });
    this.submitButtonEl = actionsEl.createEl("button", { text: this.isSubmitting ? "Verarbeite..." : "Pipeline starten", cls: "mod-cta", attr: { title: "Startet den aktuell konfigurierten Lauf" } });
    this.submitButtonEl.disabled = this.isSubmitting;
    this.submitButtonEl.addEventListener("click", () => this.submit());

    this.cancelButtonEl = actionsEl.createEl("button", { text: "Schliessen", attr: { title: "Schliesst dieses Fenster ohne einen neuen Lauf zu starten" } });
    this.cancelButtonEl.disabled = this.isSubmitting;
    this.cancelButtonEl.addEventListener("click", () => this.close());

    this.statusEl = footerEl.createDiv({ cls: "transcript-gui-status" });
    this.setStatus(this.statusMessage, this.statusKind);
    this.setProgress(this.progressSnapshot);
    this.startActiveJobsPolling();
    void this.refreshActiveJobs();

    if (this.state.sourceMode === "transcript" && this.state.transcriptPath && !this.isAutofillingTranscript && this.state.transcriptPath !== this.lastTranscriptAutofillPath) {
      void this.autofillFromTranscriptPath(this.state.transcriptPath);
    }
  }

  onClose() {
    this.pollToken += 1;
    this.stopActiveJobsPolling();
    this.modalEl.removeClass("transcript-gui-modal-host");
    this.modalEl.style.removeProperty("width");
    this.modalEl.style.removeProperty("max-width");
    this.modalEl.style.removeProperty("max-height");
    this.contentEl.empty();
  }

  createSection(parentEl, title, description = "") {
    const sectionEl = parentEl.createDiv({ cls: "transcript-gui-section" });
    const headingEl = sectionEl.createDiv({ cls: "transcript-gui-section-heading" });
    headingEl.createEl("h3", { text: title });
    if (description) {
      headingEl.createEl("p", { text: description });
    }
    return sectionEl;
  }

  createField(parentEl, label, description = "") {
    const fieldEl = parentEl.createDiv({ cls: "transcript-gui-field" });
    fieldEl.createEl("label", { cls: "transcript-gui-label", text: label });
    if (description) {
      fieldEl.createEl("div", { cls: "transcript-gui-field-description", text: description });
    }
    return fieldEl;
  }

  createBadge(parentEl, value, label) {
    const badgeEl = parentEl.createDiv({ cls: "transcript-gui-badge" });
    badgeEl.setAttribute("title", `${label}: ${value}`);
    badgeEl.createSpan({ cls: "transcript-gui-badge-label", text: label });
    badgeEl.createSpan({ cls: "transcript-gui-badge-value", text: value });
    return badgeEl;
  }

  createActionButton(parentEl, text, onClick) {
    const buttonEl = parentEl.createEl("button", { text, cls: "transcript-gui-secondary-button", attr: { title: text, "aria-label": text } });
    buttonEl.addEventListener("click", onClick);
    this.actionButtons.push(buttonEl);
    return buttonEl;
  }

  createSummaryItem(parentEl, label, value, modifier = "") {
    const itemEl = parentEl.createDiv({ cls: `transcript-gui-summary-item ${modifier}`.trim() });
    itemEl.createDiv({ cls: "transcript-gui-summary-label", text: label });
    itemEl.createDiv({ cls: "transcript-gui-summary-value", text: value || "-" });
    return itemEl;
  }

  createEmptyState(parentEl, title, description, modifier = "") {
    const emptyEl = parentEl.createDiv({ cls: `transcript-gui-empty-state ${modifier}`.trim() });
    emptyEl.createDiv({ cls: "transcript-gui-empty-title", text: title });
    emptyEl.createDiv({ cls: "transcript-gui-empty-copy", text: description });
    return emptyEl;
  }

  createJobStatusPill(parentEl, snapshot) {
    const label = snapshot.cancellation_requested ? "abbrechen..." : this.formatStage(snapshot.stage, snapshot.status);
    return parentEl.createSpan({ cls: `transcript-gui-job-pill ${snapshot.status || "running"}`, text: label });
  }

  getSelectedSourcePath() {
    return this.state.sourceMode === "audio" ? this.state.audioPath : this.state.transcriptPath;
  }

  getSelectedSourceKindLabel() {
    if (this.state.sourceMode === "transcript") {
      return "Rohtranskript";
    }
    return this.plugin.isVideoPath(this.state.audioPath) ? "Video (nur Tonspur)" : "Audio-Datei";
  }

  getJobTitle(snapshot) {
    return snapshot?.request?.theme || snapshot?.request?.audio_path || snapshot?.request?.transcript_path || snapshot?.job_id || "Aktiver Job";
  }

  renderActiveJobs() {
    if (!this.activeJobsListEl) {
      return;
    }
    this.activeJobsListEl.empty();
    if (!this.activeJobs.length) {
      this.createEmptyState(
        this.activeJobsListEl,
        "Keine laufenden Jobs",
        "Sobald eine Verarbeitung aktiv ist, erscheint sie hier mit Fortschritt und Abbrechen-Aktion.",
        "is-compact"
      );
      return;
    }

    this.activeJobs.forEach((snapshot) => {
      const cardEl = this.activeJobsListEl.createDiv({ cls: "transcript-gui-active-job-card" });
      const headEl = cardEl.createDiv({ cls: "transcript-gui-active-job-head" });
      headEl.createDiv({ cls: "transcript-gui-active-job-title", text: this.getJobTitle(snapshot) });
      this.createJobStatusPill(headEl, snapshot);

      const metaEl = cardEl.createDiv({ cls: "transcript-gui-active-job-meta" });
      if (snapshot.request?.course) {
        metaEl.createSpan({ text: String(snapshot.request.course).replaceAll("_", " ") });
      }
      if (snapshot.request?.session_type) {
        metaEl.createSpan({ text: snapshot.request.session_type });
      }
      metaEl.createSpan({ text: `${Number(snapshot.progress || 0)}%` });

      const trackEl = cardEl.createDiv({ cls: "transcript-gui-progress-track is-compact" });
      trackEl.createDiv({ cls: "transcript-gui-progress-bar", attr: { style: `width:${Math.max(0, Math.min(100, Number(snapshot.progress || 0)))}%` } });

      cardEl.createDiv({ cls: "transcript-gui-active-job-message", text: snapshot.error || snapshot.message || "Warte auf Status..." });

      const actionsEl = cardEl.createDiv({ cls: "transcript-gui-active-job-actions" });
      const cancelLabel = snapshot.cancellation_requested ? "Abbruch angefordert" : "Job abbrechen";
      const cancelButtonEl = actionsEl.createEl("button", { text: cancelLabel, cls: "transcript-gui-history-link", attr: { title: cancelLabel } });
      cancelButtonEl.disabled = Boolean(snapshot.cancellation_requested);
      cancelButtonEl.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await this.cancelActiveJob(snapshot.job_id);
      });
    });
  }

  startActiveJobsPolling() {
    this.stopActiveJobsPolling();
    this.activeJobsPollIntervalId = window.setInterval(() => {
      void this.refreshActiveJobs();
    }, 1200);
  }

  stopActiveJobsPolling() {
    if (this.activeJobsPollIntervalId) {
      window.clearInterval(this.activeJobsPollIntervalId);
      this.activeJobsPollIntervalId = null;
    }
  }

  async refreshActiveJobs() {
    try {
      const jobs = await this.plugin.getActiveLectureJobs();
      this.activeJobs = Array.isArray(jobs) ? jobs : [];
      this.renderActiveJobs();
      if (!this.isSubmitting) {
        if (this.activeJobs.length > 0) {
          const primaryJob = this.activeJobs[0];
          this.setProgress(primaryJob);
          this.setStatus(`${this.formatStage(primaryJob.stage, primaryJob.status)} (${primaryJob.progress || 0}%)\n${primaryJob.message || ""}`.trim(), "neutral");
        } else if (this.progressSnapshot.status !== "idle") {
          this.setProgress({ progress: 0, stage: "idle", message: "Noch kein Job aktiv.", status: "idle" });
          this.setStatus("Bereit.", "neutral");
        }
      }
    } catch (_error) {
      this.activeJobs = [];
      this.renderActiveJobs();
    }
  }

  async cancelActiveJob(jobId) {
    try {
      await this.plugin.cancelLectureJob(jobId);
      await this.refreshActiveJobs();
      new Notice("Job-Abbruch angefordert.");
    } catch (error) {
      new Notice(`Job konnte nicht abgebrochen werden: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  renderHistoryEntry(parentEl, entry) {
    const isFailed = entry.status === "failed";
    const cardEl = parentEl.createDiv({ cls: `transcript-gui-history-card ${isFailed ? "is-error" : "is-success"}` });

    const cardHeaderEl = cardEl.createDiv({ cls: "transcript-gui-history-header" });
    cardHeaderEl.createEl("div", { cls: "transcript-gui-history-title", text: entry.theme || "Unbenannter Lauf" });

    if (isFailed) {
      const deleteBtn = cardHeaderEl.createEl("button", { cls: "transcript-gui-history-delete", attr: { "aria-label": "Eintrag loeschen", title: "Eintrag loeschen" } });
      deleteBtn.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4h6v2"/></svg>`;
      deleteBtn.addEventListener("click", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await this.plugin.deleteHistoryEntry(entry.timestamp);
        this.onOpen();
      });
    }

    const metaEl = cardEl.createDiv({ cls: "transcript-gui-history-meta" });
    metaEl.createSpan({ text: entry.status || "unbekannt" });
    if (entry.sessionType) {
      metaEl.createSpan({ text: entry.sessionType });
    }
    if (entry.course) {
      metaEl.createSpan({ text: entry.course.replaceAll("_", " ") });
    }
    if (entry.timestamp) {
      metaEl.createSpan({ text: new Date(entry.timestamp).toLocaleString("de-DE") });
    }

    if (entry.error) {
      cardEl.createDiv({ cls: "transcript-gui-history-path", text: entry.error });
    }

    const actionsEl = cardEl.createDiv({ cls: "transcript-gui-history-actions" });
    if (entry.notePath) {
      this.createHistoryLink(actionsEl, "Notiz", () => this.plugin.openVaultPathFromAbsolutePath(entry.notePath));
    }
    if (entry.transcriptPath) {
      this.createHistoryLink(actionsEl, "Transkript", () => this.plugin.openVaultPathFromAbsolutePath(entry.transcriptPath));
    }
    if (entry.audioPath) {
      this.createHistoryLink(actionsEl, "Quelle", () => this.plugin.openVaultPathFromRelativeOrAbsolute(entry.audioPath));
    }
  }

  createHistoryLink(parentEl, text, onClick) {
    const buttonEl = parentEl.createEl("button", { text, cls: "transcript-gui-history-link", attr: { title: text, "aria-label": text } });
    buttonEl.addEventListener("click", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      await onClick();
    });
    return buttonEl;
  }

  async chooseAudioFile() {
    const audioFiles = this.plugin.getAllAudioFiles();
    if (audioFiles.length === 0) {
      new Notice("Keine Audio- oder Video-Dateien im Vault gefunden.");
      return;
    }
    new AudioFileSuggestModal(this.app, audioFiles, (file) => {
      this.state.audioPath = file.path;
      this.onOpen();
    }).open();
  }

  async chooseTranscriptFile() {
    const transcriptFiles = this.plugin.getAllTranscriptFiles();
    if (transcriptFiles.length === 0) {
      new Notice("Keine unterstuetzten Transkript-Dateien im Vault gefunden.");
      return;
    }
    new TranscriptFileSuggestModal(this.app, transcriptFiles, async (file) => {
      await this.autofillFromTranscriptPath(file.path, { showNotice: true });
    }).open();
  }

  async autofillFromTranscriptPath(pathLike, options = {}) {
    const { showNotice = false } = options;
    const transcriptPath = String(pathLike || "").trim();
    if (!transcriptPath) {
      return;
    }
    this.isAutofillingTranscript = true;
    this.lastTranscriptAutofillPath = transcriptPath;
    try {
      const metadata = await this.plugin.readTranscriptMetadata(transcriptPath);
      const hasMetadata = Boolean(metadata && (metadata.course || metadata.date || metadata.sessionType || metadata.theme));
      this.state.transcriptPath = transcriptPath;
      let changed = false;

      if (metadata?.course && metadata.course !== this.state.course) {
        this.state.course = metadata.course;
        changed = true;
      }
      if (metadata?.date && metadata.date !== this.state.date) {
        this.state.date = metadata.date;
        changed = true;
      }
      if (metadata?.theme && metadata.theme !== this.state.theme) {
        this.state.theme = metadata.theme;
        changed = true;
      }
      if (metadata?.sessionType && this.plugin.getSessionProfiles().some((profile) => profile.name === metadata.sessionType) && metadata.sessionType !== this.state.sessionType) {
        this.state.sessionType = metadata.sessionType;
        changed = true;
      }

      if (showNotice) {
        new Notice(hasMetadata ? "Metadaten aus dem Rohtranskript uebernommen." : "Transkript gewaehlt. Keine Metadaten erkannt.");
      }

      if (changed || showNotice) {
        this.onOpen();
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (showNotice) {
        new Notice(`Transkript-Metadaten konnten nicht geladen werden: ${message}`);
      }
    } finally {
      this.isAutofillingTranscript = false;
    }
  }

  setStatus(message, kind = "neutral") {
    this.statusMessage = message;
    this.statusKind = kind;
    if (!this.statusEl) {
      return;
    }
    this.statusEl.setText(message);
    this.statusEl.removeClass("is-error");
    this.statusEl.removeClass("is-success");
    if (kind === "error") {
      this.statusEl.addClass("is-error");
    }
    if (kind === "success") {
      this.statusEl.addClass("is-success");
    }
  }

  setBusy(isBusy) {
    this.isSubmitting = isBusy;
    for (const buttonEl of this.actionButtons) {
      buttonEl.disabled = isBusy;
    }
    if (this.submitButtonEl) {
      this.submitButtonEl.disabled = isBusy;
      this.submitButtonEl.textContent = isBusy ? "Verarbeite..." : "Pipeline starten";
    }
    if (this.cancelButtonEl) {
      this.cancelButtonEl.disabled = isBusy;
    }
  }

  setProgress(snapshot) {
    this.progressSnapshot = snapshot;
    if (!this.progressBarEl || !this.progressPercentEl || !this.progressStageEl || !this.progressMessageEl) {
      return;
    }
    const progress = Math.max(0, Math.min(100, Number(snapshot.progress || 0)));
    this.progressBarEl.style.width = `${progress}%`;
    this.progressPercentEl.setText(`${progress}%`);
    this.progressStageEl.setText(this.formatStage(snapshot.stage, snapshot.status));
    const message = snapshot.error || snapshot.message || "Warte auf Status...";
    const chunkSuffix = snapshot.current_chunk && snapshot.total_chunks ? ` (${snapshot.current_chunk}/${snapshot.total_chunks})` : "";
    this.progressMessageEl.setText(`${message}${chunkSuffix}`);
  }

  formatStage(stage, status) {
    if (status === "completed") {
      return "Abgeschlossen";
    }
    if (status === "failed") {
      return "Fehlgeschlagen";
    }

    const labels = {
      queued: "Warteschlange",
      ingest: "Audio uebernehmen",
      transcript_load: "Transkript laden",
      preprocess: "Vorverarbeitung",
      transcription: "Transkription",
      diarization: "Speaker-Erkennung",
      transcript_render: "Rohtranskript",
      summary_chunks: "Block-Zusammenfassung",
      summary_final: "Finale Synthese",
      note_render: "Notiz schreiben",
      completed: "Abgeschlossen",
      failed: "Fehlgeschlagen",
      idle: "Bereit",
    };
    return labels[stage] || stage || "Verarbeitung";
  }

  validate() {
    if (this.state.sourceMode === "audio" && !this.state.audioPath) {
      throw new Error("Bitte eine Audio- oder Video-Datei angeben.");
    }
    if (this.state.sourceMode === "transcript" && !this.state.transcriptPath) {
      throw new Error("Bitte eine Transkript-Datei angeben.");
    }
    if (!this.state.course) {
      throw new Error("Bitte einen Kontext angeben.");
    }
    if (!this.state.date) {
      throw new Error("Bitte ein Datum angeben.");
    }
    if (!this.state.theme) {
      throw new Error("Bitte ein Thema angeben.");
    }
  }

  async submit() {
    if (this.isSubmitting) {
      return;
    }
    try {
      this.validate();
    } catch (error) {
      this.setStatus(error.message, "error");
      return;
    }

    this.setBusy(true);
    this.setStatus("Pipeline wird gestartet...");
    this.setProgress({ progress: 0, stage: "queued", message: "Job wird an das Backend gesendet.", status: "queued" });
    const currentPollToken = ++this.pollToken;

    const payload = {
      course: this.state.course,
      date: this.state.date,
      session_type: this.state.sessionType,
      theme: this.state.theme,
      template_path: this.plugin.getSessionProfile(this.state.sessionType)?.templatePath || undefined,
      storage_dir: this.plugin.getSessionProfile(this.state.sessionType)?.storageDir || undefined,
      output_dir: this.plugin.getSessionProfile(this.state.sessionType)?.outputDir || undefined,
    };
    if (this.state.sourceMode === "audio") {
      payload.audio_path = this.state.audioPath;
    } else {
      payload.transcript_path = this.state.transcriptPath;
    }

    try {
      const result = await this.plugin.runLectureJob(payload, (snapshot) => {
        if (currentPollToken !== this.pollToken) {
          return;
        }
        this.setProgress(snapshot);
        if (snapshot.status === "running") {
          this.setStatus(`${this.formatStage(snapshot.stage, snapshot.status)} (${snapshot.progress || 0}%)\n${snapshot.message || ""}`.trim(), "neutral");
        }
      });

      const entry = {
        timestamp: new Date().toISOString(),
        jobId: result.job_id,
        status: "completed",
        notePath: result.note_path,
        transcriptPath: result.transcript_path,
        audioPath: this.state.sourceMode === "audio" ? this.state.audioPath : null,
        course: this.state.course,
        sessionType: this.state.sessionType,
        theme: this.state.theme,
      };
      this.setStatus(`Fertig.\nNote: ${result.note_path}\nRohtranskript: ${result.transcript_path}`, "success");
      await this.plugin.recordLastRun(entry);
      new Notice("Transkript-Pipeline erfolgreich abgeschlossen.");

      if (currentPollToken === this.pollToken) {
        this.onOpen();
      }

      if (this.plugin.settings.openNoteAfterProcessing && result.note_path) {
        await this.plugin.openVaultPathFromAbsolutePath(result.note_path);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus(`Fehler beim Verarbeiten:\n${message}`, "error");
      await this.plugin.recordLastRun({
        timestamp: new Date().toISOString(),
        status: "failed",
        error: message,
        audioPath: this.state.sourceMode === "audio" ? this.state.audioPath : null,
        course: this.state.course,
        sessionType: this.state.sessionType,
        theme: this.state.theme,
      });
      this.setProgress({ progress: 100, stage: "failed", message, status: "failed", error: message });
      new Notice("Transkript-Pipeline fehlgeschlagen.");
      if (currentPollToken === this.pollToken) {
        this.onOpen();
      }
    } finally {
      this.setBusy(false);
    }
  }
}

class TranscriptGuiSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Transcript GUI" });

    new Setting(containerEl)
      .setName("Backend URL")
      .setDesc("Adresse der lokalen lecture-pipeline API.")
      .addText((text) => {
        text.setPlaceholder("http://127.0.0.1:8765");
        text.setValue(this.plugin.settings.backendUrl);
        text.onChange(async (value) => {
          this.plugin.settings.backendUrl = value.trim() || DEFAULT_SETTINGS.backendUrl;
          await this.plugin.saveSettings();
        });
      });

    const installed = isBackendInstalled(this.plugin.app);
    const installDir = getBackendInstallDir(this.plugin.app);
    const executable = path.join(installDir, ".venv", "bin", "lecture-pipeline");
    const envFile = path.join(installDir, ".env");
    const hasExecutable = (() => { try { fs.accessSync(executable, fs.constants.X_OK); return true; } catch (_e) { return false; } })();
    const hasEnv = (() => { try { fs.accessSync(envFile, fs.constants.R_OK); return true; } catch (_e) { return false; } })();

    containerEl.createEl("h3", { text: "Backend" });

    let statusText = "";
    if (installed) {
      statusText = `Installiert im Plugin-Ordner (Version ${this.plugin.settings.backendVersion || "unbekannt"})`;
    } else if (hasExecutable && !hasEnv) {
      statusText = `Teilweise installiert: Das Backend-Programm existiert, aber die .env Datei fehlt. Klicke auf \"Jetzt installieren\" um die Installation zu reparieren.`;
    } else {
      statusText = "Noch nicht installiert. Das Backend wird im Plugin-Ordner verwaltet.";
    }
    containerEl.createEl("p", { text: statusText });
    containerEl.createEl("p", {
      cls: "setting-item-description",
      text: `Pfad: ${installDir}`,
    });

    new Setting(containerEl)
      .setName("Backend automatisch installieren")
      .setDesc("Fragt beim Start nach, wenn das Backend fehlt.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.backendAutoInstall);
        toggle.onChange(async (value) => {
          this.plugin.settings.backendAutoInstall = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Backend automatisch aktualisieren")
      .setDesc("Prüft beim Start auf Updates und fragt nach.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.backendAutoUpdate);
        toggle.onChange(async (value) => {
          this.plugin.settings.backendAutoUpdate = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Installation verwalten")
      .addButton((button) => {
        button.setButtonText(installed ? "Jetzt aktualisieren" : "Jetzt installieren");
        button.setCta();
        button.onClick(async () => {
          if (installed) {
            await this.plugin.uninstallBackend();
          }
          await this.plugin.installBackend();
          this.display();
        });
      })
      .addButton((button) => {
        button.setButtonText("Deinstallieren");
        button.setDisabled(!installed);
        button.onClick(async () => {
          await this.plugin.uninstallBackend();
          this.display();
        });
      });

    new Setting(containerEl)
      .setName("Inbox-Ordner")
      .setDesc("Hier sucht die GUI nach der neuesten Audio- oder Video-Datei.")
      .addText((text) => {
        text.setPlaceholder("99_Inbox/Audio");
        text.setValue(this.plugin.settings.inboxFolder);
        text.onChange(async (value) => {
          this.plugin.settings.inboxFolder = value.trim() || DEFAULT_SETTINGS.inboxFolder;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Standard-Sitzungstyp")
      .addDropdown((dropdown) => {
        this.plugin.getSessionProfiles().forEach((profile) => dropdown.addOption(profile.name, profile.name));
        dropdown.setValue(this.plugin.settings.defaultSessionType);
        dropdown.onChange(async (value) => {
          this.plugin.settings.defaultSessionType = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Notiz nach Erfolg oeffnen")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.openNoteAfterProcessing);
        toggle.onChange(async (value) => {
          this.plugin.settings.openNoteAfterProcessing = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Kontextoptionen")
      .setDesc("Ein Kontext pro Zeile. Wird im Modal als Schnellwahl angeboten.")
      .addTextArea((text) => {
        text.setValue(this.plugin.settings.courseOptions.join("\n"));
        text.inputEl.rows = 6;
        text.inputEl.cols = 40;
        text.onChange(async (value) => {
          this.plugin.settings.courseOptions = value
            .split("\n")
            .map((item) => item.trim())
            .filter(Boolean);
          await this.plugin.saveSettings();
        });
      });

    containerEl.createEl("h3", { text: "Typ-Profile" });
    containerEl.createEl("p", {
      text: "Jeder Typ kann eigene Template- und Ablagepfade bekommen. Platzhalter: {course}, {context}, {date}, {session_type}, {theme}, {stem}.",
    });

    const profiles = this.plugin.getSessionProfiles();
    profiles.forEach((profile, index) => {
      containerEl.createEl("h4", { text: profile.name || `Typ ${index + 1}` });

      new Setting(containerEl)
        .setName("Name")
        .setDesc("Anzeige im Auswahlfeld des Modals.")
        .addText((text) => {
          text.setValue(profile.name);
          text.onChange(async (value) => {
            const previousName = this.plugin.settings.sessionProfiles[index]?.name;
            this.plugin.settings.sessionProfiles[index].name = value.trim() || `Typ ${index + 1}`;
            this.plugin.settings.sessionProfiles = normalizeSessionProfiles(this.plugin.settings.sessionProfiles);
            if (this.plugin.settings.defaultSessionType === previousName) {
              this.plugin.settings.defaultSessionType = this.plugin.settings.sessionProfiles[index]?.name || this.plugin.settings.sessionProfiles[0].name;
            }
            await this.plugin.saveSettings();
          });
        });

      new Setting(containerEl)
        .setName("Template-Pfad")
        .setDesc("Optional. Relative Pfade werden vom Vault aus aufgeloest.")
        .addText((text) => {
          text.setPlaceholder("90_Templates/Meeting.md");
          text.setValue(profile.templatePath || "");
          text.onChange(async (value) => {
            this.plugin.settings.sessionProfiles[index].templatePath = value.trim();
            await this.plugin.saveSettings();
          });
        });

      new Setting(containerEl)
        .setName("Zwischenspeicher")
        .setDesc("Basisordner fuer Audio, Transkripte und Jobdateien.")
        .addText((text) => {
          text.setPlaceholder("10_Studium/1_Semester_Master_WiWi/{course}/Rohdaten");
          text.setValue(profile.storageDir || "");
          text.onChange(async (value) => {
            this.plugin.settings.sessionProfiles[index].storageDir = value.trim();
            await this.plugin.saveSettings();
          });
        });

      new Setting(containerEl)
        .setName("Zielordner")
        .setDesc("Hier landet die fertige Notiz.")
        .addText((text) => {
          text.setPlaceholder("10_Studium/1_Semester_Master_WiWi/{course}/Sitzungen");
          text.setValue(profile.outputDir || "");
          text.onChange(async (value) => {
            this.plugin.settings.sessionProfiles[index].outputDir = value.trim();
            await this.plugin.saveSettings();
          });
        })
        .addExtraButton((button) => {
          button.setIcon("trash");
          button.setTooltip("Profil loeschen");
          button.setDisabled(profiles.length <= 1);
          button.onClick(async () => {
            if (this.plugin.settings.sessionProfiles.length <= 1) {
              return;
            }
            const removed = this.plugin.settings.sessionProfiles[index];
            this.plugin.settings.sessionProfiles.splice(index, 1);
            this.plugin.settings.sessionProfiles = normalizeSessionProfiles(this.plugin.settings.sessionProfiles);
            if (this.plugin.settings.defaultSessionType === removed?.name) {
              this.plugin.settings.defaultSessionType = this.plugin.settings.sessionProfiles[0].name;
            }
            await this.plugin.saveSettings();
            this.display();
          });
        });
    });

    new Setting(containerEl)
      .setName("Neues Typ-Profil")
      .setDesc("Zum Beispiel fuer Meetings, Calls oder Protokolle.")
      .addButton((button) => {
        button.setButtonText("Profil hinzufuegen");
        button.onClick(async () => {
          this.plugin.settings.sessionProfiles = normalizeSessionProfiles([
            ...this.plugin.settings.sessionProfiles,
            {
              name: `Typ ${this.plugin.settings.sessionProfiles.length + 1}`,
              templatePath: "",
              storageDir: this.plugin.settings.sessionProfiles[0]?.storageDir || DEFAULT_SETTINGS.sessionProfiles[0].storageDir,
              outputDir: this.plugin.settings.sessionProfiles[0]?.outputDir || DEFAULT_SETTINGS.sessionProfiles[0].outputDir,
            },
          ]);
          await this.plugin.saveSettings();
          this.display();
        });
      });
  }
}

module.exports = class TranscriptGuiPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.backendStartPromise = null;
    this.lastBackendPid = null;

    // Auto-install / auto-update backend (non-blocking)
    if (this.settings.backendAutoInstall) {
      window.setTimeout(() => {
        void this.handleBackendLifecycle();
      }, 1200);
    }

    this.addRibbonIcon("audio-file", "Transcript GUI", () => this.openProcessModal());

    this.addCommand({
      id: "open-transcript-gui",
      name: "Open transcript GUI",
      callback: () => this.openProcessModal(),
    });

    this.addCommand({
      id: "open-transcript-gui-with-latest-inbox-audio",
      name: "Open transcript GUI with latest inbox media",
      callback: () => {
        const latest = this.getLatestInboxAudio();
        this.openProcessModal(latest ? latest.path : "");
      },
    });

    this.addCommand({
      id: "process-latest-inbox-audio",
      name: "Process latest inbox media",
      callback: async () => {
        const latest = this.getLatestInboxAudio();
        if (!latest) {
          new Notice("Keine Audio- oder Video-Datei in der Inbox gefunden.");
          return;
        }
        const course = this.guessCourseFromContext() || this.settings.courseOptions[0] || "";
        if (!course) {
          this.openProcessModal(latest.path);
          new Notice("Kein Kontext erkannt. Modal wurde zum Pruefen geoeffnet.");
          return;
        }

        const sessionProfile = this.getSessionProfile(this.settings.defaultSessionType);

        const payload = {
          audio_path: latest.path,
          course,
          date: window.moment ? window.moment().format("YYYY-MM-DD") : new Date().toISOString().slice(0, 10),
          session_type: this.settings.defaultSessionType,
          theme: this.suggestThemeFromAudio(latest),
          template_path: sessionProfile?.templatePath || undefined,
          storage_dir: sessionProfile?.storageDir || undefined,
          output_dir: sessionProfile?.outputDir || undefined,
        };

        try {
          new Notice(`Starte Verarbeitung fuer ${latest.name}...`);
          const result = await this.runLectureJob(payload);
          await this.recordLastRun({
            timestamp: new Date().toISOString(),
            jobId: result.job_id,
            status: "completed",
            notePath: result.note_path,
            transcriptPath: result.transcript_path,
            audioPath: latest.path,
            course,
            sessionType: payload.session_type,
            theme: payload.theme,
          });
          new Notice(`Verarbeitung abgeschlossen: ${payload.theme}`);
          if (this.settings.openNoteAfterProcessing) {
            await this.openVaultPathFromAbsolutePath(result.note_path);
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          await this.recordLastRun({
            timestamp: new Date().toISOString(),
            status: "failed",
            error: message,
            audioPath: latest.path,
            course,
            sessionType: payload.session_type,
            theme: payload.theme,
          });
          new Notice(`Verarbeitung fehlgeschlagen: ${message}`);
        }
      },
    });

    this.addCommand({
      id: "check-transcript-backend-health",
      name: "Check transcript backend health",
      callback: async () => {
        try {
          const payload = await this.ensureBackendAvailable();
          new Notice(`Backend ok: ${payload.lm_studio_model}`);
        } catch (error) {
          new Notice(`Backend nicht erreichbar: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    });

    this.addCommand({
      id: "start-transcript-backend",
      name: "Start transcript backend",
      callback: async () => {
        try {
          const payload = await this.ensureBackendAvailable({ forceStart: true });
          new Notice(`Backend ok: ${payload.lm_studio_model}`);
        } catch (error) {
          new Notice(`Backend nicht erreichbar: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    });

    this.addSettingTab(new TranscriptGuiSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = normalizeSettings(await this.loadData());
  }

  async saveSettings() {
    this.settings = normalizeSettings(this.settings);
    await this.saveData(this.settings);
  }

  getSessionProfiles() {
    return normalizeSessionProfiles(this.settings.sessionProfiles);
  }

  getSessionProfile(name) {
    const profiles = this.getSessionProfiles();
    return profiles.find((profile) => profile.name === name) || profiles[0] || null;
  }

  async recordLastRun(payload) {
    this.settings.lastRun = payload;
    const history = Array.isArray(this.settings.jobHistory) ? this.settings.jobHistory : [];
    this.settings.jobHistory = [payload, ...history.filter((entry) => entry.timestamp !== payload.timestamp)].slice(0, 12);
    await this.saveSettings();
  }

  async deleteHistoryEntry(timestamp) {
    const history = Array.isArray(this.settings.jobHistory) ? this.settings.jobHistory : [];
    this.settings.jobHistory = history.filter((entry) => entry.timestamp !== timestamp);
    // Also clear lastRun if it matches the deleted entry.
    if (this.settings.lastRun?.timestamp === timestamp) {
      this.settings.lastRun = this.settings.jobHistory[0] || null;
    }
    await this.saveSettings();
  }

  openProcessModal(initialAudioPath = "") {
    new TranscriptProcessModal(this.app, this, initialAudioPath).open();
  }

  isVideoPath(pathLike) {
    const extension = String(pathLike || "").split(".").pop()?.toLowerCase();
    return VIDEO_EXTENSIONS.has(extension || "");
  }

  getAllAudioFiles() {
    return this.app.vault.getFiles().filter((file) => {
      const extension = file.extension?.toLowerCase();
      return MEDIA_EXTENSIONS.has(extension);
    });
  }

  isTranscriptFile(file) {
    return Boolean(file?.path?.endsWith(".transcript.md") || file?.path?.endsWith(".segments.json"));
  }

  getAllTranscriptFiles() {
    return this.app.vault.getFiles().filter((file) => this.isTranscriptFile(file));
  }

  getActiveTranscriptFile() {
    const activeFile = this.app.workspace.getActiveFile();
    return this.isTranscriptFile(activeFile) ? activeFile : null;
  }

  inferContextFromTranscriptPath(pathLike) {
    const parts = String(pathLike || "").split("/").filter(Boolean);
    const rawIndex = parts.indexOf("Rohdaten");
    if (rawIndex > 0) {
      return parts[rawIndex - 1];
    }
    for (const course of this.settings.courseOptions) {
      if (parts.includes(course)) {
        return course;
      }
    }
    return "";
  }

  extractFrontmatterValue(text, key) {
    const frontmatterMatch = String(text || "").match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatterMatch) {
      return "";
    }
    const fieldMatch = frontmatterMatch[1].match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
    return fieldMatch ? stripWrappedQuotes(fieldMatch[1]) : "";
  }

  async readTranscriptMetadata(pathLike) {
    const normalizedPath = normalizePath(String(pathLike || "").trim());
    if (!normalizedPath) {
      return null;
    }

    const sourceFile = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (!sourceFile || sourceFile.children) {
      return null;
    }

    const stemMetadata = parseTranscriptStem(sourceFile.name);
    let transcriptFile = sourceFile;
    if (sourceFile.path.endsWith(".segments.json")) {
      const siblingPath = normalizePath(sourceFile.path.replace(/\.segments\.json$/i, ".transcript.md"));
      const siblingFile = this.app.vault.getAbstractFileByPath(siblingPath);
      if (siblingFile && !siblingFile.children) {
        transcriptFile = siblingFile;
      }
    }

    const metadata = {
      course: this.inferContextFromTranscriptPath(transcriptFile.path || normalizedPath),
      date: stemMetadata.date,
      sessionType: stemMetadata.sessionType,
      theme: stemMetadata.theme,
    };

    if (transcriptFile.path.endsWith(".transcript.md")) {
      const text = await this.app.vault.cachedRead(transcriptFile);
      const kursLink = this.extractFrontmatterValue(text, "KursLink");
      const kurs = this.extractFrontmatterValue(text, "Kurs");
      const datum = this.extractFrontmatterValue(text, "Datum");
      const sitzungstyp = this.extractFrontmatterValue(text, "Sitzungstyp");
      const thema = this.extractFrontmatterValue(text, "Thema");

      if (kursLink) {
        metadata.course = extractWikiLinkTarget(kursLink);
      } else if (kurs) {
        metadata.course = kurs;
      }
      if (datum) {
        metadata.date = datum;
      }
      if (sitzungstyp) {
        metadata.sessionType = sitzungstyp;
      }
      if (thema) {
        metadata.theme = thema;
      }
    }

    return metadata;
  }

  getLatestInboxAudio() {
    const folderPath = normalizePath(this.settings.inboxFolder);
    return this.getAllAudioFiles()
      .filter((file) => file.path.startsWith(folderPath + "/") || file.path === folderPath)
      .sort((a, b) => b.stat.mtime - a.stat.mtime)[0] || null;
  }

  guessCourseFromContext() {
    const activeFile = this.app.workspace.getActiveFile();
    if (!activeFile) {
      return "";
    }

    const cache = this.app.metadataCache.getFileCache(activeFile);
    const kursLink = cache?.frontmatter?.KursLink;
    if (typeof kursLink === "string") {
      const match = kursLink.match(/\[\[(.+?)\]\]/);
      if (match) {
        return match[1];
      }
    }

    const pathParts = activeFile.path.split("/");
    for (const course of this.settings.courseOptions) {
      if (pathParts.includes(course)) {
        return course;
      }
    }

    return "";
  }

  suggestThemeFromAudio(file) {
    const stem = (file?.basename || file?.name || "Aufnahme").replace(/[_-]+/g, " ").trim();
    return stem || "Aufnahme";
  }

  async processLecture(payload) {
    await this.ensureBackendAvailable();
    const response = await requestUrl({
      url: `${this.settings.backendUrl}/process`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (response.status >= 400) {
      throw new Error(response.text || `Backend-Fehler ${response.status}`);
    }
    return response.json;
  }

  async startLectureJob(payload) {
    await this.ensureBackendAvailable();
    const response = await requestUrl({
      url: `${this.settings.backendUrl}/jobs`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (response.status >= 400) {
      throw new Error(response.text || `Backend-Fehler ${response.status}`);
    }
    return response.json;
  }

  async getJobStatus(jobId) {
    const response = await requestUrl({
      url: `${this.settings.backendUrl}/jobs/${jobId}`,
      method: "GET",
    });
    if (response.status >= 400) {
      throw new Error(response.text || `Job-Status konnte nicht geladen werden (${response.status})`);
    }
    return response.json;
  }

  async getActiveLectureJobs() {
    await this.ensureBackendAvailable();
    const response = await requestUrl({
      url: `${this.settings.backendUrl}/jobs`,
      method: "GET",
    });
    if (response.status >= 400) {
      throw new Error(response.text || `Aktive Jobs konnten nicht geladen werden (${response.status})`);
    }
    return response.json?.jobs || [];
  }

  async cancelLectureJob(jobId) {
    await this.ensureBackendAvailable();
    const response = await requestUrl({
      url: `${this.settings.backendUrl}/jobs/${jobId}/cancel`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
    if (response.status >= 400) {
      throw new Error(response.text || `Job konnte nicht abgebrochen werden (${response.status})`);
    }
    return response.json;
  }

  async runLectureJob(payload, onUpdate) {
    const handle = await this.startLectureJob(payload);
    if (onUpdate) {
      onUpdate(handle);
    }

    while (true) {
      const snapshot = await this.getJobStatus(handle.job_id);
      if (onUpdate) {
        onUpdate(snapshot);
      }
      if (snapshot.status === "completed") {
        return snapshot;
      }
      if (snapshot.status === "failed") {
        throw new Error(snapshot.error || snapshot.message || "Job fehlgeschlagen.");
      }
      await new Promise((resolve) => window.setTimeout(resolve, 900));
    }
  }

  async openVaultPathFromRelativeOrAbsolute(pathLike) {
    if (!pathLike) {
      return;
    }
    if (pathLike.startsWith("/") || /^[A-Za-z]:[\\/]/.test(pathLike)) {
      return this.openVaultPathFromAbsolutePath(pathLike);
    }
    const file = this.app.vault.getAbstractFileByPath(pathLike);
    if (!file) {
      new Notice(`Datei nicht im Vault gefunden: ${pathLike}`);
      return;
    }
    await this.app.workspace.getLeaf(true).openFile(file);
  }

  async openVaultPathFromAbsolutePath(absolutePath) {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      return;
    }

    const basePath = adapter.getBasePath();
    if (!absolutePath.startsWith(basePath)) {
      return;
    }

    const relativePath = absolutePath.slice(basePath.length).replace(/^[/\\]/, "").replace(/\\/g, "/");
    const file = this.app.vault.getAbstractFileByPath(relativePath);
    if (!file) {
      new Notice(`Datei nicht im Vault gefunden: ${relativePath}`);
      return;
    }

    await this.app.workspace.getLeaf(true).openFile(file);
  }

  async openNoteFromAbsolutePath(absolutePath) {
    await this.openVaultPathFromAbsolutePath(absolutePath);
  }

  // ── Backend Lifecycle ────────────────────────────────────────────────────

  async handleBackendLifecycle() {
    const installed = isBackendInstalled(this.app);
    if (!installed) {
      await this.promptInstallBackend();
      return;
    }
    if (this.settings.backendAutoUpdate) {
      await this.promptUpdateBackendIfNeeded();
    }
  }

  async promptInstallBackend() {
    const modal = new Modal(this.app);
    modal.titleEl.setText("Backend Installation");
    const content = modal.contentEl;
    content.createEl("p", {
      text: "Das Obsidian-Transcript-Server-Backend wurde noch nicht installiert. Es wird im Plugin-Ordner eingerichtet.",
    });
    const actions = content.createDiv({ cls: "transcript-gui-inline-actions" });
    const installBtn = actions.createEl("button", { text: "Jetzt installieren", cls: "mod-cta" });
    const skipBtn = actions.createEl("button", { text: "Später" });

    installBtn.addEventListener("click", async () => {
      modal.close();
      await this.installBackend();
    });
    skipBtn.addEventListener("click", () => {
      modal.close();
    });
    modal.open();
  }

  async installBackend() {
    const installDir = getBackendInstallDir(this.app);
    const notice = new Notice("Backend wird heruntergeladen und installiert...", 0);

    try {
      // Check prerequisites
      notice.setMessage("Prüfe Voraussetzungen...");
      const pythonInfo = await findPythonCommand();
      if (!pythonInfo) {
        throw new Error("Python 3 ist nicht installiert oder nicht im PATH. Bitte installiere Python 3.11+ (z.B. via Homebrew: brew install python@3.11).");
      }
      if (pythonInfo.version.major < 3 || (pythonInfo.version.major === 3 && pythonInfo.version.minor < 11)) {
        throw new Error(`Python 3.11+ wird benötigt, aber gefunden: ${pythonInfo.version.raw}. Bitte installiere Python 3.11+ (z.B. via Homebrew: brew install python@3.11).`);
      }
      const pythonCmd = pythonInfo.cmd;

      const ffmpegPath = await resolveCommandPath("ffmpeg");
      if (!ffmpegPath) {
        throw new Error("ffmpeg ist nicht installiert oder nicht im PATH. Bitte installiere ffmpeg (z.B. via Homebrew: brew install ffmpeg).");
      }

      // Clean up any partial or previous installation to ensure a fresh start
      if (fs.existsSync(installDir)) {
        notice.setMessage("Bereite Installation vor...");
        try {
          fs.rmSync(installDir, { recursive: true, force: true });
        } catch (_error) {
          // Ignore cleanup errors
        }
      }

      fs.mkdirSync(installDir, { recursive: true });

      const tarPath = path.join(installDir, "backend.tar.gz");
      await downloadFile(BACKEND_DOWNLOAD_URL, tarPath);

      notice.setMessage("Backend wird entpackt...");
      await extractTarGz(tarPath, installDir);

      // Find extracted folder (usually Obsidian-Transcript-Server-main)
      const extracted = fs.readdirSync(installDir).find((d) => d.startsWith("Obsidian-Transcript-Server"));
      if (!extracted) {
        throw new Error("Entpacktes Backend-Verzeichnis nicht gefunden.");
      }
      const sourceDir = path.join(installDir, extracted);

      // Copy .env.example to install dir before installation
      const envExamplePath = path.join(sourceDir, ".env.example");
      if (fs.existsSync(envExamplePath)) {
        fs.copyFileSync(envExamplePath, path.join(installDir, ".env.example"));
      }

      notice.setMessage("Python-Umgebung wird erstellt...");
      await execPromise(`${pythonCmd} -m venv "${path.join(installDir, ".venv")}"`, { cwd: installDir });

      notice.setMessage("Backend-Abhängigkeiten werden installiert (das kann einige Minuten dauern)...");
      const pip = path.join(installDir, ".venv", "bin", "pip");
      await execPromise(`"${pip}" install -e "${sourceDir}"`, { cwd: installDir });

      // Optional audio dependencies
      try {
        await execPromise(`"${pip}" install -e "${sourceDir}[audio]"`, { cwd: installDir });
      } catch (_error) {
        // Audio dependencies are optional; log silently
      }

      // Create .env with vault root
      const adapter = this.app.vault.adapter;
      let vaultRoot = "";
      if (adapter instanceof FileSystemAdapter) {
        vaultRoot = adapter.getBasePath();
      }
      if (!vaultRoot) {
        throw new Error("Konnte den Vault-Pfad nicht ermitteln. Bitte stelle sicher, dass dies ein lokaler Vault ist (kein iCloud Drive, OneDrive oder ähnliches als primärer Speicherort).");
      }

      writeBackendEnv(installDir, vaultRoot, {
        inboxDir: this.settings.inboxFolder || "99_Inbox/Audio",
      });

      // Cleanup
      fs.unlinkSync(tarPath);
      fs.rmSync(sourceDir, { recursive: true, force: true });

      this.settings.backendVersion = "0.1.0";
      await this.saveSettings();

      notice.hide();
      new Notice("Backend erfolgreich installiert.", 4000);
    } catch (error) {
      notice.hide();
      new Notice(`Backend-Installation fehlgeschlagen: ${error.message}`, 8000);
      throw error;
    }
  }

  async uninstallBackend() {
    const installDir = getBackendInstallDir(this.app);
    try {
      // Try to stop any running backend process
      if (this.lastBackendPid) {
        try {
          process.kill(this.lastBackendPid, 0); // Check if process exists
          process.kill(this.lastBackendPid, "SIGTERM");
        } catch (_e) {
          // Process already gone
        }
        this.lastBackendPid = null;
      }
      fs.rmSync(installDir, { recursive: true, force: true });
      this.settings.backendVersion = "";
      await this.saveSettings();
      new Notice("Backend deinstalliert.", 4000);
    } catch (error) {
      new Notice(`Deinstallation fehlgeschlagen: ${error.message}`, 6000);
    }
  }

  async checkBackendUpdateAvailable() {
    // For now, we compare against a hardcoded remote version.
    // In the future this could fetch package.json or a VERSION file from the repo.
    const remoteVersion = "0.1.0";
    return this.settings.backendVersion !== remoteVersion;
  }

  async promptUpdateBackendIfNeeded() {
    const available = await this.checkBackendUpdateAvailable();
    if (!available) {
      return;
    }
    const modal = new Modal(this.app);
    modal.titleEl.setText("Backend-Update verfügbar");
    modal.contentEl.createEl("p", { text: "Eine neue Version des Backends ist verfügbar. Möchtest du jetzt aktualisieren?" });
    const actions = modal.contentEl.createDiv({ cls: "transcript-gui-inline-actions" });
    const updateBtn = actions.createEl("button", { text: "Aktualisieren", cls: "mod-cta" });
    const skipBtn = actions.createEl("button", { text: "Später" });

    updateBtn.addEventListener("click", async () => {
      modal.close();
      await this.uninstallBackend();
      await this.installBackend();
    });
    skipBtn.addEventListener("click", () => {
      modal.close();
    });
    modal.open();
  }

  getBackendExecutablePath() {
    return getBackendExecutablePath(this.app);
  }

  // ── Backend Communication ────────────────────────────────────────────────

  async ensureBackendAvailable(options = {}) {
    const { forceStart = false } = options;
    try {
      return await this.fetchBackendHealth();
    } catch (error) {
      if (!forceStart) {
        throw error;
      }
    }

    // Verify backend is actually installed before attempting to start
    if (!isBackendInstalled(this.app)) {
      throw new Error("Backend ist nicht installiert. Öffne die Plugin-Einstellungen und klicke auf \"Jetzt installieren\".");
    }

    if (!this.backendStartPromise) {
      this.backendStartPromise = this.startBackendProcess().finally(() => {
        this.backendStartPromise = null;
      });
    }
    await this.backendStartPromise;
    return this.fetchBackendHealth();
  }

  async fetchBackendHealth() {
    const response = await requestUrl({ url: `${this.settings.backendUrl}/health`, method: "GET" });
    if (response.status >= 400) {
      throw new Error(response.text || `Backend-Fehler ${response.status}`);
    }
    return response.json;
  }

  async startBackendProcess() {
    const installDir = getBackendInstallDir(this.app);
    const executable = this.getBackendExecutablePath();

    const extraPaths = [
      "/opt/homebrew/bin",
      "/opt/homebrew/sbin",
      "/usr/local/bin",
      "/opt/local/bin",
    ];
    const basePath = process.env.PATH || "";
    const patchedPath = [...new Set([...extraPaths, ...basePath.split(":")])]
      .filter(Boolean)
      .join(":");

    // Pre-flight check: ensure executable works before spawning detached
    try {
      await execPromise(`"${executable}" --help`, { cwd: installDir, env: { ...process.env, PATH: patchedPath } });
    } catch (_error) {
      throw new Error("Backend-Installation scheint beschädigt zu sein. Versuche eine Neuinstallation über die Plugin-Einstellungen.");
    }

    const logPath = path.join(installDir, "backend.log");
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    logStream.write(`\n--- Backend started at ${new Date().toISOString()} (PID: ${this.lastBackendPid || "unknown"}) ---\n`);

    const command = `"${executable}" serve --host 127.0.0.1 --port 8765`;
    const child = spawn(command, {
      cwd: installDir,
      shell: true,
      detached: true,
      stdio: ["ignore", logStream, logStream],
      env: { ...process.env, PATH: patchedPath },
    });
    child.unref();
    this.lastBackendPid = child.pid;

    const timeoutMs = 30000;
    const startedAt = Date.now();
    while (Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => window.setTimeout(resolve, 750));
      try {
        await this.fetchBackendHealth();
        return;
      } catch (_error) {
        // wait until backend responds or timeout expires
      }
    }

    throw new Error(`Backend konnte nicht rechtzeitig gestartet werden. Prüfe das Log: ${logPath}`);
  }
};

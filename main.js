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
const BACKEND_VERSION = "0.2.7";
const BACKEND_DOWNLOAD_URL = `https://github.com/${BACKEND_REPO_OWNER}/${BACKEND_REPO_NAME}/archive/refs/tags/v${BACKEND_VERSION}.tar.gz`;

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

const DEFAULT_PROMPT_PROFILES = [
  {
    id: "vorlesung",
    name: "Vorlesung",
    zusammenfassungs_stil: "Du analysierst deutsche Vorlesungstranskripte fuer Obsidian-Notizen. Arbeite streng quellennah. Erfinde nichts. Speaker 1 ist wahrscheinlich die dozierende Person. Ignoriere irrelevanten Smalltalk.",
    notiz_stil: "Du erstellst praezise deutschsprachige Vorlesungsnotizen fuer Obsidian. Schreibe sachlich, knapp und fachlich. Erfinde nichts.",
    lmStudioModel: "",
    temperature: 0.1,
    topP: 0.8,
  },
  {
    id: "kompakt",
    name: "Kompakt",
    zusammenfassungs_stil: "Du fasst deutsche Vorlesungstranskripte kompakt zusammen. Konzentriere dich auf Kernaussagen und Definitionen. Ignoriere Smalltalk und Wiederholungen.",
    notiz_stil: "Du erstellst kompakte deutschsprachige Notizen fuer Obsidian. Sehr kurz und sachlich. Keine Fuellungen.",
    lmStudioModel: "",
    temperature: 0.2,
    topP: 0.8,
  },
  {
    id: "meeting",
    name: "Meeting",
    zusammenfassungs_stil: "Du analysierst deutsche Meeting- oder Besprechungstranskripte. Fokussiere auf Entscheidungen, Aktionspunkte und Verantwortliche.",
    notiz_stil: "Du erstellst strukturierte deutsche Meeting-Notizen fuer Obsidian. Hebe Entscheidungen, Aktionspunkte und Verantwortliche hervor.",
    lmStudioModel: "",
    temperature: 0.15,
    topP: 0.8,
  },
];

const SPEAKER_LABEL_MODE_OPTIONS = [
  { value: "professor", label: "Speaker 1 = Prof" },
  { value: "generic", label: "Speaker 1, 2, 3..." },
];

const DEFAULT_SETTINGS = {
  backendUrl: "http://127.0.0.1:8765",
  backendAutoInstall: true,
  backendAutoUpdate: true,
  backendVersion: "",
  inboxFolder: "99_Inbox/Audio",
  defaultSessionType: "Vorlesung",
  defaultPromptProfile: "vorlesung",
  defaultSpeakerLabelMode: "professor",
  openNoteAfterProcessing: true,
  lastRun: null,
  jobHistory: [],
  sessionProfiles: DEFAULT_SESSION_PROFILES.map((profile) => ({ ...profile })),
  promptProfiles: DEFAULT_PROMPT_PROFILES.map((profile) => ({ ...profile })),
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

function normalizePromptProfiles(profiles) {
  const fallback = DEFAULT_PROMPT_PROFILES.map((profile) => ({ ...profile }));
  if (!Array.isArray(profiles) || profiles.length === 0) {
    return fallback;
  }

  const normalized = [];
  const seen = new Set();
  profiles.forEach((profile, index) => {
    const fallbackProfile = fallback[index] || fallback[0];
    const id = String(profile?.id || fallbackProfile.id || `profile_${index + 1}`).trim();
    if (!id || seen.has(id)) {
      return;
    }
    seen.add(id);
    const temperature = profile?.temperature ?? fallbackProfile.temperature ?? 0.1;
    const topP = profile?.topP ?? profile?.top_p ?? fallbackProfile.topP ?? 0.8;
    normalized.push({
      id,
      name: String(profile?.name || fallbackProfile.name || `Profil ${index + 1}`).trim(),
      zusammenfassungs_stil: String(profile?.zusammenfassungs_stil ?? fallbackProfile.zusammenfassungs_stil ?? ""),
      notiz_stil: String(profile?.notiz_stil ?? fallbackProfile.notiz_stil ?? ""),
      lmStudioModel: String(profile?.lmStudioModel || profile?.lm_studio_model || fallbackProfile.lmStudioModel || "").trim(),
      temperature: Number.isFinite(Number(temperature)) ? Number(temperature) : 0.1,
      topP: Number.isFinite(Number(topP)) ? Number(topP) : 0.8,
    });
  });

  return normalized.length > 0 ? normalized : fallback;
}

function normalizeSpeakerLabelMode(value) {
  return value === "generic" ? "generic" : "professor";
}

function normalizeSettings(data) {
  const settings = Object.assign({}, DEFAULT_SETTINGS, data || {});
  settings.defaultSpeakerLabelMode = normalizeSpeakerLabelMode(data?.defaultSpeakerLabelMode || settings.defaultSpeakerLabelMode);
  settings.sessionProfiles = normalizeSessionProfiles(data?.sessionProfiles);
  if (!settings.sessionProfiles.some((profile) => profile.name === settings.defaultSessionType)) {
    settings.defaultSessionType = settings.sessionProfiles[0].name;
  }
  settings.promptProfiles = normalizePromptProfiles(settings.promptProfiles);
  if (!settings.promptProfiles.some((profile) => profile.id === settings.defaultPromptProfile)) {
    settings.defaultPromptProfile = settings.promptProfiles[0]?.id || "vorlesung";
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
  const target = match ? match[1].trim() : stripWrappedQuotes(value);
  return target.split("|")[0].split("#")[0].trim();
}

function getBackendListenOptions(backendUrl) {
  try {
    const parsed = new URL(backendUrl || DEFAULT_SETTINGS.backendUrl);
    const host = parsed.hostname === "localhost" ? "127.0.0.1" : parsed.hostname;
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    return { host: host || "127.0.0.1", port };
  } catch (_error) {
    return { host: "127.0.0.1", port: "8765" };
  }
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

function downloadFile(url, destPath, redirects = 0) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "User-Agent": "obsidian-transcript-gui" } }, (response) => {
      const statusCode = response.statusCode || 0;
      if ([301, 302, 303, 307, 308].includes(statusCode)) {
        response.resume();
        if (redirects >= 5) {
          reject(new Error("Download failed: too many redirects."));
          return;
        }
        const location = response.headers.location ? new URL(response.headers.location, url).toString() : "";
        if (!location) {
          reject(new Error("Download redirect without location."));
          return;
        }
        return downloadFile(location, destPath, redirects + 1).then(resolve).catch(reject);
      }
      if (statusCode !== 200) {
        response.resume();
        reject(new Error(`Download failed: ${statusCode}`));
        return;
      }

      const file = fs.createWriteStream(destPath);
      file.on("error", (error) => {
        response.destroy();
        fs.unlink(destPath, () => {});
        reject(error);
      });
      response.on("error", (error) => {
        file.close(() => fs.unlink(destPath, () => {}));
        reject(error);
      });
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

function readBackendEnv(app) {
  const installDir = getBackendInstallDir(app);
  const envPath = getEnvPath(installDir);
  const defaults = {
    LECTURE_PIPELINE_VAULT_ROOT: "",
    LECTURE_PIPELINE_SEMESTER_PATH: "1_Semester_Master_WiWi",
    LECTURE_PIPELINE_STUDY_ROOT: "10_Studium",
    LECTURE_PIPELINE_INBOX_DIR: "99_Inbox/Audio",
    LECTURE_PIPELINE_LM_STUDIO_BASE_URL: "http://127.0.0.1:1234/v1",
    LECTURE_PIPELINE_LM_STUDIO_MODEL: "qwen/qwen3.6-35b-a3b",
    LECTURE_PIPELINE_TRANSCRIPTION_MODEL: "mlx-community/whisper-large-v3-turbo",
    LECTURE_PIPELINE_CHUNK_TARGET_CHARS: "14000",
    LECTURE_PIPELINE_REQUEST_TIMEOUT_SECONDS: "1800",
    LECTURE_PIPELINE_IDLE_SHUTDOWN_SECONDS: "900",
    HF_TOKEN: "",
  };
  try {
    const content = fs.readFileSync(envPath, "utf8");
    const result = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIndex = trimmed.indexOf("=");
      if (eqIndex === -1) continue;
      const key = trimmed.slice(0, eqIndex).trim();
      const value = trimmed.slice(eqIndex + 1).trim();
      result[key] = value;
    }
    return { ...defaults, ...result };
  } catch (_error) {
    return { ...defaults };
  }
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
    `LECTURE_PIPELINE_REQUEST_TIMEOUT_SECONDS=${overrides.requestTimeoutSeconds || "1800"}`,
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
      promptProfile: plugin.settings.defaultPromptProfile || "vorlesung",
      speakerLabelMode: normalizeSpeakerLabelMode(plugin.settings.defaultSpeakerLabelMode),
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
    this.modalEl.style.width = "min(860px, calc(100vw - 2rem))";
    this.modalEl.style.maxWidth = "860px";
    this.modalEl.style.maxHeight = "calc(100vh - 2rem)";
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("transcript-gui-modal");
    this.actionButtons = [];

    const selectedProfile = this.plugin.getSessionProfile(this.state.sessionType);
    const lastRun = this.plugin.settings.lastRun;

    const shellEl = contentEl.createDiv({ cls: "transcript-gui-shell" });

    const headerEl = shellEl.createDiv({ cls: "transcript-gui-header" });
    headerEl.createEl("h2", { text: "Transkript importieren" });

    const formEl = shellEl.createDiv({ cls: "transcript-gui-form" });

    const sourceSectionEl = this.createSection(formEl, "Quelle");
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
      const audioFieldEl = this.createField(sourceSectionEl, "Datei");
      const audioInputEl = audioFieldEl.createEl("input", { cls: "transcript-gui-input" });
      audioInputEl.type = "text";
      audioInputEl.placeholder = "99_Inbox/Audio/datei.m4a";
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
      this.createActionButton(audioActionsEl, "Im Vault waehlen", () => this.chooseAudioFile());
    } else {
      const transcriptFieldEl = this.createField(sourceSectionEl, "Datei");
      const transcriptInputEl = transcriptFieldEl.createEl("input", { cls: "transcript-gui-input" });
      transcriptInputEl.type = "text";
      transcriptInputEl.placeholder = "datei.transcript.md";
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
    }

    const metaSectionEl = this.createSection(formEl, "Sitzung");
    const metaGridEl = metaSectionEl.createDiv({ cls: "transcript-gui-meta-grid" });

    const courseFieldEl = this.createField(metaGridEl, "Kontext");
    const courseInputEl = courseFieldEl.createEl("input", { cls: "transcript-gui-input" });
    courseInputEl.type = "text";
    courseInputEl.placeholder = "Oekonometrie";
    courseInputEl.value = this.state.course;
    courseInputEl.setAttribute("list", this.courseListId);
    courseInputEl.addEventListener("input", (event) => {
      this.state.course = event.target.value.trim();
    });
    courseInputEl.addEventListener("change", () => this.onOpen());
    const courseListEl = metaSectionEl.createEl("datalist", { attr: { id: this.courseListId } });
    for (const course of this.plugin.settings.courseOptions) {
      const optionEl = courseListEl.createEl("option");
      optionEl.value = course;
    }

    const dateFieldEl = this.createField(metaGridEl, "Datum");
    const dateInputEl = dateFieldEl.createEl("input", { cls: "transcript-gui-input" });
    dateInputEl.type = "date";
    dateInputEl.value = this.state.date;
    dateInputEl.addEventListener("input", (event) => {
      this.state.date = event.target.value.trim();
    });
    dateInputEl.addEventListener("change", () => this.onOpen());

    const typeFieldEl = this.createField(metaGridEl, "Typ");
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

    const themeFieldEl = this.createField(metaGridEl, "Thema");
    const themeInputEl = themeFieldEl.createEl("input", { cls: "transcript-gui-input" });
    themeInputEl.type = "text";
    themeInputEl.placeholder = "Paneldaten und Fixed Effects";
    themeInputEl.value = this.state.theme;
    themeInputEl.addEventListener("input", (event) => {
      this.state.theme = event.target.value.trim();
    });
    themeInputEl.addEventListener("change", () => this.onOpen());

    const profileFieldEl = this.createField(metaGridEl, "Stil-Profil");
    const profileSelectEl = profileFieldEl.createEl("select", { cls: "transcript-gui-select" });
    this.plugin.settings.promptProfiles.forEach((profile) => {
      const optionEl = profileSelectEl.createEl("option", { text: profile.name, value: profile.id });
      optionEl.value = profile.id;
    });
    profileSelectEl.value = this.state.promptProfile;
    profileSelectEl.addEventListener("change", (event) => {
      this.state.promptProfile = event.target.value;
    });

    const speakerModeFieldEl = this.createField(metaGridEl, "Sprecher-Modus");
    const speakerModeSelectEl = speakerModeFieldEl.createEl("select", { cls: "transcript-gui-select" });
    SPEAKER_LABEL_MODE_OPTIONS.forEach((option) => {
      const optionEl = speakerModeSelectEl.createEl("option", { text: option.label, value: option.value });
      optionEl.value = option.value;
    });
    speakerModeSelectEl.value = this.state.speakerLabelMode;
    speakerModeSelectEl.addEventListener("change", (event) => {
      this.state.speakerLabelMode = normalizeSpeakerLabelMode(event.target.value);
    });

    this.activeJobsSectionEl = this.createSection(formEl, "Aktive Jobs");
    this.activeJobsListEl = this.activeJobsSectionEl.createDiv({ cls: "transcript-gui-active-jobs-list" });
    this.renderActiveJobs();

    const history = this.plugin.settings.jobHistory || [];
    if (history.length > 0) {
      const historySectionEl = this.createSection(formEl, "Letzte Jobs");
      const historyGridEl = historySectionEl.createDiv({ cls: "transcript-gui-history-grid" });
      history.slice(0, 4).forEach((entry) => this.renderHistoryEntry(historyGridEl, entry));
    }

    const footerEl = shellEl.createDiv({ cls: "transcript-gui-footer" });

    if (this.getSelectedSourcePath()) {
      const previewEl = footerEl.createDiv({ cls: "transcript-gui-source-preview" });
      const sourceLabel = this.state.sourceMode === "audio" ? "Audio" : "Transkript";
      previewEl.createEl("span", { cls: "transcript-gui-source-label", text: sourceLabel });
      previewEl.createEl("span", { cls: "transcript-gui-source-path", text: this.getSelectedSourcePath() });
    }

    if (lastRun) {
      const lastRunEl = footerEl.createDiv({ cls: `transcript-gui-run-summary ${lastRun.status === "failed" ? "is-error" : "is-success"}` });
      const metaEl = lastRunEl.createDiv({ cls: "transcript-gui-run-meta" });
      metaEl.createSpan({ text: lastRun.sessionType || "" });
      if (lastRun.course) {
        metaEl.createSpan({ text: lastRun.course.replaceAll("_", " ") });
      }
      metaEl.createSpan({ text: lastRun.status === "failed" ? "Fehlgeschlagen" : "Erfolgreich" });
      if (lastRun.notePath) {
        lastRunEl.createDiv({ cls: "transcript-gui-run-path", text: lastRun.notePath });
      }
    }

    const progressEl = footerEl.createDiv({ cls: "transcript-gui-progress" });
    const progressHeadEl = progressEl.createDiv({ cls: "transcript-gui-progress-head" });
    this.progressStageEl = progressHeadEl.createEl("div", { cls: "transcript-gui-progress-stage", text: "Bereit" });
    this.progressPercentEl = progressHeadEl.createEl("div", { cls: "transcript-gui-progress-percent", text: "0%" });
    const progressTrackEl = progressEl.createDiv({ cls: "transcript-gui-progress-track" });
    this.progressBarEl = progressTrackEl.createDiv({ cls: "transcript-gui-progress-bar" });
    this.progressMessageEl = progressEl.createEl("div", { cls: "transcript-gui-progress-message", text: "Noch kein Job aktiv." });

    const actionsEl = footerEl.createDiv({ cls: "transcript-gui-actions" });
    this.submitButtonEl = actionsEl.createEl("button", { text: this.isSubmitting ? "Verarbeite..." : "Pipeline starten", cls: "mod-cta" });
    this.submitButtonEl.disabled = this.isSubmitting;
    this.submitButtonEl.addEventListener("click", () => this.submit());

    this.cancelButtonEl = actionsEl.createEl("button", { text: "Schliessen" });
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
      cancelling: "Abbruch laeuft",
      cancelled: "Abgebrochen",
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
      ...this.plugin.buildPromptPayload(this.state.promptProfile),
      course: this.state.course,
      date: this.state.date,
      session_type: this.state.sessionType,
      theme: this.state.theme,
      speaker_label_mode: normalizeSpeakerLabelMode(this.state.speakerLabelMode),
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

    // ── Backend-Konfiguration (.env) ──────────────────────────────────────
    if (installed || hasExecutable) {
      const env = readBackendEnv(this.plugin.app);
      const installDir = getBackendInstallDir(this.plugin.app);

      const saveEnv = () => {
        writeBackendEnv(installDir, env.LECTURE_PIPELINE_VAULT_ROOT, {
          semesterPath: env.LECTURE_PIPELINE_SEMESTER_PATH,
          studyRoot: env.LECTURE_PIPELINE_STUDY_ROOT,
          inboxDir: env.LECTURE_PIPELINE_INBOX_DIR,
          lmStudioUrl: env.LECTURE_PIPELINE_LM_STUDIO_BASE_URL,
          lmStudioModel: env.LECTURE_PIPELINE_LM_STUDIO_MODEL,
          transcriptionModel: env.LECTURE_PIPELINE_TRANSCRIPTION_MODEL,
          chunkTargetChars: env.LECTURE_PIPELINE_CHUNK_TARGET_CHARS,
          requestTimeoutSeconds: env.LECTURE_PIPELINE_REQUEST_TIMEOUT_SECONDS,
          idleShutdownSeconds: env.LECTURE_PIPELINE_IDLE_SHUTDOWN_SECONDS,
          hfToken: env.HF_TOKEN,
        });
      };

      containerEl.createEl("h3", { text: "Backend-Konfiguration" });
      containerEl.createEl("p", {
        cls: "setting-item-description",
        text: "Einstellungen in der Backend-.env. Nach Aenderungen das Backend neustarten.",
      });

      new Setting(containerEl)
        .setName("LM Studio URL")
        .setDesc("Adresse des LM Studio Servers.")
        .addText((text) => {
          text.setPlaceholder("http://127.0.0.1:1234/v1");
          text.setValue(env.LECTURE_PIPELINE_LM_STUDIO_BASE_URL || "");
          text.onChange((value) => {
            env.LECTURE_PIPELINE_LM_STUDIO_BASE_URL = value.trim();
            saveEnv();
          });
        });

      new Setting(containerEl)
        .setName("LM Studio Modell")
        .setDesc("Modellname fuer die Zusammenfassung.")
        .addText((text) => {
          text.setPlaceholder("qwen/qwen3.6-35b-a3b");
          text.setValue(env.LECTURE_PIPELINE_LM_STUDIO_MODEL || "");
          text.onChange((value) => {
            env.LECTURE_PIPELINE_LM_STUDIO_MODEL = value.trim();
            saveEnv();
          });
        });

      new Setting(containerEl)
        .setName("Transkriptionsmodell")
        .setDesc("Whisper-Modell fuer die lokale Transkription.")
        .addText((text) => {
          text.setPlaceholder("mlx-community/whisper-large-v3-turbo");
          text.setValue(env.LECTURE_PIPELINE_TRANSCRIPTION_MODEL || "");
          text.onChange((value) => {
            env.LECTURE_PIPELINE_TRANSCRIPTION_MODEL = value.trim();
            saveEnv();
          });
        });

      new Setting(containerEl)
        .setName("Chunk-Groesse (Zeichen)")
        .setDesc("Zielgroesse der Textbloecke fuer die Zusammenfassung.")
        .addText((text) => {
          text.setPlaceholder("14000");
          text.setValue(env.LECTURE_PIPELINE_CHUNK_TARGET_CHARS || "14000");
          text.onChange((value) => {
            env.LECTURE_PIPELINE_CHUNK_TARGET_CHARS = value.trim();
            saveEnv();
          });
        });

      new Setting(containerEl)
        .setName("LM Studio Antwort-Timeout (Sekunden)")
        .setDesc("Maximale Wartezeit fuer eine einzelne LLM-Antwort. Bei grossen lokalen Modellen hoeher setzen.")
        .addText((text) => {
          text.setPlaceholder("1800");
          text.setValue(env.LECTURE_PIPELINE_REQUEST_TIMEOUT_SECONDS || "1800");
          text.onChange((value) => {
            env.LECTURE_PIPELINE_REQUEST_TIMEOUT_SECONDS = value.trim();
            saveEnv();
          });
        });

      new Setting(containerEl)
        .setName("Idle-Timeout (Sekunden)")
        .setDesc("Backend wird nach dieser Zeit automatisch beendet (0 = nie).")
        .addText((text) => {
          text.setPlaceholder("900");
          text.setValue(env.LECTURE_PIPELINE_IDLE_SHUTDOWN_SECONDS || "900");
          text.onChange((value) => {
            env.LECTURE_PIPELINE_IDLE_SHUTDOWN_SECONDS = value.trim();
            saveEnv();
          });
        });

      new Setting(containerEl)
        .setName("Hugging Face Token")
        .setDesc("Optional. Wird fuer pyannote.audio (Speaker-Diarization) benoetigt.")
        .addText((text) => {
          text.setPlaceholder("hf_xxx...");
          text.setValue(env.HF_TOKEN || "");
          text.onChange((value) => {
            env.HF_TOKEN = value.trim();
            saveEnv();
          });
        });

      new Setting(containerEl)
        .setName("Backend neustarten")
        .setDesc("Aenderungen an der Konfiguration erfordern einen Neustart des Backends.")
        .addButton((button) => {
          button.setButtonText("Backend neustarten");
          button.onClick(async () => {
            try {
              await this.plugin.restartBackendProcess();
              new Notice("Backend erfolgreich neu gestartet.", 4000);
            } catch (error) {
              new Notice(`Backend konnte nicht neu gestartet werden: ${error instanceof Error ? error.message : String(error)}`, 8000);
            }
          });
        });
    }

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
      .setName("Standard-Sprecher-Modus")
      .setDesc("Waehlt zwischen Prof-Markierung fuer Speaker 1 und neutralen Speaker-Nummern.")
      .addDropdown((dropdown) => {
        SPEAKER_LABEL_MODE_OPTIONS.forEach((option) => dropdown.addOption(option.value, option.label));
        dropdown.setValue(normalizeSpeakerLabelMode(this.plugin.settings.defaultSpeakerLabelMode));
        dropdown.onChange(async (value) => {
          this.plugin.settings.defaultSpeakerLabelMode = normalizeSpeakerLabelMode(value);
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

    containerEl.createEl("h3", { text: "Stil-Profile" });
    containerEl.createEl("p", {
      text: "Stil-Profile steuern die Anweisungen an das LLM. Jedes Profil definiert den Zusammenfassungs-Stil, den Notiz-Stil und optionale LLM-Parameter.",
    });

    const promptProfiles = this.plugin.settings.promptProfiles;
    promptProfiles.forEach((profile, index) => {
      containerEl.createEl("h4", { text: profile.name || `Profil ${index + 1}` });

      new Setting(containerEl)
        .setName("Name")
        .addText((text) => {
          text.setValue(profile.name);
          text.onChange(async (value) => {
            this.plugin.settings.promptProfiles[index].name = value.trim() || `Profil ${index + 1}`;
            await this.plugin.saveSettings();
          });
        });

      new Setting(containerEl)
        .setName("Zusammenfassungs-Stil")
        .setDesc("Anweisung fuer die Block-Zusammenfassung. Wird dem LLM als System-Prompt uebergeben.")
        .addTextArea((text) => {
          text.setValue(profile.zusammenfassungs_stil);
          text.inputEl.rows = 3;
          text.inputEl.cols = 50;
          text.onChange(async (value) => {
            this.plugin.settings.promptProfiles[index].zusammenfassungs_stil = value;
            await this.plugin.saveSettings();
          });
        });

      new Setting(containerEl)
        .setName("Notiz-Stil")
        .setDesc("Anweisung fuer die finale Synthese. Wird dem LLM als System-Prompt uebergeben.")
        .addTextArea((text) => {
          text.setValue(profile.notiz_stil);
          text.inputEl.rows = 3;
          text.inputEl.cols = 50;
          text.onChange(async (value) => {
            this.plugin.settings.promptProfiles[index].notiz_stil = value;
            await this.plugin.saveSettings();
          });
        });

      new Setting(containerEl)
        .setName("LM Studio Modell")
        .setDesc("Leer = Standard aus Backend-Konfiguration. Ueberschreibt das Modell fuer dieses Profil.")
        .addText((text) => {
          text.setPlaceholder("qwen/qwen3.6-35b-a3b");
          text.setValue(profile.lmStudioModel || "");
          text.onChange(async (value) => {
            this.plugin.settings.promptProfiles[index].lmStudioModel = value.trim();
            await this.plugin.saveSettings();
          });
        });

      new Setting(containerEl)
        .setName("Temperatur")
        .setDesc("Kreativitaet des LLM (0.0 = deterministisch, 1.0 = kreativ).")
        .addText((text) => {
          text.setPlaceholder("0.1");
          text.setValue(String(profile.temperature ?? 0.1));
          text.onChange(async (value) => {
            const num = parseFloat(value);
            if (!isNaN(num)) {
              this.plugin.settings.promptProfiles[index].temperature = num;
              await this.plugin.saveSettings();
            }
          });
        });

      new Setting(containerEl)
        .setName("Top-P")
        .setDesc("Nucleus-Sampling (0.0-1.0). Hoeher = mehr Vielfalt.")
        .addText((text) => {
          text.setPlaceholder("0.8");
          text.setValue(String(profile.topP ?? 0.8));
          text.onChange(async (value) => {
            const num = parseFloat(value);
            if (!isNaN(num)) {
              this.plugin.settings.promptProfiles[index].topP = num;
              await this.plugin.saveSettings();
            }
          });
        })
        .addExtraButton((button) => {
          button.setIcon("trash");
          button.setTooltip("Profil loeschen");
          button.setDisabled(promptProfiles.length <= 1);
          button.onClick(async () => {
            if (this.plugin.settings.promptProfiles.length <= 1) {
              return;
            }
            const removed = this.plugin.settings.promptProfiles[index];
            this.plugin.settings.promptProfiles.splice(index, 1);
            if (this.plugin.settings.defaultPromptProfile === removed?.id) {
              this.plugin.settings.defaultPromptProfile = this.plugin.settings.promptProfiles[0]?.id || "vorlesung";
            }
            await this.plugin.saveSettings();
            this.display();
          });
        });
    });

    new Setting(containerEl)
      .setName("Neues Stil-Profil")
      .addButton((button) => {
        button.setButtonText("Profil hinzufuegen");
        button.onClick(async () => {
          this.plugin.settings.promptProfiles = [
            ...this.plugin.settings.promptProfiles,
            {
              id: `custom_${Date.now()}`,
              name: `Profil ${this.plugin.settings.promptProfiles.length + 1}`,
              zusammenfassungs_stil: "",
              notiz_stil: "",
              lmStudioModel: "",
              temperature: 0.1,
              topP: 0.8,
            },
          ];
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
          ...this.buildPromptPayload(this.settings.defaultPromptProfile),
          audio_path: latest.path,
          course,
          date: window.moment ? window.moment().format("YYYY-MM-DD") : new Date().toISOString().slice(0, 10),
          session_type: this.settings.defaultSessionType,
          theme: this.suggestThemeFromAudio(latest),
          speaker_label_mode: normalizeSpeakerLabelMode(this.settings.defaultSpeakerLabelMode),
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

  getPromptProfile(id) {
    const profiles = this.settings.promptProfiles || [];
    return profiles.find((profile) => profile.id === id) || profiles[0] || DEFAULT_PROMPT_PROFILES[0];
  }

  buildPromptPayload(id) {
    const profile = this.getPromptProfile(id);
    const payload = {
      prompt_profile: profile?.id || id || "vorlesung",
    };
    if (!profile) {
      return payload;
    }
    if (typeof profile.zusammenfassungs_stil === "string" && profile.zusammenfassungs_stil.trim()) {
      payload.zusammenfassungs_stil = profile.zusammenfassungs_stil.trim();
    }
    if (typeof profile.notiz_stil === "string" && profile.notiz_stil.trim()) {
      payload.notiz_stil = profile.notiz_stil.trim();
    }
    if (profile.lmStudioModel) {
      payload.lm_studio_model = profile.lmStudioModel;
    }
    if (profile.temperature != null) {
      payload.temperature = profile.temperature;
    }
    if (profile.topP != null) {
      payload.top_p = profile.topP;
    }
    return payload;
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
    const frontmatterMatch = String(text || "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
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
      if (snapshot.status === "cancelled") {
        throw new Error(snapshot.message || "Job wurde abgebrochen.");
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

    const basePath = path.resolve(adapter.getBasePath());
    const resolvedPath = path.resolve(String(absolutePath || ""));
    const relativePath = path.relative(basePath, resolvedPath).replace(/\\/g, "/");
    if (!relativePath || relativePath.startsWith("../") || relativePath === ".." || path.isAbsolute(relativePath)) {
      return;
    }

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
      // Note: we intentionally do NOT use -e (editable) because we delete sourceDir afterwards.
      // A normal install copies the package into the venv so it survives sourceDir cleanup.
      await execPromise(`"${pip}" install "${sourceDir}"`, { cwd: installDir });

      // Optional audio dependencies
      try {
        await execPromise(`"${pip}" install "${sourceDir}[audio]"`, { cwd: installDir });
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

      this.settings.backendVersion = BACKEND_VERSION;
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
      await this.stopManagedBackendProcess();
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
    const remoteVersion = BACKEND_VERSION;
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

  async stopManagedBackendProcess() {
    if (!this.lastBackendPid) {
      return;
    }
    const pid = this.lastBackendPid;
    this.lastBackendPid = null;
    try {
      process.kill(pid, 0);
      process.kill(pid, "SIGTERM");
      await new Promise((resolve) => window.setTimeout(resolve, 600));
    } catch (_error) {
      // Process already gone or not owned by this Obsidian session.
    }
  }

  async restartBackendProcess() {
    await this.stopManagedBackendProcess();
    await this.startBackendProcess();
    return this.fetchBackendHealth();
  }

  // ── Backend Communication ────────────────────────────────────────────────

  async ensureBackendAvailable(options = {}) {
    const { forceStart = true } = options;
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

    const logPath = path.join(installDir, "backend.log");

    // Ensure log file exists before spawning
    fs.writeFileSync(logPath, `\n--- Backend started at ${new Date().toISOString()} ---\n`, { flag: "a" });

    const listenOptions = getBackendListenOptions(this.settings.backendUrl);
    const args = ["serve", "--host", listenOptions.host, "--port", listenOptions.port];
    const child = spawn(executable, args, {
      cwd: installDir,
      env: { ...process.env, PATH: patchedPath },
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.lastBackendPid = child.pid;

    // Collect stdout/stderr into log file and memory buffer
    const logStream = fs.createWriteStream(logPath, { flags: "a" });
    const logBuffer = [];
    const appendLog = (data) => {
      const text = data.toString();
      logBuffer.push(text);
      if (logBuffer.length > 100) logBuffer.shift();
      logStream.write(text);
    };

    child.stdout?.on("data", appendLog);
    child.stderr?.on("data", appendLog);

    let exitError = null;
    child.on("error", (err) => {
      exitError = err;
      logStream.write(`[spawn error] ${err.message}\n`);
    });
    child.on("exit", (code) => {
      logStream.write(`[exit] code=${code}\n`);
      logStream.end();
      if (this.lastBackendPid === child.pid) {
        this.lastBackendPid = null;
      }
      if (code !== 0 && code !== null) {
        exitError = new Error(`Backend-Prozess beendet mit Code ${code}`);
      }
    });

    const timeoutMs = 30000;
    const startedAt = Date.now();

    // Check immediately, then every 750ms
    do {
      if (exitError) {
        const recentLog = logBuffer.slice(-20).join("");
        throw new Error(`Backend konnte nicht gestartet werden: ${exitError.message}\n\nLetzte Log-Einträge:\n${recentLog}\n\nVollständiges Log: ${logPath}`);
      }

      try {
        await this.fetchBackendHealth();
        return;
      } catch (_error) {
        // wait until backend responds or timeout expires
      }

      if (Date.now() - startedAt < timeoutMs) {
        await new Promise((resolve) => window.setTimeout(resolve, 750));
      }
    } while (Date.now() - startedAt < timeoutMs);

    try {
      process.kill(child.pid, "SIGTERM");
    } catch (_error) {
      // ignore
    }
    const recentLog = logBuffer.slice(-20).join("");
    throw new Error(`Backend konnte nicht rechtzeitig gestartet werden.\n\nLetzte Log-Einträge:\n${recentLog}\n\nVollständiges Log: ${logPath}`);
  }
};

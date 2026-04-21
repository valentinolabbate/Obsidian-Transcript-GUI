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
const { spawn } = require("child_process");
const path = require("path");

const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "wav", "mp4", "webm", "ogg", "flac", "aac", "aiff"]);

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
  autoStartBackend: true,
  backendProjectDir: "40_Projekte/obsidian-lecture-pipeline",
  backendStartCommand: ".venv/bin/lecture-pipeline serve --host 127.0.0.1 --port 8765",
  backendHealthTimeoutMs: 30000,
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

class AudioFileSuggestModal extends FuzzySuggestModal {
  constructor(app, files, onChoose) {
    super(app);
    this.files = files;
    this.onChoose = onChoose;
    this.setPlaceholder("Audio-Datei waehlen...");
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
    this.pollToken = 0;
    this.lastTranscriptAutofillPath = "";
    this.isAutofillingTranscript = false;
    this.progressSnapshot = { progress: 0, stage: "idle", message: "Noch kein Job aktiv.", status: "idle" };
  }

  onOpen() {
    this.modalEl.addClass("transcript-gui-modal-host");
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
      text: "Audio uebernehmen, Sitzungsmetadaten setzen und die lokale Pipeline direkt aus Obsidian starten.",
    });

    const badgeRowEl = heroEl.createDiv({ cls: "transcript-gui-badges" });
    this.createBadge(badgeRowEl, this.state.course ? this.state.course.replaceAll("_", " ") : "Kein Kontext", "Kontext");
    this.createBadge(badgeRowEl, this.state.sessionType, "Typ");
    this.createBadge(badgeRowEl, this.state.sourceMode === "audio" ? "Audio" : "Transkript", "Quelle");
    this.createBadge(badgeRowEl, this.plugin.settings.inboxFolder, "Inbox");

    const lastRun = this.plugin.settings.lastRun;
    if (lastRun) {
      const lastRunClass = lastRun.status === "failed" ? "transcript-gui-status is-error" : "transcript-gui-status is-success";
      const lastRunEl = shellEl.createDiv({ cls: `transcript-gui-run-summary ${lastRunClass}` });
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
    }

    const formEl = shellEl.createDiv({ cls: "transcript-gui-form" });

    const sourceSectionEl = this.createSection(
      formEl,
      "Quelle",
      "Waehle eine Audio-Datei oder ein vorhandenes Rohtranskript aus dem Vault."
    );
    const sourceModeFieldEl = this.createField(sourceSectionEl, "Quelltyp");
    const sourceModeSelectEl = sourceModeFieldEl.createEl("select", { cls: "transcript-gui-select" });
    [
      { value: "audio", label: "Audio-Datei" },
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
      const audioFieldEl = this.createField(sourceSectionEl, "Audio-Datei", "Pfad relativ zum Vault");
      const audioInputEl = audioFieldEl.createEl("input", { cls: "transcript-gui-input" });
      audioInputEl.type = "text";
      audioInputEl.placeholder = "99_Inbox/Audio/datei.m4a";
      audioInputEl.value = this.state.audioPath;
      audioInputEl.addEventListener("input", (event) => {
        this.state.audioPath = event.target.value.trim();
      });

      const audioActionsEl = sourceSectionEl.createDiv({ cls: "transcript-gui-inline-actions" });
      this.createActionButton(audioActionsEl, "Neueste Inbox-Datei", async () => {
        const latest = this.plugin.getLatestInboxAudio();
        if (!latest) {
          new Notice("Keine Audio-Datei in der Inbox gefunden.");
          return;
        }
        this.state.audioPath = latest.path;
        this.onOpen();
      });
      this.createActionButton(audioActionsEl, "Neueste direkt starten", async () => {
        const latest = this.plugin.getLatestInboxAudio();
        if (!latest) {
          new Notice("Keine Audio-Datei in der Inbox gefunden.");
          return;
        }
        this.state.audioPath = latest.path;
        await this.submit();
      });
      this.createActionButton(audioActionsEl, "Im Vault waehlen", () => this.chooseAudioFile());
    } else {
      const transcriptFieldEl = this.createField(sourceSectionEl, "Transkript-Datei", "Pfad zu .transcript.md oder .segments.json");
      const transcriptInputEl = transcriptFieldEl.createEl("input", { cls: "transcript-gui-input" });
      transcriptInputEl.type = "text";
      transcriptInputEl.placeholder = "10_Studium/.../Rohdaten/Transkripte/datei.transcript.md";
      transcriptInputEl.value = this.state.transcriptPath;
      transcriptInputEl.addEventListener("input", (event) => {
        this.state.transcriptPath = event.target.value.trim();
      });

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

    const detailsGridEl = formEl.createDiv({ cls: "transcript-gui-grid" });
    const detailsSectionEl = this.createSection(
      detailsGridEl,
      "Sitzungsdaten",
      "Die Metadaten steuern Dateiname, Kontext und Note."
    );
    const contextSectionEl = this.createSection(
      detailsGridEl,
      "Kontext",
      "Kontext wird nach Moeglichkeit aus der aktuellen Note erkannt und kann ueberschrieben werden."
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

    const metaGridEl = detailsSectionEl.createDiv({ cls: "transcript-gui-meta-grid" });
    const dateFieldEl = this.createField(metaGridEl, "Datum");
    const dateInputEl = dateFieldEl.createEl("input", { cls: "transcript-gui-input" });
    dateInputEl.type = "date";
    dateInputEl.value = this.state.date;
    dateInputEl.addEventListener("input", (event) => {
      this.state.date = event.target.value.trim();
    });

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
    contextInfoEl.createEl("div", { cls: "transcript-gui-info-title", text: "Erkannter Kontext" });
    contextInfoEl.createEl("div", {
      cls: "transcript-gui-info-line",
      text: this.state.course ? `Vorausgewaehlter Kontext: ${this.state.course.replaceAll("_", " ")}` : "Kein Kontext aus der aktuellen Note erkannt",
    });
    contextInfoEl.createEl("div", {
      cls: "transcript-gui-info-line",
      text: `Backend: ${this.plugin.settings.backendUrl}`,
    });
    contextInfoEl.createEl("div", {
      cls: "transcript-gui-info-line",
      text: `Template: ${selectedProfile?.templatePath || "Standard-Template"}`,
    });
    contextInfoEl.createEl("div", {
      cls: "transcript-gui-info-line",
      text: `Zwischenspeicher: ${selectedProfile?.storageDir || "Standardpfad"}`,
    });
    contextInfoEl.createEl("div", {
      cls: "transcript-gui-info-line",
      text: `Zielordner: ${selectedProfile?.outputDir || "Standardpfad"}`,
    });

    const history = this.plugin.settings.jobHistory || [];
    if (history.length > 0) {
      const historySectionEl = this.createSection(
        shellEl,
        "Letzte Jobs",
        "Direkte Spruenge zu erzeugten Notizen, Rohtranskripten und Eingabedateien."
      );
      const historyGridEl = historySectionEl.createDiv({ cls: "transcript-gui-history-grid" });
      history.slice(0, 6).forEach((entry) => this.renderHistoryEntry(historyGridEl, entry));
    }

    const footerEl = shellEl.createDiv({ cls: "transcript-gui-footer" });
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

    if (this.state.sourceMode === "transcript" && this.state.transcriptPath && !this.isAutofillingTranscript && this.state.transcriptPath !== this.lastTranscriptAutofillPath) {
      void this.autofillFromTranscriptPath(this.state.transcriptPath);
    }
  }

  onClose() {
    this.pollToken += 1;
    this.modalEl.removeClass("transcript-gui-modal-host");
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
    badgeEl.createSpan({ cls: "transcript-gui-badge-label", text: label });
    badgeEl.createSpan({ cls: "transcript-gui-badge-value", text: value });
    return badgeEl;
  }

  createActionButton(parentEl, text, onClick) {
    const buttonEl = parentEl.createEl("button", { text, cls: "transcript-gui-secondary-button" });
    buttonEl.addEventListener("click", onClick);
    this.actionButtons.push(buttonEl);
    return buttonEl;
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
      this.createHistoryLink(actionsEl, "Audio", () => this.plugin.openVaultPathFromRelativeOrAbsolute(entry.audioPath));
    }
  }

  createHistoryLink(parentEl, text, onClick) {
    const buttonEl = parentEl.createEl("button", { text, cls: "transcript-gui-history-link" });
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
      new Notice("Keine Audio-Dateien im Vault gefunden.");
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
      throw new Error("Bitte eine Audio-Datei angeben.");
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

    new Setting(containerEl)
      .setName("Backend automatisch starten")
      .setDesc("Startet den lokalen Server automatisch, wenn er nicht erreichbar ist.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.autoStartBackend);
        toggle.onChange(async (value) => {
          this.plugin.settings.autoStartBackend = value;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Backend-Projektordner")
      .setDesc("Relativ zum Vault oder absolut. Von hier wird der Server automatisch gestartet.")
      .addText((text) => {
        text.setPlaceholder("40_Projekte/obsidian-lecture-pipeline");
        text.setValue(this.plugin.settings.backendProjectDir);
        text.onChange(async (value) => {
          this.plugin.settings.backendProjectDir = value.trim() || DEFAULT_SETTINGS.backendProjectDir;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Backend-Startkommando")
      .setDesc("Wird lokal im Projektordner ausgefuehrt, falls das Backend nicht laeuft.")
      .addText((text) => {
        text.setPlaceholder(DEFAULT_SETTINGS.backendStartCommand);
        text.setValue(this.plugin.settings.backendStartCommand);
        text.onChange(async (value) => {
          this.plugin.settings.backendStartCommand = value.trim() || DEFAULT_SETTINGS.backendStartCommand;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Backend-Start-Timeout")
      .setDesc("Wie lange die GUI auf den automatischen Start warten soll.")
      .addText((text) => {
        text.setPlaceholder("30000");
        text.setValue(String(this.plugin.settings.backendHealthTimeoutMs));
        text.onChange(async (value) => {
          const parsed = Number(value.trim());
          this.plugin.settings.backendHealthTimeoutMs = Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_SETTINGS.backendHealthTimeoutMs;
          await this.plugin.saveSettings();
        });
      });

    new Setting(containerEl)
      .setName("Inbox-Ordner")
      .setDesc("Hier sucht die GUI nach der neuesten Audio-Datei.")
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

    this.addRibbonIcon("audio-file", "Transcript GUI", () => this.openProcessModal());

    this.addCommand({
      id: "open-transcript-gui",
      name: "Open transcript GUI",
      callback: () => this.openProcessModal(),
    });

    this.addCommand({
      id: "open-transcript-gui-with-latest-inbox-audio",
      name: "Open transcript GUI with latest inbox audio",
      callback: () => {
        const latest = this.getLatestInboxAudio();
        this.openProcessModal(latest ? latest.path : "");
      },
    });

    this.addCommand({
      id: "process-latest-inbox-audio",
      name: "Process latest inbox audio",
      callback: async () => {
        const latest = this.getLatestInboxAudio();
        if (!latest) {
          new Notice("Keine Audio-Datei in der Inbox gefunden.");
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

  getAllAudioFiles() {
    return this.app.vault.getFiles().filter((file) => {
      const extension = file.extension?.toLowerCase();
      return AUDIO_EXTENSIONS.has(extension);
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

  async ensureBackendAvailable(options = {}) {
    const { forceStart = false } = options;
    try {
      return await this.fetchBackendHealth();
    } catch (error) {
      if (!this.settings.autoStartBackend && !forceStart) {
        throw error;
      }
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

  resolveBackendProjectDir() {
    const configured = this.settings.backendProjectDir?.trim() || DEFAULT_SETTINGS.backendProjectDir;
    if (configured.startsWith("/") || /^[A-Za-z]:[\\/]/.test(configured)) {
      return configured;
    }
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) {
      throw new Error("Dateisystem-Adapter fuer Backend-Autostart nicht verfuegbar.");
    }
    return path.join(adapter.getBasePath(), configured);
  }

  async startBackendProcess() {
    const projectDir = this.resolveBackendProjectDir();
    const command = this.settings.backendStartCommand?.trim() || DEFAULT_SETTINGS.backendStartCommand;

    // macOS GUI apps inherit a minimal PATH that omits Homebrew (/opt/homebrew/bin).
    // We inject the most common install locations so ffmpeg, python, etc. are found.
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

    const child = spawn(command, {
      cwd: projectDir,
      shell: true,
      detached: true,
      stdio: "ignore",
      env: { ...process.env, PATH: patchedPath },
    });
    child.unref();
    this.lastBackendPid = child.pid;

    const timeoutMs = Number(this.settings.backendHealthTimeoutMs || DEFAULT_SETTINGS.backendHealthTimeoutMs);
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

    throw new Error("Backend konnte nicht rechtzeitig gestartet werden.");
  }
};

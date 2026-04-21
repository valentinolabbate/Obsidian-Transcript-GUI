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

const AUDIO_EXTENSIONS = new Set(["mp3", "m4a", "wav", "mp4", "webm", "ogg", "flac", "aac", "aiff"]);

const DEFAULT_SETTINGS = {
  backendUrl: "http://127.0.0.1:8765",
  inboxFolder: "99_Inbox/Audio",
  defaultSessionType: "Vorlesung",
  openNoteAfterProcessing: true,
  lastRun: null,
  jobHistory: [],
  courseOptions: [
    "Oekonometrie",
    "Quantitative_Projekte_und_Reihenfolgenplanung",
    "Humanisierung_der_Arbeitswelt",
    "Dienstleistungsproduktion",
  ],
};

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

class TranscriptProcessModal extends Modal {
  constructor(app, plugin, initialAudioPath = "") {
    super(app);
    const inferredCourse = plugin.guessCourseFromContext();
    const latestInboxAudio = plugin.getLatestInboxAudio();
    this.plugin = plugin;
    this.state = {
      audioPath: initialAudioPath || (latestInboxAudio ? latestInboxAudio.path : ""),
      course: inferredCourse || plugin.settings.courseOptions[0] || "",
      date: window.moment ? window.moment().format("YYYY-MM-DD") : new Date().toISOString().slice(0, 10),
      sessionType: plugin.settings.defaultSessionType,
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
    heroTextEl.createEl("h2", { text: "Vorlesungstranskript importieren" });
    heroTextEl.createEl("p", {
      text: "Audio uebernehmen, Vorlesungsmetadaten setzen und die lokale Pipeline direkt aus Obsidian starten.",
    });

    const badgeRowEl = heroEl.createDiv({ cls: "transcript-gui-badges" });
    this.createBadge(badgeRowEl, this.state.course ? this.state.course.replaceAll("_", " ") : "Kein Kurs", "Kurs");
    this.createBadge(badgeRowEl, this.state.sessionType, "Typ");
    this.createBadge(badgeRowEl, this.plugin.settings.inboxFolder, "Inbox");

    const lastRun = this.plugin.settings.lastRun;
    if (lastRun) {
      const lastRunClass = lastRun.status === "failed" ? "transcript-gui-status is-error" : "transcript-gui-status is-success";
      const lastRunEl = shellEl.createDiv({ cls: `transcript-gui-run-summary ${lastRunClass}` });
      lastRunEl.createEl("div", { cls: "transcript-gui-run-title", text: "Letzter Lauf" });
      const metaEl = lastRunEl.createDiv({ cls: "transcript-gui-run-meta" });
      metaEl.createSpan({ text: lastRun.timestamp || "unbekannt" });
      metaEl.createSpan({ text: lastRun.status || "unbekannt" });
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

    const audioSectionEl = this.createSection(
      formEl,
      "Audioquelle",
      "Waehle eine Aufnahme aus der Inbox oder einem anderen Pfad im Vault."
    );
    const audioFieldEl = this.createField(audioSectionEl, "Audio-Datei", "Pfad relativ zum Vault");
    const audioInputEl = audioFieldEl.createEl("input", { cls: "transcript-gui-input" });
    audioInputEl.type = "text";
    audioInputEl.placeholder = "99_Inbox/Audio/datei.m4a";
    audioInputEl.value = this.state.audioPath;
    audioInputEl.addEventListener("input", (event) => {
      this.state.audioPath = event.target.value.trim();
    });

    const audioActionsEl = audioSectionEl.createDiv({ cls: "transcript-gui-inline-actions" });
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

    const detailsGridEl = formEl.createDiv({ cls: "transcript-gui-grid" });
    const detailsSectionEl = this.createSection(
      detailsGridEl,
      "Sitzungsdaten",
      "Die Metadaten steuern Dateiname, Kurszuordnung und Note."
    );
    const contextSectionEl = this.createSection(
      detailsGridEl,
      "Kontext",
      "Kurs wird nach Moeglichkeit aus der aktuellen Note erkannt und kann ueberschrieben werden."
    );

    const courseFieldEl = this.createField(contextSectionEl, "Kurs", "Ordnername im Vault");
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
    ["Vorlesung", "Uebung", "Tutorium"].forEach((type) => {
      const optionEl = typeSelectEl.createEl("option", { text: type, value: type });
      optionEl.value = type;
    });
    typeSelectEl.value = this.state.sessionType;
    typeSelectEl.addEventListener("change", (event) => {
      this.state.sessionType = event.target.value;
      this.onOpen();
    });

    const contextInfoEl = contextSectionEl.createDiv({ cls: "transcript-gui-info-card" });
    contextInfoEl.createEl("div", { cls: "transcript-gui-info-title", text: "Erkannter Kontext" });
    contextInfoEl.createEl("div", {
      cls: "transcript-gui-info-line",
      text: this.state.course ? `Vorausgewaehlter Kurs: ${this.state.course.replaceAll("_", " ")}` : "Kein Kurs aus dem Kontext erkannt",
    });
    contextInfoEl.createEl("div", {
      cls: "transcript-gui-info-line",
      text: `Backend: ${this.plugin.settings.backendUrl}`,
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
    const cardEl = parentEl.createDiv({ cls: `transcript-gui-history-card ${entry.status === "failed" ? "is-error" : "is-success"}` });
    cardEl.createEl("div", { cls: "transcript-gui-history-title", text: entry.theme || "Unbenannter Lauf" });
    const metaEl = cardEl.createDiv({ cls: "transcript-gui-history-meta" });
    metaEl.createSpan({ text: entry.status || "unbekannt" });
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
    this.progressMessageEl.setText(message);
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
    if (!this.state.audioPath) {
      throw new Error("Bitte eine Audio-Datei angeben.");
    }
    if (!this.state.course) {
      throw new Error("Bitte einen Kurs angeben.");
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
      audio_path: this.state.audioPath,
      course: this.state.course,
      date: this.state.date,
      session_type: this.state.sessionType,
      theme: this.state.theme,
    };

    try {
      const result = await this.plugin.runLectureJob(payload, (snapshot) => {
        if (currentPollToken !== this.pollToken) {
          return;
        }
        this.setProgress(snapshot);
        if (snapshot.status === "running") {
          this.setStatus(`${this.formatStage(snapshot.stage, snapshot.status)}\n${snapshot.message || ""}`.trim(), "neutral");
        }
      });

      const entry = {
        timestamp: new Date().toISOString(),
        jobId: result.job_id,
        status: "completed",
        notePath: result.note_path,
        transcriptPath: result.transcript_path,
        audioPath: this.state.audioPath,
        course: this.state.course,
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
        audioPath: this.state.audioPath,
        course: this.state.course,
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
        ["Vorlesung", "Uebung", "Tutorium"].forEach((type) => dropdown.addOption(type, type));
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
      .setName("Kursoptionen")
      .setDesc("Ein Kurs pro Zeile. Wird im Modal als Schnellwahl angeboten.")
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
  }
}

module.exports = class TranscriptGuiPlugin extends Plugin {
  async onload() {
    await this.loadSettings();

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
          new Notice("Kein Kurskontext erkannt. Modal wurde zum Pruefen geoeffnet.");
          return;
        }

        const payload = {
          audio_path: latest.path,
          course,
          date: window.moment ? window.moment().format("YYYY-MM-DD") : new Date().toISOString().slice(0, 10),
          session_type: this.settings.defaultSessionType,
          theme: this.suggestThemeFromAudio(latest),
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
          const response = await requestUrl({ url: `${this.settings.backendUrl}/health`, method: "GET" });
          const payload = response.json;
          new Notice(`Backend ok: ${payload.lm_studio_model}`);
        } catch (error) {
          new Notice(`Backend nicht erreichbar: ${error instanceof Error ? error.message : String(error)}`);
        }
      },
    });

    this.addSettingTab(new TranscriptGuiSettingTab(this.app, this));
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async recordLastRun(payload) {
    this.settings.lastRun = payload;
    const history = Array.isArray(this.settings.jobHistory) ? this.settings.jobHistory : [];
    this.settings.jobHistory = [payload, ...history.filter((entry) => entry.timestamp !== payload.timestamp)].slice(0, 12);
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
};

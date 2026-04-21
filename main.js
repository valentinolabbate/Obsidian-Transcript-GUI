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
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("transcript-gui-modal");
    contentEl.createEl("h2", { text: "Vorlesungstranskript importieren" });

    const lastRun = this.plugin.settings.lastRun;
    if (lastRun) {
      const lastRunClass = lastRun.status === "failed" ? "transcript-gui-status is-error" : "transcript-gui-status is-success";
      const lastRunEl = contentEl.createDiv({ cls: lastRunClass });
      lastRunEl.setText(
        `Letzter Lauf: ${lastRun.timestamp || "unbekannt"}\nStatus: ${lastRun.status || "unbekannt"}\nNote: ${lastRun.notePath || "-"}`
      );
    }

    new Setting(contentEl)
      .setName("Audio-Datei")
      .setDesc("Pfad relativ zum Vault. Die Pipeline kopiert die Datei spaeter in den Kursordner.")
      .addText((text) => {
        text.setPlaceholder("99_Inbox/Audio/datei.m4a");
        text.setValue(this.state.audioPath);
        text.onChange((value) => {
          this.state.audioPath = value.trim();
        });
      })
      .addButton((button) => {
        button.setButtonText("Neueste Inbox-Datei");
        button.onClick(async () => {
          const latest = this.plugin.getLatestInboxAudio();
          if (!latest) {
            new Notice("Keine Audio-Datei in der Inbox gefunden.");
            return;
          }
          this.state.audioPath = latest.path;
          this.onOpen();
        });
      })
      .addButton((button) => {
        button.setButtonText("Neueste direkt starten");
        button.onClick(async () => {
          const latest = this.plugin.getLatestInboxAudio();
          if (!latest) {
            new Notice("Keine Audio-Datei in der Inbox gefunden.");
            return;
          }
          this.state.audioPath = latest.path;
          await this.submit();
        });
      })
      .addButton((button) => {
        button.setButtonText("Im Vault waehlen");
        button.onClick(() => this.chooseAudioFile());
      });

    const courseSetting = new Setting(contentEl)
      .setName("Kurs")
      .setDesc("Ordnername des Kurses im Vault.");

    courseSetting.addText((text) => {
      text.setPlaceholder("Oekonometrie");
      text.setValue(this.state.course);
      text.onChange((value) => {
        this.state.course = value.trim();
      });
    });

    if (this.plugin.settings.courseOptions.length > 0) {
      courseSetting.addDropdown((dropdown) => {
        for (const course of this.plugin.settings.courseOptions) {
          dropdown.addOption(course, course.replaceAll("_", " "));
        }
        dropdown.setValue(this.state.course || this.plugin.settings.courseOptions[0]);
        dropdown.onChange((value) => {
          this.state.course = value;
          this.onOpen();
        });
      });
    }

    new Setting(contentEl)
      .setName("Datum")
      .addText((text) => {
        text.inputEl.type = "date";
        text.setValue(this.state.date);
        text.onChange((value) => {
          this.state.date = value.trim();
        });
      });

    new Setting(contentEl)
      .setName("Sitzungstyp")
      .addDropdown((dropdown) => {
        ["Vorlesung", "Uebung", "Tutorium"].forEach((type) => dropdown.addOption(type, type));
        dropdown.setValue(this.state.sessionType);
        dropdown.onChange((value) => {
          this.state.sessionType = value;
        });
      });

    new Setting(contentEl)
      .setName("Thema")
      .setDesc("Wird fuer Dateiname und Notiz verwendet.")
      .addText((text) => {
        text.setPlaceholder("Paneldaten und Fixed Effects");
        text.setValue(this.state.theme);
        text.onChange((value) => {
          this.state.theme = value.trim();
        });
      });

    if (this.state.course) {
      const contextHint = contentEl.createDiv({ cls: "transcript-gui-hint" });
      contextHint.setText(`Vorausgewaehlter Kurs: ${this.state.course.replaceAll("_", " ")}`);
    }

    const hintEl = contentEl.createDiv({ cls: "transcript-gui-hint" });
    hintEl.setText(`Backend: ${this.plugin.settings.backendUrl}`);

    const actionsEl = contentEl.createDiv({ cls: "transcript-gui-actions" });
    this.submitButtonEl = actionsEl.createEl("button", { text: this.isSubmitting ? "Verarbeite..." : "Pipeline starten", cls: "mod-cta" });
    this.submitButtonEl.disabled = this.isSubmitting;
    this.submitButtonEl.addEventListener("click", () => this.submit());

    this.cancelButtonEl = actionsEl.createEl("button", { text: "Schliessen" });
    this.cancelButtonEl.disabled = this.isSubmitting;
    this.cancelButtonEl.addEventListener("click", () => this.close());

    this.statusEl = contentEl.createDiv({ cls: "transcript-gui-status" });
    this.setStatus(this.statusMessage, this.statusKind);
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
    if (this.submitButtonEl) {
      this.submitButtonEl.disabled = isBusy;
      this.submitButtonEl.textContent = isBusy ? "Verarbeite..." : "Pipeline starten";
    }
    if (this.cancelButtonEl) {
      this.cancelButtonEl.disabled = isBusy;
    }
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

    try {
      const result = await this.plugin.processLecture({
        audio_path: this.state.audioPath,
        course: this.state.course,
        date: this.state.date,
        session_type: this.state.sessionType,
        theme: this.state.theme,
      });

      this.setStatus(`Fertig.\nNote: ${result.paths.note_path}\nRohtranskript: ${result.paths.transcript_markdown_path}`, "success");
      await this.plugin.recordLastRun({
        timestamp: new Date().toISOString(),
        status: "completed",
        notePath: result.paths.note_path,
        transcriptPath: result.paths.transcript_markdown_path,
        audioPath: this.state.audioPath,
        course: this.state.course,
        theme: this.state.theme,
      });
      new Notice("Transkript-Pipeline erfolgreich abgeschlossen.");

      if (this.plugin.settings.openNoteAfterProcessing) {
        await this.plugin.openNoteFromAbsolutePath(result.paths.note_path);
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
      new Notice("Transkript-Pipeline fehlgeschlagen.");
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
          const result = await this.processLecture(payload);
          await this.recordLastRun({
            timestamp: new Date().toISOString(),
            status: "completed",
            notePath: result.paths.note_path,
            transcriptPath: result.paths.transcript_markdown_path,
            audioPath: latest.path,
            course,
            theme: payload.theme,
          });
          new Notice(`Verarbeitung abgeschlossen: ${payload.theme}`);
          if (this.settings.openNoteAfterProcessing) {
            await this.openNoteFromAbsolutePath(result.paths.note_path);
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

  async openNoteFromAbsolutePath(absolutePath) {
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
};

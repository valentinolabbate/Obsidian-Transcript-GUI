# Obsidian Transcript GUI

Obsidian-Plugin als GUI fuer die Lecture-Pipeline. Das Backend wird jetzt automatisch im Plugin-Ordner verwaltet.

## Funktionen

- Audio aus dem Vault waehlen
- neueste Datei aus der Inbox uebernehmen
- neueste Inbox-Datei direkt verarbeiten
- Kurs, Datum, Sitzungstyp und Thema erfassen
- Kurs aus aktuellem Vault-Kontext vorbelegen
- letzten Lauf im Modal anzeigen
- Backend wird automatisch im Plugin-Ordner installiert und gestartet
- Backend-.env inklusive optionaler paralleler Audio-Analyse konfigurieren
- erzeugte Sitzungsnotiz direkt in Obsidian oeffnen

## Installation

1. BRAT in Obsidian installieren.
2. In BRAT: `Add Beta plugin with frozen version` oder `Add Beta plugin`.
3. Repo-URL eingeben: `https://github.com/valentinolabbate/Obsidian-Transcript-GUI`
4. Das Plugin fragt beim ersten Start nach, ob das Backend installiert werden soll.
5. Nach der Bestaetigung laedt das Plugin das Backend herunter, erstellt eine Python-Umgebung und installiert alles automatisch im Plugin-Ordner.

## Backend

Das Plugin spricht die lokale API des `Obsidian-Transcript-Server`-Backends an:

- `GET /health`
- `POST /process`
- `POST /jobs`
- `GET /jobs/{job_id}`
- `POST /jobs/{job_id}/cancel`

Das Backend wird im Plugin-Ordner unter `<vault>/.obsidian/plugins/obsidian-transcript-gui/.backend/` verwaltet.

## BRAT

Fuer BRAT muessen im Repo mindestens diese Dateien im Root liegen:

- `manifest.json`
- `main.js`
- optional `styles.css`
- optional `versions.json`

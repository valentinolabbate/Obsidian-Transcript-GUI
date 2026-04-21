# Obsidian Transcript GUI

Obsidian-Plugin als GUI fuer die lokale Lecture-Pipeline.

## Funktionen

- Audio aus dem Vault waehlen
- neueste Datei aus der Inbox uebernehmen
- neueste Inbox-Datei direkt verarbeiten
- Kurs, Datum, Sitzungstyp und Thema erfassen
- Kurs aus aktuellem Vault-Kontext vorbelegen
- letzten Lauf im Modal anzeigen
- lokales Backend unter `http://127.0.0.1:8765` aufrufen
- erzeugte Sitzungsnotiz direkt in Obsidian oeffnen

## Erwartetes Backend

Das Plugin spricht die lokale API der `obsidian-lecture-pipeline` an:

- `GET /health`
- `POST /process`

## BRAT

Fuer BRAT muessen im Repo mindestens diese Dateien im Root liegen:

- `manifest.json`
- `main.js`
- optional `styles.css`
- optional `versions.json`

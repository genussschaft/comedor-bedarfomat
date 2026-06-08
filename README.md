# ComedorBedarfomat

Frontend-only Web-App zum Arbeiten mit der Comedor-Bestellliste.

## Was die App kann

- Excel-Datei der aktuellen Comedor-Bestellliste importieren
- Produktkatalog mit Suche, Produzentenfilter und Sortierung
- Soll-Werte direkt im Katalog setzen
- Inventuransicht mit Soll / Ist / abgeleiteter Bestellung
- Vorherige Bestellliste importieren, um Soll-Werte automatisch vorzubelegen
- Nicht mehr gefundene Produkte aus der vorigen Runde anzeigen
- Lokale Persistenz im Browser, damit bei Reload, Back oder versehentlichem Schließen nichts verloren geht
- Excel-Export mit den Spalten `Soll`, `Ist`, `Bestellung` und aktualisierten Totals
- Responsives Layout mit fixierter Bestellübersicht auf großen Screens

## Aktuelle Logik

- `Soll` ist die gewünschte Zielmenge.
- `Ist` ist der aktuelle Bestand.
- `Bestellung` wird so berechnet:
  - wenn `Ist` leer ist: `Bestellung = Soll`
  - wenn `Ist` gesetzt ist: `Bestellung = max(Soll - Ist, 0)`
- Exportierte Dateien enthalten immer die Spalten `Soll`, `Ist` und `Bestellung`.

## Workbook-Annahmen

Die App ist auf die echte Comedor-Datei `2026-2_mai.xlsx` abgestimmt:

- Blatt: `Bestelliste_Genossenschaft`
- Kopfzeile: Zeile `16`
- Wichtige Standardspalten:
  - `Name`
  - `Verpackung`
  - `Produzent`
  - `Preis`
  - `Gebindegröße`
  - `Soll`
  - `Ist`
  - `Bestellung`
  - `Total (CHF)`

Falls sich das Format ändert, kann die Feldzuordnung in der Oberfläche angepasst werden.

## Entwicklung

```bash
npm install
npm start
```

Der Start-Befehl startet den Entwicklungsserver unter `http://127.0.0.1:5173/`.
Alternativ funktioniert weiterhin `npm run dev`.

Build und Lint:

```bash
npm run build
npm run lint
```

## Cloudflare-Proxy

Der automatische Download läuft in Produktion über einen Cloudflare Worker, damit GitHub Pages die Comedor-Dateien ohne CORS-Fehler lesen kann.

Lokal testen:

```bash
npm run worker:dev
VITE_COMEDOR_PROXY_URL=http://127.0.0.1:8787 npm run build
```

Deploy:

```bash
npm run worker:deploy
```

Wrangler verwendet den lokalen Cloudflare-Login (`wrangler login`) oder eine
temporäre Umgebungsvariable wie `CLOUDFLARE_API_TOKEN`. Es wird kein Token in die Worker-Konfiguration geschrieben.

Nach dem Deploy muss die GitHub-Repository-Variable `VITE_COMEDOR_PROXY_URL` auf die Worker-URL zeigen, zum Beispiel `https://...workers.dev`.
Der Pages-Workflow gibt diese Variable beim Build an Vite weiter. Der Worker liefert nur die aktuelle Comedor-XLSX-Datei aus.

## Offene Produktfragen

- Sollen Bruchteile bei allen Produkten erlaubt bleiben oder soll für gewisse Produkte auf ganze Gebinde gerundet werden?
- Soll die Bestellung beim Export zusätzlich farblich markiert werden, damit Depot-Teams neue Soll-/Ist-Spalten schneller sehen?
- Reicht Matching über `Artikelnummer -> Name + Produzent -> Name`, oder braucht es noch manuelle Zuordnungen für umbenannte Produkte?

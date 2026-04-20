# ComedorBedarfomat

Frontend-only Web-App zum Arbeiten mit der Comedor-Bestellliste.

## Was die App kann

- Excel-Datei der aktuellen Comedor-Bestellliste importieren
- Produktkatalog mit Suche, Filterung nach Produzent und Verpackung/Typ
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
npm run dev
```

Build und Lint:

```bash
npm run build
npm run lint
```

## Offene Produktfragen

- Sollen Bruchteile bei allen Produkten erlaubt bleiben oder soll für gewisse Produkte auf ganze Gebinde gerundet werden?
- Soll die Bestellung beim Export zusätzlich farblich markiert werden, damit Depot-Teams neue Soll-/Ist-Spalten schneller sehen?
- Reicht Matching über `Artikelnummer -> Name + Produzent -> Name`, oder braucht es noch manuelle Zuordnungen für umbenannte Produkte?

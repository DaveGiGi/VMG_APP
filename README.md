# VMG Segeln

Web-App (PWA), die beim Segeln die **VMG – Velocity Made Good** zu einem gewählten Ziel anzeigt:
wie schnell man sich tatsächlich dem Ziel nähert.

```
VMG = SOG × cos(COG − Peilung zum Ziel)
```

- **SOG** Speed over Ground (Fahrt über Grund, aus GPS)
- **COG** Course over Ground (Kurs über Grund, aus GPS)
- **Peilung** Richtung vom Boot zum Ziel

## Funktionen

- Karte (OpenStreetMap) mit Seezeichen-Overlay (OpenSeaMap)
- Ziel setzen: Ort suchen, Koordinaten eingeben (`54.32, 10.14`), 🎯 und auf die Karte tippen oder lange drücken; Ziel ist verschiebbar
- Anzeige: VMG, SOG, COG, Peilung, Distanz (sm), ETA, GPS-Genauigkeit, Abweichung vom direkten Kurs
- Demo-Modus (▶︎) mit Reglern für Kurs und Fahrt – zum Testen an Land
- Bildschirm bleibt an (Wake Lock), App-Dateien und angesehene Kartenkacheln funktionieren offline

## Projektstruktur

| Datei | Zweck |
|---|---|
| `index.html` | Seitenaufbau |
| `css/style.css` | Aussehen |
| `js/nav.js` | Navigations-Mathematik (Distanz, Peilung, VMG, ETA) – ohne Browser-Abhängigkeit |
| `js/app.js` | Karte, GPS, Suche, Anzeige, Demo |
| `sw.js` | Service Worker (Offline-Cache) |
| `manifest.webmanifest` | macht die Seite als App installierbar |
| `tests/nav.test.mjs` | Tests für `nav.js` |

Kein Build-Schritt, keine Abhängigkeiten – Leaflet wird vom CDN geladen.

## Lokal starten

Voraussetzung: [Node.js](https://nodejs.org).

```bash
npm start
```

Dann http://localhost:8080 öffnen. Tests:

```bash
npm test
```

## Auf dem Handy nutzen (GitHub Pages)

GPS funktioniert im Browser nur über HTTPS – GitHub Pages liefert das kostenlos.

1. Auf github.com ein neues, leeres Repository `VMG_APP` anlegen (ohne README).
2. Lokal verbinden und hochladen:
   ```bash
   git remote add origin https://github.com/<benutzername>/VMG_APP.git
   git push -u origin main
   ```
3. Im Repository: **Settings → Pages → Source: Deploy from a branch → Branch `main`, Ordner `/ (root)` → Save**.
4. Nach ~1 Minute ist die App unter `https://<benutzername>.github.io/VMG_APP/` erreichbar.
5. Auf dem Android-Handy in Chrome öffnen → Standort erlauben → Menü ⋮ → **Zum Startbildschirm hinzufügen**.

## Grenzen der Version 1

- Keine Strömung/Wind: VMG bezieht sich auf das Ziel (VMC), nicht auf den Wind.
- Karte offline nur für bereits angesehene Gebiete.
- Ortssuche braucht Internet (Nominatim).
- Läuft der Bildschirm aus bzw. ist die App im Hintergrund, pausiert das GPS.

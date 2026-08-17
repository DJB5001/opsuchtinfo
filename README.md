# opsuchtinfo

Datenrepo für [dnv-clan.de](https://dnv-clan.de) und den DNV-Bot. Eine
GitHub Action holt alle 15 Minuten den Stand des OPSucht-Auktionshauses
und schreibt ihn hier fest — Auktionen kann man nur beobachten, solange
sie laufen, und danach ist die Information weg.

## Was hier liegt

| Datei | Was drinsteht |
|---|---|
| `auction-history.json` | Jeder erkannte Verkauf der letzten 90 Tage, nach Itemnamen sortiert. ~34 MB |
| `shard-history.json` | Verlauf der Shard-Preise |
| `wert-index.json` | Zusammenfassung für den Discord-Bot. ~1 MB |
| `history-updater/state.json` | Die zuletzt gesehenen aktiven Auktionen — daraus ergibt sich, was verkauft wurde |
| `history-updater/namen.json` | UUID → Spielername, mit Zeitpunkt des letzten Versuchs |
| `history-updater/last-run.txt` | Zeitstempel, damit jeder Lauf einen Commit ergibt |

**Jede Datei, die ein Lauf schreibt, muss in der `git add`-Zeile der
Action stehen.** Was dort fehlt, wird gebaut und beim nächsten Checkout
weggeworfen — ohne Fehlermeldung, ohne Spur.

## Wie ein Verkauf erkannt wird

Die API sagt nur, was gerade läuft. Der Updater merkt sich diesen Stand
und vergleicht ihn beim nächsten Lauf: Was verschwunden ist und ein
echtes Gebot hatte, gilt als verkauft. Was ohne Gebot verschwindet, wurde
zurückgezogen und zählt nicht.

## Der Wert-Index

`wert-index.json` entsteht bei jedem Lauf mit (`history-updater/wert-index.js`).
Der Bot soll auf `/wert` in Sekunden antworten; 34 MB je Befehl zu laden
geht nicht. Also je Item und Variante die Zahlen der letzten 30 Tage,
dazu die Bilanz jedes Spielers.

Verlängerte Auktionen sind dabei zusammengefasst — wird kurz vor Schluss
noch geboten, hält der Verlauf jeden Zwischenstand als eigenen Eintrag
fest, gut 16 % aller Einträge. Dafür steht derselbe Code hier wie in
`DNV-Website/js/script.js`, und `wert-index.test.js` lässt beide
Fassungen über alle 41.000 Verkäufe laufen und vergleicht das Ergebnis
Funktion für Funktion. Weichen sie ab, nennt der Bot andere
Durchschnitte als die Website — zwei Quellen, die sich widersprechen,
sind schlimmer als eine.

### Getrennt wird nach Material, Lore und Verzauberungen

Zwei Dinge können denselben Namen tragen und nichts miteinander zu tun
haben. Die Knochenspitzhacke gibt es als „Episch" für Ø 220 Tsd und als
„Jackpot" für Ø 5,5 Mio.

Die Verzauberungen waren dabei lange nicht berücksichtigt, mit der
Begründung, sie würden die Gruppen zersplittern. Nachgemessen stimmt das
nicht: **183 Gruppen mit 5.874 Verkäufen** lagen dadurch in einem
gemeinsamen Durchschnitt, in 18 davon weicht der Schnitt um Faktor 2 bis
15 ab. Und zersplittert wird nichts — die Varianten steigen von 3.278 auf
3.908, die tragfähigen mit mindestens fünf Verkäufen aber von 1.268 auf
1.275: Vermengte Gruppen zerfallen in saubere, die einzeln über der
Schwelle bleiben.

Jeder Eintrag trägt den Verzauberungsstempel als `e` mit. Nur damit kann
der Bot eine laufende Auktion der richtigen Ausführung zuordnen — sonst
vergleicht der Schnäppchen-Alarm eine schlicht verzauberte Spitzhacke mit
dem Schnitt der gut verzauberten.

## Die Händlernamen

Der Index kennt knapp siebentausend Händler, aber nur ihre UUIDs. Für die
Vorschläge bei `/spieler` im Discord müssen daraus Namen werden, und die
gibt es nur einzeln abzufragen.

`history-updater/namen.js` löst deshalb **je Lauf höchstens fünfzig** auf,
die umsatzstärksten zuerst. Nach gut einem Tag ist der ganze Bestand
beisammen, die wichtigsten schon nach einer Stunde. Aufgelöste Namen
bleiben stehen und werden erst nach 30 Tagen erneut geprüft.

Drei Vorkehrungen, damit die Zugabe nie die Hauptsache gefährdet:

- **Ein Zeitbudget von 90 Sekunden.** Fällt ein Dienst aus, läuft jede
  Anfrage in ihr Zeitlimit; fünfzig davon wären mehr als der Abstand zum
  nächsten Lauf, und die Läufe würden sich stauen.
- **Fehler brechen nichts ab.** Wer nicht auflösbar ist, bekommt einen
  Vermerk und ist in ein paar Tagen wieder dran.
- **Ein Ausfall kostet keinen bekannten Namen.** Scheitert die
  Auffrischung, bleibt der alte stehen und wird nur früher erneut geprüft.

Im Index hängt der Name an fünfter Stelle der Spielerzeile
(`[ein, aus, verkauft, gewonnen, name]`) und nicht in einer eigenen
Liste: Sonst stünde jede UUID ein zweites Mal in der Datei, 350 KB nur
für Schlüssel, die schon da sind.

## Tests

```bash
node history-updater/wert-index.test.js   # Index, und Abgleich mit der Website
node history-updater/namen.test.js        # Namensauflösung, ohne Netz
```

Der Abgleich mit der Website läuft nur, wenn `DNV-Website` daneben
ausgecheckt ist; sonst überspringt er sich mit Hinweis.

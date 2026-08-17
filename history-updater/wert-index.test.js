// Prüft den Wert-Index.
//
// Der wichtigste Teil ist nicht die Struktur, sondern der Abgleich: Die
// Entdopplung verlängerter Auktionen steht zweimal im Projekt — einmal
// in DNV-Website/js/script.js, einmal hier. Weichen sie voneinander ab,
// nennt der Bot andere Durchschnitte als die Website, und niemand merkt
// es, bis sich jemand wundert.
//
// Deshalb schneidet dieser Test den echten Code aus der Website heraus
// und lässt beide Fassungen über dieselben Daten laufen. Stimmen sie
// nicht überein, schlägt er fehl.
//
// Aufruf:
//   node history-updater/wert-index.test.js
//   node history-updater/wert-index.test.js <pfad-zu-auction-history.json>

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const eigen = require('./wert-index.js');

let fehler = 0;
function pruefe(text, bedingung, zusatz = '') {
  console.log(`${bedingung ? '  ok  ' : ' FEHL '} ${text}${zusatz ? '  → ' + zusatz : ''}`);
  if (!bedingung) fehler += 1;
}

const TAG = 24 * 60 * 60 * 1000;

// ── 1. Struktur, gegen erfundene aber echt geformte Daten ────────────
console.log('— Aufbau des Index —');

const JETZT = Date.parse('2026-08-17T12:00:00Z');
const vorTagen = (n, stunde = 12) =>
  new Date(JETZT - n * TAG).toISOString().replace(/T\d\d/, `T${String(stunde).padStart(2, '0')}`);

const verkauf = (o) => ({
  seller: o.seller ?? 'verk-1',
  highestBidder: o.kaeufer ?? 'kauf-1',
  startBid: o.preis,
  currentBid: o.preis,
  finalPrice: o.preis,
  soldAt: o.zeit,
  bids: o.bids ?? { 'kauf-1': o.preis },
  item: {
    material: o.material ?? 'NETHERITE_PICKAXE',
    displayName: o.name ?? 'Bohrer V3',
    amount: o.menge ?? 1,
    lore: o.lore ?? [],
  },
});

const verlauf = {
  'Bohrer V3': [
    verkauf({ preis: 800, zeit: vorTagen(2) }),
    verkauf({ preis: 900, zeit: vorTagen(2, 13) }),
    verkauf({ preis: 1000, zeit: vorTagen(5) }),
    // Dieselbe Ware als Sammelkarte: eigenes Material, eigener Preis.
    verkauf({ preis: 4, zeit: vorTagen(3), material: 'PAPER', lore: ['', 'Gewinntyp » Sammelkarte'] }),
    // Zu alt für das 30-Tage-Fenster, zählt aber für die Spielerbilanz.
    verkauf({ preis: 5000, zeit: vorTagen(45) }),
  ],
  'Stapel Steine': [
    verkauf({ preis: 640, zeit: vorTagen(1), name: 'Stapel Steine', material: 'STONE', menge: 64 }),
  ],
};

const { index } = eigen.baueIndex(verlauf, JETZT);

pruefe('Beide Items stehen drin', Object.keys(index.items).sort().join(',') === 'Bohrer V3,Stapel Steine',
  Object.keys(index.items).join(','));

const bohrer = index.items['Bohrer V3'];
pruefe('Zwei Varianten getrennt', bohrer.length === 2, `${bohrer.length}`);

const hacke = bohrer.find((e) => e.m === 'NETHERITE_PICKAXE');
const karte = bohrer.find((e) => e.m === 'PAPER');

pruefe('Häufigste Variante steht vorn', bohrer[0] === hacke, bohrer[0].m);
pruefe('Nur die drei Verkäufe im Fenster', hacke.n === 3, `${hacke.n}`);
pruefe('Durchschnitt stimmt', hacke.d === 900, `${hacke.d}`);
pruefe('Spanne stimmt', hacke.min === 800 && hacke.max === 1000, `${hacke.min}–${hacke.max}`);
pruefe('Die Sammelkarte bleibt getrennt', karte.n === 1 && karte.d === 4, `${karte.d}`);
pruefe('Variantenname aus der Lore', karte.v === 'Sammelkarte', karte.v);
pruefe('Ohne Lore der Materialname', hacke.v === 'Netherite Pickaxe', hacke.v);

const tage = Object.keys(hacke.t).sort();
pruefe('Zwei Tage mit Verkauf', tage.length === 2, tage.join(', '));
pruefe('Tage sind aufsteigend', tage[0] < tage[1], tage.join(' < '));
pruefe('Der Tag mit zwei Verkäufen mittelt', hacke.t[tage[1]][0] === 2 && hacke.t[tage[1]][1] === 850,
  JSON.stringify(hacke.t[tage[1]]));

const summeTage = Object.values(hacke.t).reduce((s, [n]) => s + n, 0);
pruefe('Die Tage ergeben zusammen die Gesamtzahl', summeTage === hacke.n, `${summeTage} von ${hacke.n}`);

// Preis pro Stück, nicht pro Auktion.
const stein = index.items['Stapel Steine'][0];
pruefe('Preis gilt pro Stück', stein.d === 10, `${stein.d}`);

// ── 2. Spielerbilanz ────────────────────────────────────────────────
console.log('\n— Spielerbilanz —');

const verk = index.spieler['verk-1'];
pruefe('Verkäufer ist verzeichnet', Array.isArray(verk), JSON.stringify(verk));
pruefe('Alle sechs Verkäufe zählen, auch die alten', verk[2] === 6, `${verk[2]}`);
pruefe('Einnahmen über den ganzen Verlauf', verk[0] === 800 + 900 + 1000 + 4 + 5000 + 640,
  `${verk[0]}`);
pruefe('Der Käufer steht auf der anderen Seite', index.spieler['kauf-1'][3] === 6,
  `${index.spieler['kauf-1'][3]}`);

const ohneUmsatz = Object.values(index.spieler).filter((k) => k[2] === 0 && k[3] === 0);
pruefe('Keine leeren Konten in der Datei', ohneUmsatz.length === 0, `${ohneUmsatz.length}`);

// ── 3. Verlängerte Auktionen ────────────────────────────────────────
console.log('\n— Verlängerungen —');

// Dieselbe Auktion, dreimal aufgenommen: gleiche Bieter, nie weniger,
// jeweils wenige Minuten auseinander.
const kette = {
  'Bohrer V3': [
    verkauf({ preis: 815, zeit: vorTagen(1, 10), bids: { a: 800, b: 815 } }),
    verkauf({ preis: 861, zeit: new Date(Date.parse(vorTagen(1, 10)) + 4 * 60000).toISOString(),
              bids: { a: 800, b: 861 } }),
    verkauf({ preis: 900, zeit: new Date(Date.parse(vorTagen(1, 10)) + 8 * 60000).toISOString(),
              bids: { a: 850, b: 900 } }),
  ],
};

const gekettet = eigen.baueIndex(kette, JETZT);
pruefe('Zwei Zwischenstände erkannt', gekettet.entdoppelt === 2, `${gekettet.entdoppelt}`);
pruefe('Nur ein Verkauf bleibt', gekettet.index.items['Bohrer V3'][0].n === 1);
pruefe('Und zwar der letzte Preis', gekettet.index.items['Bohrer V3'][0].d === 900,
  `${gekettet.index.items['Bohrer V3'][0].d}`);
pruefe('Die Bilanz zählt ihn auch nur einmal', gekettet.index.spieler['verk-1'][2] === 1,
  `${gekettet.index.spieler['verk-1'][2]}`);

// ── 4. Abgleich mit der Website ─────────────────────────────────────
console.log('\n— Abgleich mit der Website —');

const websitePfad = path.join(__dirname, '..', '..', 'DNV-Website', 'js', 'script.js');
const verlaufPfad =
  process.argv[2] || process.env.AUKTIONSVERLAUF || path.join(__dirname, '..', 'auction-history.json');

if (!fs.existsSync(websitePfad)) {
  console.log('  --  DNV-Website nicht daneben ausgecheckt, Abgleich übersprungen.');
} else if (!fs.existsSync(verlaufPfad)) {
  console.log('  --  auction-history.json nicht gefunden, Abgleich übersprungen.');
} else {
  // Den echten Code der Website ausschneiden statt nachzubauen - sonst
  // prueft der Test eine Kopie gegen eine Kopie.
  const quelle = fs.readFileSync(websitePfad, 'utf8');
  const schnipsel = (von, bis) => {
    const a = quelle.indexOf(von);
    const b = quelle.indexOf(bis);
    if (a < 0 || b < 0) throw new Error(`Block in der Website nicht gefunden: ${von}`);
    return quelle.slice(a, b);
  };
  const fenster = quelle.match(/const VERLAENGERUNG_FENSTER_MS = [^;]+;/);
  if (!fenster) throw new Error('VERLAENGERUNG_FENSTER_MS nicht gefunden');

  // Zwei Schnipsel, weil materialLesbar weiter oben im Bild-Abschnitt
  // steht, variantenLabel es aber braucht. Dieselbe Aufteilung benutzt
  // DNV-Website/tests/index-test.mjs.
  const block =
    fenster[0] + '\n' +
    schnipsel('// NETHERITE_PICKAXE wird zu', '// Rückfallkette für Item-Bilder') +
    schnipsel('function salePricePerUnit(sale)', 'function getMonthlyAveragePerUnit');

  const kontext = { console, App: { auctionHistory: {} } };
  vm.createContext(kontext);
  vm.runInContext(
    block + '\nglobalThis.__api = { verlaufEntdoppeln, itemVariante, variantenLabel, salePricePerUnit };',
    kontext
  );
  const website = kontext.__api;

  // Erst an den erfundenen Daten, dann an den echten.
  const a = website.verlaufEntdoppeln(kette);
  const b = eigen.verlaufEntdoppeln(kette);
  pruefe('Gleiche Zahl Zwischenstände (Beispiel)', a.entfernt === b.entfernt, `${a.entfernt} / ${b.entfernt}`);

  const echt = JSON.parse(fs.readFileSync(verlaufPfad, 'utf8'));
  const wA = website.verlaufEntdoppeln(echt);
  const wB = eigen.verlaufEntdoppeln(echt);

  pruefe('Gleiche Zahl Zwischenstände (echte Daten)', wA.entfernt === wB.entfernt,
    `Website ${wA.entfernt}, Index ${wB.entfernt}`);

  const zaehle = (v) => Object.values(v).reduce((n, l) => n + (Array.isArray(l) ? l.length : 0), 0);
  pruefe('Gleich viele Verkäufe übrig', zaehle(wA.verlauf) === zaehle(wB.verlauf),
    `${zaehle(wA.verlauf)} / ${zaehle(wB.verlauf)}`);

  // Und die abgeleiteten Funktionen ebenfalls.
  const probe = Object.values(echt).find((l) => Array.isArray(l) && l.length)?.[0];
  if (probe) {
    pruefe('Gleiche Variantenkennung',
      website.itemVariante(probe.item) === eigen.itemVariante(probe.item));
    pruefe('Gleicher Variantenname',
      website.variantenLabel(probe.item) === eigen.variantenLabel(probe.item),
      eigen.variantenLabel(probe.item));
    pruefe('Gleicher Stückpreis',
      website.salePricePerUnit(probe) === eigen.salePricePerUnit(probe),
      `${eigen.salePricePerUnit(probe)}`);
  }
}

console.log(fehler ? `\n${fehler} Fehler.` : '\nAlle Prüfungen bestanden.');
process.exit(fehler ? 1 : 0);

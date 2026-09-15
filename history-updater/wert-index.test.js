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
    enchantments: o.ench ?? {},
  },
});

const verlauf = {
  'Bohrer V3': [
    verkauf({ preis: 800, zeit: vorTagen(2) }),
    verkauf({ preis: 900, zeit: vorTagen(2, 13) }),
    verkauf({ preis: 1000, zeit: vorTagen(5) }),
    // Dieselbe Ware als Sammelkarte: eigenes Material, eigener Preis.
    verkauf({ preis: 4, zeit: vorTagen(3), material: 'PAPER', lore: ['', 'Gewinntyp » Sammelkarte'] }),
    // Zu alt für das Fenster, zählt aber für die Spielerbilanz.
    verkauf({ preis: 5000, zeit: vorTagen(120) }),
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

// Tiefst- und Höchstpreis je Tag kamen dazu, damit Bot und Website die
// Spanne eines kürzeren Fensters rechnen können. Die beiden alten Stellen
// bleiben, wo sie waren — das ist die Zusage an alles, was schon liest.
pruefe('Je Tag stehen vier Werte', Object.values(hacke.t).every((w) => w.length === 4),
  JSON.stringify(hacke.t[tage[1]]));
pruefe('Spanne des Tages mit zwei Verkäufen',
  hacke.t[tage[1]][2] === 800 && hacke.t[tage[1]][3] === 900, JSON.stringify(hacke.t[tage[1]]));
pruefe('Ein Tag mit einem Verkauf hat Spanne null',
  hacke.t[tage[0]][2] === hacke.t[tage[0]][3] && hacke.t[tage[0]][2] === hacke.t[tage[0]][1],
  JSON.stringify(hacke.t[tage[0]]));

// Die Gegenprobe auf die Zusage: Wer wie bisher [anzahl, preis]
// auseinandernimmt, bekommt weiter Anzahl und Tagesschnitt.
const [altAnzahl, altPreis] = hacke.t[tage[1]];
pruefe('Alte Leser lesen weiter richtig', altAnzahl === 2 && altPreis === 850,
  `${altAnzahl} × ${altPreis}`);

const summeTage = Object.values(hacke.t).reduce((s, [n]) => s + n, 0);
pruefe('Die Tage ergeben zusammen die Gesamtzahl', summeTage === hacke.n, `${summeTage} von ${hacke.n}`);

// Preis pro Stück, nicht pro Auktion.
const stein = index.items['Stapel Steine'][0];
pruefe('Preis gilt pro Stück', stein.d === 10, `${stein.d}`);

// ── 1a. Das Fenster reicht 90 Tage zurück ───────────────────────────
console.log('\n— Wie weit der Index zurückreicht —');

const weitZurueck = eigen.baueIndex(
  {
    Alteisen: [
      verkauf({ preis: 100, zeit: vorTagen(45), name: 'Alteisen', material: 'IRON_INGOT' }),
      verkauf({ preis: 200, zeit: vorTagen(89), name: 'Alteisen', material: 'IRON_INGOT' }),
      verkauf({ preis: 999, zeit: vorTagen(91), name: 'Alteisen', material: 'IRON_INGOT' }),
    ],
  },
  JETZT
).index;

pruefe('Der Index nennt sein Fenster', weitZurueck.tage === 90, `${weitZurueck.tage}`);
const eisen = weitZurueck.items['Alteisen'][0];
pruefe('45 und 89 Tage alt sind drin, 91 nicht mehr', eisen.n === 2, `${eisen.n}`);
pruefe('Und der Schnitt ist der der beiden', eisen.d === 150, `${eisen.d}`);

// ── 1b. Verzauberungen trennen Varianten ────────────────────────────
console.log('\n— Verzauberungen —');

// Der Fall, um den es geht: gleiches Material, gleiche Lore, aber die eine
// Ausführung ist deutlich besser verzaubert und viel mehr wert. Vorher
// lagen beide in einem Durchschnitt, der für keine von beiden stimmte.
const lore = ['', 'Knochenkollektion (1/12)', '', 'Gewinntyp » Item', 'Seltenheit » Episch'];
const schlicht = { 'minecraft:efficiency': 5, 'minecraft:unbreaking': 6, 'minecraft:mending': 1 };
const stark = { 'minecraft:efficiency': 6, 'minecraft:fortune': 4, 'minecraft:unbreaking': 5 };

const verzaubert = eigen.baueIndex(
  {
    Knochenspitzhacke: [
      verkauf({ preis: 200_000, zeit: vorTagen(3), name: 'Knochenspitzhacke', lore, ench: schlicht }),
      verkauf({ preis: 220_000, zeit: vorTagen(2), name: 'Knochenspitzhacke', lore, ench: schlicht }),
      verkauf({ preis: 5_500_000, zeit: vorTagen(1), name: 'Knochenspitzhacke', lore, ench: stark }),
    ],
  },
  JETZT
).index.items['Knochenspitzhacke'];

pruefe('Zwei Ausführungen statt einer', verzaubert.length === 2, `${verzaubert.length}`);

const guenstig = verzaubert.find((v) => v.d < 1_000_000);
const teuer = verzaubert.find((v) => v.d > 1_000_000);
pruefe('Die schlichte behält ihren eigenen Schnitt', guenstig?.d === 210_000, `${guenstig?.d}`);
pruefe('Die starke wird nicht mit hineingerechnet', teuer?.d === 5_500_000, `${teuer?.d}`);
pruefe('Die häufigere steht vorn', verzaubert[0] === guenstig);

pruefe('Die Etiketten unterscheiden sich', guenstig.v !== teuer.v, `${guenstig.v}  ≠  ${teuer.v}`);
pruefe('Und nennen die Verzauberungen', guenstig.v.includes('Effizienz V') && teuer.v.includes('Glück IV'),
  `${guenstig.v} | ${teuer.v}`);
pruefe('Die Seltenheit steht davor', guenstig.v.startsWith('Episch · '), guenstig.v);
pruefe('Stärkste Verzauberung zuerst', guenstig.v.indexOf('Haltbarkeit VI') < guenstig.v.indexOf('Reparatur I'),
  guenstig.v);

pruefe('Der Stempel liegt für den Bot bereit', typeof guenstig.e === 'string' && guenstig.e.includes('efficiency=5'),
  guenstig.e);
pruefe('Und unterscheidet die beiden', guenstig.e !== teuer.e);
pruefe('Sortiert, nicht in der Reihenfolge der API',
  guenstig.e === 'efficiency=5,mending=1,unbreaking=6', guenstig.e);
pruefe('Das Hilfsfeld beschreibung ist nicht in der Datei',
  verzaubert.every((v) => !('beschreibung' in v)));

// Ein Item ohne Verzauberungen darf nicht plötzlich anders heißen.
const ohne = eigen.baueIndex(
  { Eichenstamm: [verkauf({ preis: 12, zeit: vorTagen(1), name: 'Eichenstamm', material: 'OAK_LOG' })] },
  JETZT
).index.items['Eichenstamm'][0];
pruefe('Ohne Verzauberung bleibt der Materialname', ohne.v === 'Oak Log', ohne.v);
pruefe('Und der Stempel ist leer', ohne.e === '', JSON.stringify(ohne.e));

// Gleich benannte Ausführungen bekommen einen Zusatz aus der Beschreibung.
const bundleLore = (season) => ['', 'Enthält 1 Boosterpack aus', `der ${season}.`];
const bundles = eigen.baueIndex(
  {
    'Boosterpack Bundle': [
      verkauf({ preis: 190_000, zeit: vorTagen(2), name: 'Boosterpack Bundle', material: 'GRAY_BUNDLE',
                lore: bundleLore('Season of Summer') }),
      verkauf({ preis: 125_000, zeit: vorTagen(1), name: 'Boosterpack Bundle', material: 'GRAY_BUNDLE',
                lore: bundleLore('Redstone Season') }),
    ],
  },
  JETZT
).index.items['Boosterpack Bundle'];

pruefe('Gleiche Namen bekommen einen Zusatz', bundles[0].v !== bundles[1].v,
  `${bundles[0].v}  ≠  ${bundles[1].v}`);
pruefe('Und zwar die Zeile, die sie unterscheidet',
  bundles.some((b) => b.v.includes('Season of Summer')) && bundles.some((b) => b.v.includes('Redstone Season')),
  bundles.map((b) => b.v).join(' | '));
pruefe('Die gemeinsame Zeile steht nicht dabei',
  bundles.every((b) => !b.v.includes('Enthält 1 Boosterpack')), bundles[0].v);

// ── 1c. Ausreißer ziehen den Schnitt nicht mehr ─────────────────────
console.log('\n— Ausreißer —');

// Der Rechenweg, von Hand nachvollziehbar. Sechs Verkäufe zu 100, dann
// 700, 800, 900 — und einer zu 50.000:
//
//   sortiert    100 100 100 100 100 100 700 800 900 50000
//   Stelle       0   1   2   3   4   5   6   7   8    9
//   25 %  →  Stelle round(9 × 0,25) = 2  →  100
//   75 %  →  Stelle round(9 × 0,75) = 7  →  800
//
// Der 50.000er zählt damit als 800, die 900 ebenso, sonst ändert sich
// nichts:  (100×6 + 700 + 800 + 800 + 800) ÷ 10 = 3.700 ÷ 10 = 370.
const preisreihe = [100, 100, 100, 100, 100, 100, 700, 800, 900, 50_000];

pruefe('Der Schnitt liegt beim typischen Preis', eigen.winsorisierterSchnitt(preisreihe) === 370,
  `${eigen.winsorisierterSchnitt(preisreihe)}`);

// Zum Vergleich, was heute dastünde: Ein einziger Verkauf macht aus 370
// eine 5.300 — das Vierzehnfache.
const rohSchnitt = Math.round(preisreihe.reduce((a, b) => a + b, 0) / preisreihe.length);
pruefe('Der rohe Schnitt läge weit daneben', rohSchnitt === 5300, `${rohSchnitt}`);

// Und die Gegenprobe zur anderen Seite: Es ist weiter ein Schnitt und
// kein Median. Der läge hier bei 100 und würde die 700er, 800er und
// 900er komplett unterschlagen.
pruefe('Es bleibt ein Schnitt, kein Median', eigen.winsorisierterSchnitt(preisreihe) !== 100,
  `winsorisiert ${eigen.winsorisierterSchnitt(preisreihe)}, Median 100`);

// Wo die Preise sauber sind, passiert fast nichts. Das ist die Zusage,
// dass hier nicht pauschal nach unten gedrückt wird.
const sauber = [1000, 1050, 1100, 1150, 1200, 1250, 1300, 1350];
const sauberRoh = Math.round(sauber.reduce((a, b) => a + b, 0) / sauber.length);
pruefe('Saubere Preise bleiben, wo sie sind',
  Math.abs(eigen.winsorisierterSchnitt(sauber) - sauberRoh) / sauberRoh < 0.05,
  `${eigen.winsorisierterSchnitt(sauber)} statt ${sauberRoh}`);

// Unter vier Verkäufen gibt es keine Verteilung, aus der sich ein
// Perzentil ablesen ließe — dann bleibt es beim gewöhnlichen Mittel.
pruefe('Ein einzelner Verkauf ist der Preis', eigen.winsorisierterSchnitt([777]) === 777);
pruefe('Zwei Verkäufe werden gemittelt', eigen.winsorisierterSchnitt([10, 1000]) === 505,
  `${eigen.winsorisierterSchnitt([10, 1000])}`);
pruefe('Drei Verkäufe auch', eigen.winsorisierterSchnitt([1, 2, 3]) === 2,
  `${eigen.winsorisierterSchnitt([1, 2, 3])}`);

// ── 1d. Der Index rechnet damit, je Zeitraum ────────────────────────
console.log('\n— Die Zeiträume im Index —');

// Drei Preisstufen in drei Zeitfenstern, dazu ein Mondpreis. Die
// Verkäufe liegen Stunden auseinander, damit verlaufEntdoppeln() sie
// nicht für Zwischenstände derselben Auktion hält.
const preisstufe = (preis, tag, wieviele) =>
  Array.from({ length: wieviele }, (_, i) =>
    verkauf({ preis, zeit: vorTagen(tag, 1 + i), name: 'Glückslos', material: 'PAPER' }));

const glueckslos = eigen.baueIndex(
  {
    'Glückslos': [
      ...preisstufe(1000, 3, 8),
      verkauf({ preis: 90_000, zeit: vorTagen(3, 20), name: 'Glückslos', material: 'PAPER' }),
      ...preisstufe(2000, 22, 8),
      ...preisstufe(4000, 65, 8),
    ],
  },
  JETZT
).index.items['Glückslos'][0];

// 25 Verkäufe, einer davon der Mondpreis:
//   90 Tage  sortiert 1000×8, 2000×8, 4000×8, 90000
//            25 % → Stelle 6 → 1000,  75 % → Stelle 18 → 4000
//            (1000×8 + 2000×8 + 4000×8 + 4000) ÷ 25 = 60.000 ÷ 25 = 2.400
const rohGesamt = Math.round((1000 * 8 + 90_000 + 2000 * 8 + 4000 * 8) / 25);
pruefe('Der 90-Tage-Schnitt ist gedämpft', glueckslos.d === 2400, `${glueckslos.d} statt roh ${rohGesamt}`);
pruefe('Roh wäre er mehr als doppelt so hoch', rohGesamt === 5840, `${rohGesamt}`);

// Die Zusage, die Winsorisieren vom Aussortieren unterscheidet: Es wird
// nichts weggeworfen. Alle 25 Verkäufe zählen weiter, der Mondpreis
// steht weiter in der Spanne.
pruefe('Die Verkaufszahl ändert sich nicht', glueckslos.n === 25, `${glueckslos.n}`);
pruefe('Die Spanne zeigt den Ausreißer weiter',
  glueckslos.min === 1000 && glueckslos.max === 90_000, `${glueckslos.min}–${glueckslos.max}`);

// Die kürzeren Fenster stehen fertig in der Datei — der Bot kann sie
// nicht selbst rechnen, weil ein Perzentil die einzelnen Verkäufe
// braucht und er nur die Tagesreihe hat.
pruefe('w trägt beide kurzen Zeiträume',
  Object.keys(glueckslos.w).sort().join(',') === '15,30', Object.keys(glueckslos.w).join(','));

//   15 Tage  nur die 1000er und der Mondpreis; 25 % und 75 % sind beide
//            1000, also zählt auch er als 1000 → Schnitt 1.000
//   30 Tage  dazu die 2000er: 25 % → 1000, 75 % → 2000
//            (1000×8 + 2000×8 + 2000) ÷ 17 = 26.000 ÷ 17 = 1.529
pruefe('15 Tage: nur die jüngste Preisstufe', glueckslos.w[15] === 1000, `${glueckslos.w[15]}`);
pruefe('30 Tage: die beiden jüngeren zusammen', glueckslos.w[30] === 1529, `${glueckslos.w[30]}`);
pruefe('Und alle drei Zeiträume unterscheiden sich',
  glueckslos.w[15] !== glueckslos.w[30] && glueckslos.w[30] !== glueckslos.d,
  `${glueckslos.w[15]} / ${glueckslos.w[30]} / ${glueckslos.d}`);

// Die Tagesreihe bleibt roh. Sie trägt das Diagramm und die Zählungen,
// und an einem einzelnen Tag gibt es zu wenige Verkäufe, als dass
// Winsorisieren dort etwas hieße.
const mondtag = Object.entries(glueckslos.t).find(([, [, , , max]]) => max === 90_000);
pruefe('Der Mondpreis steht noch in seinem Tag', Boolean(mondtag),
  mondtag ? `${mondtag[0]}: ${JSON.stringify(mondtag[1])}` : 'nicht gefunden');
pruefe('Die Tage ergeben zusammen weiter alle Verkäufe',
  Object.values(glueckslos.t).reduce((s, [n]) => s + n, 0) === glueckslos.n,
  `${Object.values(glueckslos.t).reduce((s, [n]) => s + n, 0)} von ${glueckslos.n}`);

// Ein Fenster ohne Verkauf steht gar nicht erst drin — der Bot fällt
// dann auf die Tagesreihe zurück und kommt auf dieselbe leere Antwort.
const nurAlt = eigen.baueIndex(
  { 'Alteisen': [verkauf({ preis: 50, zeit: vorTagen(70), name: 'Alteisen', material: 'IRON_INGOT' })] },
  JETZT
).index.items['Alteisen'][0];
pruefe('Ohne Verkauf im Fenster steht dort nichts',
  Object.keys(nurAlt.w).length === 0, JSON.stringify(nurAlt.w));

// ── 1e. Die einzelnen Verkäufe fürs Diagramm ────────────────────────
//
// Das Bild bei /wert zeichnete einen Punkt je Tag — den Tagesschnitt.
// Ein Tag mit dreißig Verkäufen war ein Punkt. Anders ging es nicht: Die
// einzelnen Verkäufe standen nicht im Index. Jetzt stehen sie als `p`
// darin, flach und chronologisch: [Minute, Preis, Minute, Preis, …].
console.log('\n— Die einzelnen Verkäufe —');

const minuten = [];
const preise = [];
for (let i = 0; i + 1 < glueckslos.p.length; i += 2) {
  minuten.push(glueckslos.p[i]);
  preise.push(glueckslos.p[i + 1]);
}

pruefe('Jeder Verkauf steht einzeln drin', preise.length === glueckslos.n,
  `${preise.length} von ${glueckslos.n}`);
pruefe('Immer paarweise Minute und Preis', glueckslos.p.length === glueckslos.n * 2,
  `${glueckslos.p.length}`);

// Chronologisch, damit der Zeichner nicht sortieren muss — und damit die
// Datei sich zwischen zwei Läufen möglichst wenig ändert.
pruefe('Chronologisch geordnet', minuten.every((m, i) => i === 0 || m >= minuten[i - 1]),
  `${minuten[0]} … ${minuten[minuten.length - 1]}`);

// Die Minute zählt seit der Unix-Epoche. Absolut und nicht "vor jetzt",
// weil diese Datei alle 15 Minuten committet wird: Bei Abständen zu
// jetzt änderte sich mit jedem Lauf jede Zahl, und git könnte nichts
// mehr zusammenfassen.
const alsZeit = (minute) => new Date(minute * 60_000).toISOString();
pruefe('Die Minute zählt seit der Epoche, nicht ab jetzt',
  alsZeit(minuten[minuten.length - 1]) === vorTagen(3, 20).replace(/\.\d+Z$/, '.000Z'),
  `${alsZeit(minuten[minuten.length - 1])} statt ${vorTagen(3, 20)}`);

// Die älteste Preisstufe zuerst, der Mondpreis zuletzt — er war der
// späteste Verkauf des jüngsten Tages.
pruefe('Erst die älteste Preisstufe', preise[0] === 4000, `${preise[0]}`);
pruefe('Zuletzt der Mondpreis', preise[preise.length - 1] === 90_000, `${preise[preise.length - 1]}`);

const wieOft = (p) => preise.filter((x) => x === p).length;
pruefe('Alle Preisstufen vollständig',
  wieOft(4000) === 8 && wieOft(2000) === 8 && wieOft(1000) === 8 && wieOft(90_000) === 1,
  `4000×${wieOft(4000)} 2000×${wieOft(2000)} 1000×${wieOft(1000)} 90000×${wieOft(90_000)}`);

// Die schärfste Prüfung: Aus `p` allein lässt sich die Tagesreihe Zahl
// für Zahl nachbauen. Damit steht fest, dass die beiden dieselben
// Verkäufe beschreiben — und zugleich, warum `t` trotzdem bleibt: Ein
// Bot, der noch nicht neu ausgerollt ist, liest nur sie.
const nachgebaut = {};
for (let i = 0; i + 1 < glueckslos.p.length; i += 2) {
  const tag = new Date(glueckslos.p[i] * 60_000).toISOString().slice(0, 10);
  (nachgebaut[tag] ??= []).push(glueckslos.p[i + 1]);
}
const ausP = Object.fromEntries(
  Object.entries(nachgebaut).map(([tag, ps]) => [
    tag,
    [ps.length, Math.round(ps.reduce((a, b) => a + b, 0) / ps.length), Math.min(...ps), Math.max(...ps)],
  ])
);
pruefe('Die Tagesreihe lässt sich daraus nachbauen',
  JSON.stringify(ausP) === JSON.stringify(glueckslos.t),
  JSON.stringify(ausP) === JSON.stringify(glueckslos.t) ? '' : JSON.stringify(ausP));

// Und die Gegenprobe für den Randfall: Eine Variante, deren Verkäufe
// alle im Fenster liegen, aber nur einer ist.
pruefe('Auch ein einzelner Verkauf steht als Paar da',
  nurAlt.p.length === 2 && nurAlt.p[1] === 50, JSON.stringify(nurAlt.p));

// ── 1f. Was als ein Item gilt ───────────────────────────────────────
//
// Gemeldet wurde der XP Talisman: zweimal in der Liste, beide Male als
// "Jackpot". Es ist dasselbe Item — OPSucht hat Ende August "(Off-Hand)"
// in den Effekttext geschrieben, und Exemplare, die schon in Kisten
// lagen, behielten den alten. Minecraft backt die Lore in den
// Gegenstand, also laufen beide Texte nebeneinander weiter.
console.log('\n— Was als ein Item gilt —');

const talisman = (effekt) => [
  '',
  'Verdiene mit diesem Talisman mehr',
  'XP beim Farmen und Töten von Mobs!',
  '',
  `➥ Effekt: ${effekt}`,
  '',
  'Gewinntyp » Item',
  'Seltenheit » Jackpot',
];

const talismanIndex = (...effekte) =>
  eigen.baueIndex(
    {
      'XP Talisman': effekte.map((e, i) =>
        verkauf({
          preis: 15_000_000, zeit: vorTagen(2, 1 + i),
          name: 'XP Talisman', material: 'GOLDEN_HORSE_ARMOR', lore: talisman(e),
        })
      ),
    },
    JETZT
  ).index.items['XP Talisman'];

const zusammen = talismanIndex('x1,5 XP', 'x1,5 XP (Off-Hand)', 'x1,5 XP');
pruefe('Der Wirkungsort trennt keine Varianten mehr', zusammen.length === 1, `${zusammen.length}`);
pruefe('Und alle Verkäufe stehen in dem einen Eintrag', zusammen[0]?.n === 3, `${zusammen[0]?.n}`);

// Die Gegenprobe, und die ist die wichtigere: Die Regel darf nicht
// alles in Klammern schlucken. "(3 Minuten)" gegen "(5 Minuten)" ist
// ein echter Unterschied — wer den wegwirft, legt Items zusammen, die
// verschieden viel wert sind.
const getrennt = talismanIndex('x1,5 XP (3 Minuten)', 'x1,5 XP (5 Minuten)');
pruefe('Eine Dauer in Klammern trennt weiterhin', getrennt.length === 2, `${getrennt.length}`);

// Leerraum sagt nichts über den Gegenstand: Eine Zeile " " statt ""
// trennte bisher zwei Varianten.
const leerraum = eigen.baueIndex(
  {
    Propellerhut: [
      verkauf({ preis: 80_000, zeit: vorTagen(2), name: 'Propellerhut', material: 'LEATHER_HELMET',
        lore: ['', 'Betrachte die Welt mit', '', 'Seltenheit » Episch'] }),
      verkauf({ preis: 90_000, zeit: vorTagen(1), name: 'Propellerhut', material: 'LEATHER_HELMET',
        lore: [' ', 'Betrachte die Welt  mit', ' ', 'Seltenheit » Episch'] }),
    ],
  },
  JETZT
).index.items['Propellerhut'];
pruefe('Leerzeilen und doppelter Leerraum trennen nicht', leerraum.length === 1, `${leerraum.length}`);

// ── 1g. Gleich benannt heißt nicht gleich ───────────────────────────
//
// Der umgekehrte Fall, und der gefährlichere: Der Yamakuza Roller stand
// zwölfmal da, jedes Mal als "Golden Horse Armor" — dahinter +60 % bis
// +180 % Geschwindigkeit, mit Schnitten von 4,5 bis 155 Mio. Die
// zusammenzulegen wäre falsch; sie gleich zu benennen war es auch.
console.log('\n— Gleich benannt heißt nicht gleich —');

const roller = (prozent) =>
  eigen.baueIndex(
    {
      'Yamakuza Roller': prozent.map((p, i) =>
        verkauf({
          preis: p * 100_000, zeit: vorTagen(2, 1 + i),
          name: 'Yamakuza Roller', material: 'GOLDEN_HORSE_ARMOR',
          lore: ['', `➥ Effekt: +${p}% Geschwindigkeit (Hände, Kopf)`, '', 'Gewinntyp » Item'],
        })
      ),
    },
    JETZT
  ).index.items['Yamakuza Roller'];

const rollers = roller([60, 180]);
pruefe('Verschiedene Effektstärken bleiben getrennt', rollers.length === 2, `${rollers.length}`);
pruefe('Und heißen auch verschieden', rollers[0].v !== rollers[1].v,
  rollers.map((r) => r.v).join('  ≠  '));
pruefe('Die Effektstärke steht im Etikett',
  rollers.some((r) => r.v.includes('+60%')) && rollers.some((r) => r.v.includes('+180%')),
  rollers.map((r) => r.v).join(' | '));

// Und die Gegenprobe zur Glättung: Der Wirkungsort fällt aus dem
// **Schlüssel**, aber nicht aus dem Text. Angezeigt wird, was wirklich
// auf dem Gegenstand steht; zusammengelegt wird nach dem geglätteten.
//
// (Im Etikett ist er bei diesem Beispiel trotzdem nicht zu sehen — der
// Zusatz wird bei ZUSATZ_MAX abgeschnitten, damit die Zeile in Discords
// Auswahlmenü passt. Das ist eine andere Grenze und eine andere Sorge.)
const mitOrt = { lore: ['➥ Effekt: +60% Geschwindigkeit (Hände, Kopf)'] };
pruefe('Der Text behält den Wirkungsort',
  eigen.beschreibungsZeilen(mitOrt)[0] === '➥ Effekt: +60% Geschwindigkeit (Hände, Kopf)',
  eigen.beschreibungsZeilen(mitOrt)[0]);
pruefe('Der Schlüssel nicht',
  eigen.loreSchluessel(mitOrt) === '➥ Effekt: +60% Geschwindigkeit',
  eigen.loreSchluessel(mitOrt));

// ── 1h. Das Etikett sagt, was das Ding kann ─────────────────────────
//
// Gemeldet wurde das Auswahlmenü von /wert: Beim Yamakuza Roller
// standen zwölf Zeilen, und jede hieß "Golden Horse Armor". Das Item
// hat weder Seltenheit noch Verzauberungen, also griff variantenLabel()
// zum Materialnamen — dabei steht die Auskunft in der Lore.
console.log('\n— Was im Auswahlmenü steht —');

const rollerLore = (...effekte) => [
  '',
  ...effekte.map((e) => `➥ Effekt: ${e} (Hände, Kopf)`),
  '',
  'Gewinntyp » Item',
];

const rollerIndex = (ench, ...stufen) =>
  eigen.baueIndex(
    {
      'Yamakuza Roller': stufen.map((prozent, i) =>
        verkauf({
          preis: prozent * 100_000, zeit: vorTagen(2, 1 + i),
          name: 'Yamakuza Roller', material: 'GOLDEN_HORSE_ARMOR',
          lore: rollerLore(`+${prozent}% Geschwindigkeit`, '+10 Herzen'), ench,
        })
      ),
    },
    JETZT
  ).index.items['Yamakuza Roller'];

const ohneVerzauberung = rollerIndex({}, 60, 180);
pruefe('Ohne Verzauberungen steht der Effekt im Etikett',
  ohneVerzauberung[0].v === '+60% Geschwindigkeit, +10 Herzen', ohneVerzauberung[0].v);
pruefe('Und der Materialname kommt nicht mehr vor',
  ohneVerzauberung.every((v) => !v.v.includes('Golden Horse Armor')),
  ohneVerzauberung.map((v) => v.v).join(' | '));
pruefe('Die Stärke unterscheidet die Zeilen',
  ohneVerzauberung[0].v !== ohneVerzauberung[1].v && ohneVerzauberung[1].v.includes('+180%'),
  ohneVerzauberung.map((v) => v.v).join('  ≠  '));

// Die Gegenprobe, und sie ist der Grund für die Bedingung: Wo eine
// Verzauberungsliste steht, kommt der Effekt **nicht** dazu. Gemessen
// ohne diese Bedingung springen die Etiketten über 100 Zeichen von 141
// auf 382 — bei Rüstung und Werkzeug ist der Effekt bei jeder
// Ausführung derselbe und verdrängt nur die Verzauberungen, an denen
// man sie wirklich auseinanderhält.
const mitVerzauberung = rollerIndex({ 'minecraft:efficiency': 5 }, 60);
pruefe('Mit Verzauberungen bleibt es bei ihnen',
  mitVerzauberung[0].v === 'Effizienz V', mitVerzauberung[0].v);
pruefe('Und der Effekt bläht das Etikett nicht auf',
  !mitVerzauberung[0].v.includes('Geschwindigkeit'), mitVerzauberung[0].v);

// Der Klammerzusatz fällt im Etikett weg — im Text steht er weiter.
pruefe('Das Präfix und die Klammer sind aus dem Effekt raus',
  eigen.effekte({ lore: ['➥ Effekt: +60% Geschwindigkeit (Hände, Kopf)'] })[0] === '+60% Geschwindigkeit',
  eigen.effekte({ lore: ['➥ Effekt: +60% Geschwindigkeit (Hände, Kopf)'] })[0]);
pruefe('Auch eine Klammer, die kein Wirkungsort ist',
  eigen.effekte({ lore: ['➥ Effekt: 30 Minuten Haste II (Rechtsklick)'] })[0] === '30 Minuten Haste II',
  eigen.effekte({ lore: ['➥ Effekt: 30 Minuten Haste II (Rechtsklick)'] })[0]);

// ── 1i. Das Signaturdatum ist eine Seriennummer ─────────────────────
//
// "SweetDreamzzz Traumschwert" stand mit 31 Zeilen im Menü, 30 davon
// mit demselben Text. Der einzige Unterschied war der Tag, an dem
// signiert wurde — gleiches Schwert, gleiche Verzauberungen, alle um
// 111.111 gehandelt.
console.log('\n— Signiert von wem, nicht wann —');

const signiert = (...zeilen) =>
  eigen.baueIndex(
    {
      Traumschwert: zeilen.map((z, i) =>
        verkauf({
          preis: 111_111, zeit: vorTagen(2, 1 + i),
          name: 'Traumschwert', material: 'NETHERITE_SWORD',
          lore: ['', 'Traumschwert... aus Träumen werden', '', z],
        })
      ),
    },
    JETZT
  ).index.items['Traumschwert'];

const nurDatum = signiert(
  'Signiert von SweetDreamzzz am 09.07.2026',
  'Signiert von SweetDreamzzz am 11.07.2026',
  'Signiert von SweetDreamzzz am 12.07.2026'
);
pruefe('Verschiedene Tage sind dasselbe Schwert', nurDatum.length === 1, `${nurDatum.length}`);
pruefe('Und alle drei Verkäufe stehen darin', nurDatum[0]?.n === 3, `${nurDatum[0]?.n}`);

// Die Gegenprobe: Der Signierende sagt etwas über den Gegenstand und
// trennt weiter. Ein Fix, der auch den wegwirft, wäre keiner.
const verschiedeneHand = signiert(
  'Signiert von SweetDreamzzz am 09.07.2026',
  'Signiert von scusy am 09.07.2026'
);
pruefe('Verschiedene Signierende bleiben getrennt', verschiedeneHand.length === 2,
  `${verschiedeneHand.length}`);

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

  // Drei Schnipsel, weil die gebrauchten Funktionen in der Website
  // verstreut stehen: die Verzauberungsnamen im Anzeige-Abschnitt,
  // materialLesbar im Bild-Abschnitt, der Rest beim Verlauf.
  // Dieselbe Aufteilung benutzt DNV-Website/tests/index-test.mjs.
  const block =
    fenster[0] + '\n' +
    schnipsel('const verzauberungsNamen = {', '// Rückfallbild, wenn auch das Typ-Bild') +
    schnipsel('// NETHERITE_PICKAXE wird zu', '// Rückfallkette für Item-Bilder') +
    schnipsel('function salePricePerUnit(sale)', 'function getMonthlyAveragePerUnit');

  const kontext = { console, App: { auctionHistory: {} } };
  vm.createContext(kontext);
  vm.runInContext(
    block +
      '\nglobalThis.__api = { verlaufEntdoppeln, itemVariante, variantenLabel, ' +
      'salePricePerUnit, verzauberungsStempel, verzauberungenListe, ' +
      'winsorisierterSchnitt, loreSchluessel, beschreibungsZeilen, ' +
      'unterscheideEtiketten, effekte };',
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

  // Und die abgeleiteten Funktionen ebenfalls - nicht an einem Item,
  // sondern an allen. Ein Unterschied, der nur bei jedem tausendsten
  // Gegenstand auftritt, wäre an einer Stichprobe vorbeigegangen; genau
  // solche Fälle sind es aber, die hier Ärger machen (fehlende
  // Verzauberung, Lore als Zeichenkette statt Liste, Stufe 160).
  const alleItems = [];
  for (const liste of Object.values(echt)) {
    if (Array.isArray(liste)) for (const s of liste) if (s?.item) alleItems.push(s);
  }

  const zaehleAbweichung = (fn) => {
    let abweichend = 0;
    let ersteAbweichung = null;
    for (const s of alleItems) {
      const [a, b] = fn(s);
      if (a !== b) {
        abweichend++;
        if (!ersteAbweichung) ersteAbweichung = `${a}  ≠  ${b}`;
      }
    }
    return { abweichend, ersteAbweichung };
  };

  for (const [was, fn] of [
    ['Variantenkennung', (s) => [website.itemVariante(s.item), eigen.itemVariante(s.item)]],
    ['Verzauberungsstempel', (s) => [website.verzauberungsStempel(s.item), eigen.verzauberungsStempel(s.item)]],
    ['Verzauberungsliste', (s) => [
      website.verzauberungenListe(s.item).join('|'), eigen.verzauberungenListe(s.item).join('|'),
    ]],
    ['Variantenname', (s) => [website.variantenLabel(s.item), eigen.variantenLabel(s.item)]],
    // Der geglättete Schlüssel entscheidet, was als ein Item gilt, die
    // Beschreibungszeilen, wie zwei gleich benannte auseinandergehalten
    // werden. Laufen sie auseinander, legt die Seite andere Auktionen
    // zusammen als der Bot — und niemand merkt, welche der beiden stimmt.
    ['Lore-Schlüssel', (s) => [website.loreSchluessel(s.item), eigen.loreSchluessel(s.item)]],
    ['Beschreibungszeilen', (s) => [
      website.beschreibungsZeilen(s.item).join('|'), eigen.beschreibungsZeilen(s.item).join('|'),
    ]],
    ['Effekte', (s) => [website.effekte(s.item).join('|'), eigen.effekte(s.item).join('|')]],
    ['Variantenname ohne Verzauberungen', (s) => [
      website.variantenLabel(s.item, { mitVerzauberungen: false }),
      eigen.variantenLabel(s.item, { mitVerzauberungen: false }),
    ]],
    ['Stückpreis', (s) => [website.salePricePerUnit(s), eigen.salePricePerUnit(s)]],
  ]) {
    const { abweichend, ersteAbweichung } = zaehleAbweichung(fn);
    pruefe(
      `Gleiche ${was} bei allen ${alleItems.length} Verkäufen`,
      abweichend === 0,
      abweichend ? `${abweichend} abweichend, z.B. ${ersteAbweichung}` : ''
    );
  }

  // Der Schnitt bekommt keinen einzelnen Verkauf, sondern die Preisreihe
  // einer ganzen Variante — genau das, worauf er im Betrieb arbeitet.
  // Läuft er auf beiden Seiten auseinander, nennt der Bot andere Preise
  // als die Seite, und niemand merkt, welche der beiden stimmt.
  const reihenNachVariante = new Map();
  for (const [name, liste] of Object.entries(wB.verlauf)) {
    if (!Array.isArray(liste)) continue;
    for (const s of liste) {
      if (!s?.item) continue;
      const k = `${name}::${eigen.itemVariante(s.item)}`;
      if (!reihenNachVariante.has(k)) reihenNachVariante.set(k, []);
      reihenNachVariante.get(k).push(Math.round(eigen.salePricePerUnit(s)));
    }
  }

  let schnittAbweichend = 0;
  let ersterUnterschied = null;
  for (const [k, preise] of reihenNachVariante) {
    const a = website.winsorisierterSchnitt(preise);
    const b = eigen.winsorisierterSchnitt(preise);
    if (a !== b) {
      schnittAbweichend++;
      // Der Schlüssel trägt Lore-Zeilen und ein NUL als Trenner. Roh in
      // die Meldung gesetzt macht er sie mehrzeilig und die Ausgabe für
      // grep zur Binärdatei — genau dann, wenn man sie lesen will. Nur
      // fürs Anzeigen gekürzt; verglichen wird über den ganzen.
      if (!ersterUnterschied) {
        const lesbar = k.replace(/[\x00-\x1f]+/g, ' ').slice(0, 80);
        ersterUnterschied = `${lesbar}: Website ${a} ≠ Index ${b}`;
      }
    }
  }
  pruefe(`Gleicher Schnitt bei allen ${reihenNachVariante.size} Varianten`,
    schnittAbweichend === 0, ersterUnterschied ?? '');

  // Und dass dieser Abgleich überhaupt etwas prüft: Wären die Reihen
  // alle zu kurz für ein Perzentil, liefe er durch, ohne die Formel je
  // anzufassen.
  const langGenug = [...reihenNachVariante.values()].filter((p) => p.length >= 4).length;
  pruefe('Und genug davon sind lang genug für die Formel', langGenug > 100, `${langGenug}`);

  // Und die Etiketten müssen benutzbar bleiben: Discord nimmt im
  // Auswahlmenü 100 Zeichen, alles darüber schneidet /wert ab.
  const { index: echterIndex } = eigen.baueIndex(echt);
  let ueberlang = 0;
  let laengstes = '';
  for (const varianten of Object.values(echterIndex.items)) {
    for (const v of varianten) {
      if (v.v.length > 100) ueberlang++;
      if (v.v.length > laengstes.length) laengstes = v.v;
    }
  }
  pruefe('Fast alle Etiketten passen in 100 Zeichen', ueberlang < 150,
    `${ueberlang} zu lang, längstes ${laengstes.length} Zeichen`);
}

console.log(fehler ? `\n${fehler} Fehler.` : '\nAlle Prüfungen bestanden.');
process.exit(fehler ? 1 : 0);

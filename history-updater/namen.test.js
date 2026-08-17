// Prüft die Namensauflösung.
//
// Ohne Netz: Die Auflösung wird als Funktion hereingereicht, und die
// Ablage liegt in einer temporären Datei. Was hier geprüft wird, sind
// die Regeln, an denen es hängt, wenn niemand hinschaut — Häppchengröße,
// Reihenfolge, Wiederholung, Verhalten bei Ausfällen.
//
// Aufruf: node history-updater/namen.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  ergaenzeNamen,
  loeseAuf,
  offeneUuids,
  frisch,
  istBedrockUuid,
  HALTBAR_TAGE,
  NEUER_VERSUCH_TAGE,
} = require('./namen.js');

let fehler = 0;
function pruefe(text, bedingung, zusatz = '') {
  console.log(`${bedingung ? '  ok  ' : ' FEHL '} ${text}${zusatz ? '  → ' + zusatz : ''}`);
  if (!bedingung) fehler += 1;
}

const TAG = 24 * 60 * 60 * 1000;
const JETZT = Date.parse('2026-08-17T12:00:00Z');

const ablage = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'namen-')), 'namen.json');
const lies = () => JSON.parse(fs.readFileSync(ablage, 'utf8'));

/** [eingenommen, ausgegeben, verkauft, gewonnen] wie im Index. */
const konto = (ein, aus = 0) => [ein, aus, 1, 1];

// Eine Auflösung, die mitzählt und auf Wunsch scheitert.
function attrappe({ scheitert = new Set(), leer = new Set() } = {}) {
  const gefragt = [];
  return {
    gefragt,
    async holen(uuid) {
      gefragt.push(uuid);
      if (scheitert.has(uuid)) throw new Error('Dienst antwortet nicht');
      if (leer.has(uuid)) return null;
      return `Spieler_${uuid.slice(0, 4)}`;
    },
  };
}

const lauf = (spieler, attr, extra = {}) =>
  ergaenzeNamen(spieler, { holen: attr.holen, jetzt: JETZT, datei: ablage, pauseMs: 0, ...extra });

async function main() {
  // ── 1. Häppchen und Reihenfolge ───────────────────────────────────
  console.log('— Häppchen und Reihenfolge —');

  const viele = {};
  for (let i = 0; i < 10; i++) viele[`uuid-${i}`] = konto(i * 100);

  let a = attrappe();
  let { namen, bericht } = await lauf(viele, a, { jeLauf: 3 });

  pruefe('Nur das Häppchen wird gefragt', a.gefragt.length === 3, `${a.gefragt.length}`);
  pruefe(
    'Der größte Umsatz zuerst',
    a.gefragt.join(',') === 'uuid-9,uuid-8,uuid-7',
    a.gefragt.join(',')
  );
  pruefe('Drei Namen bekannt', bericht.neu === 3 && bericht.bekannt === 3, JSON.stringify(bericht));
  pruefe('Der Bericht kennt den ganzen Bestand', bericht.gesamt === 10, `${bericht.gesamt}`);
  pruefe('Zurück kommen nur die aufgelösten', Object.keys(namen).length === 3,
    Object.keys(namen).join(','));

  // ── 2. Was einmal da ist, wird nicht neu geholt ────────────────────
  console.log('\n— Nicht zweimal fragen —');

  a = attrappe();
  ({ bericht } = await lauf(viele, a, { jeLauf: 3 }));

  pruefe('Der nächste Lauf nimmt die nächsten drei',
    a.gefragt.join(',') === 'uuid-6,uuid-5,uuid-4', a.gefragt.join(','));
  pruefe('Und kennt jetzt sechs', bericht.bekannt === 6, `${bericht.bekannt}`);

  // Nach 30 Tagen wieder, vorher nicht.
  a = attrappe();
  await lauf(viele, a, { jeLauf: 20, jetzt: JETZT + (HALTBAR_TAGE - 1) * TAG });
  pruefe('Vor Ablauf bleiben die bekannten unangetastet',
    !a.gefragt.includes('uuid-9'), a.gefragt.join(','));

  a = attrappe();
  await lauf(viele, a, { jeLauf: 20, jetzt: JETZT + (HALTBAR_TAGE + 1) * TAG });
  pruefe('Nach 30 Tagen wird nachgefragt', a.gefragt.includes('uuid-9'), a.gefragt.join(','));

  // ── 3. Ausfälle bremsen den Lauf nicht ────────────────────────────
  console.log('\n— Ausfälle —');

  fs.rmSync(ablage, { force: true });

  const drei = { 'uuid-a': konto(300), 'uuid-b': konto(200), 'uuid-c': konto(100) };
  a = attrappe({ scheitert: new Set(['uuid-b']) });
  ({ namen, bericht } = await lauf(drei, a, { jeLauf: 10 }));

  pruefe('Es wird trotzdem weitergefragt', a.gefragt.length === 3, `${a.gefragt.length}`);
  pruefe('Die anderen beiden sind da', bericht.neu === 2 && bericht.leer === 1,
    JSON.stringify(bericht));
  pruefe('Der Gescheiterte steht nicht im Ergebnis', !('uuid-b' in namen),
    Object.keys(namen).join(','));
  pruefe('Aber mit Vermerk in der Ablage', lies()['uuid-b']?.n === null,
    JSON.stringify(lies()['uuid-b']));

  // Kein sofortiger zweiter Versuch, sonst blockiert er jedes Häppchen.
  a = attrappe();
  await lauf(drei, a, { jeLauf: 10, jetzt: JETZT + (NEUER_VERSUCH_TAGE - 1) * TAG });
  pruefe('Nicht sofort wieder versuchen', a.gefragt.length === 0, a.gefragt.join(','));

  a = attrappe();
  await lauf(drei, a, { jeLauf: 10, jetzt: JETZT + (NEUER_VERSUCH_TAGE + 1) * TAG });
  pruefe('Aber nach ein paar Tagen schon', a.gefragt.join(',') === 'uuid-b', a.gefragt.join(','));

  // Ein Dienst, der überhaupt nichts mehr auflöst, darf nichts löschen.
  const vorher = Object.keys((await lauf(drei, attrappe(), { jeLauf: 0 })).namen).length;
  const kaputt = attrappe({ scheitert: new Set(Object.keys(drei)) });
  const { namen: danach } = await lauf(drei, kaputt, {
    jeLauf: 10,
    jetzt: JETZT + (HALTBAR_TAGE + 1) * TAG,
  });
  pruefe('Ein Totalausfall wirft bekannte Namen nicht weg',
    Object.keys(danach).length === vorher, `${Object.keys(danach).length} statt ${vorher}`);

  // ── 3b. Das Zeitbudget ────────────────────────────────────────────
  console.log('\n— Zeitbudget —');

  // Der Fall, der den Updater stillstehen ließe: Ein Dienst antwortet
  // nicht mehr, jede Anfrage läuft in ihr Zeitlimit, und ein Lauf dauert
  // länger als der Abstand zum nächsten.
  fs.rmSync(ablage, { force: true });

  const zwanzig = {};
  for (let n = 0; n < 20; n++) zwanzig[`lahm-${n}`] = konto(1000 - n);

  let tick = 0;
  const langsam = attrappe();
  const { bericht: knapp } = await ergaenzeNamen(zwanzig, {
    holen: langsam.holen,
    jetzt: JETZT,
    datei: ablage,
    pauseMs: 0,
    jeLauf: 20,
    budgetMs: 30_000,
    uhr: () => (tick++) * 10_000, // jede Runde zehn Sekunden
  });

  pruefe('Der Lauf hört auf, bevor er den nächsten blockiert',
    knapp.versucht < 20, `${knapp.versucht} von 20`);
  pruefe('Und sagt, dass er abgebrochen hat', knapp.abgebrochen === true);
  pruefe('Der Rest ist vertagt, nicht verloren',
    knapp.versucht + knapp.offen === 20, `${knapp.versucht} + ${knapp.offen}`);
  pruefe('Was er geschafft hat, ist gespeichert',
    Object.keys(lies()).length === knapp.versucht, `${Object.keys(lies()).length}`);

  // Der nächste Lauf macht dort weiter, wo dieser aufgehört hat.
  const weiter = attrappe();
  await lauf(zwanzig, weiter, { jeLauf: 20 });
  pruefe('Der nächste Lauf nimmt nur noch die Übrigen',
    weiter.gefragt.length === knapp.offen, `${weiter.gefragt.length} statt ${knapp.offen}`);

  // ── 4. Kleinkram, der sonst nirgends auffällt ──────────────────────
  console.log('\n— Randfälle —');

  const leerErgebnis = await lauf({}, attrappe(), { jeLauf: 10 });
  pruefe('Ohne Spieler passiert nichts', leerErgebnis.bericht.versucht === 0,
    JSON.stringify(leerErgebnis.bericht));

  pruefe('Bedrock-UUIDs werden erkannt',
    istBedrockUuid('00000000-0000-0000-0009-01f5e2b3c4d5') && !istBedrockUuid('069a79f4-44e9-4726-a5be-fca90e38aaf5'));

  pruefe('Ein Eintrag ohne Zeitstempel gilt als überfällig',
    frisch({ n: 'X' }, JETZT) === false);

  pruefe('offeneUuids überspringt Frisches',
    offeneUuids({ x: konto(1) }, { x: { n: 'X', z: JETZT } }, JETZT, 10).length === 0);

  // ── 4b. Die Anfragen selbst ───────────────────────────────────────
  console.log('\n— Die Anfragen an die Dienste —');

  // Bis hierher war die Auflösung immer eine Attrappe. Was tatsächlich
  // angefragt wird, stand damit nie auf dem Prüfstand — und ein Tippfehler
  // in einer URL oder eine verrutschte Stelle in der XUID fiele erst auf,
  // wenn wochenlang niemand aufgelöst wird. Also fetch abfangen.
  const echterFetch = globalThis.fetch;
  let gerufen = [];
  const antworte = (koerper, ok = true) => {
    globalThis.fetch = async (url) => {
      gerufen.push(String(url));
      return { ok, status: ok ? 200 : 404, json: async () => koerper };
    };
  };

  const JAVA = '069a79f4-44e9-4726-a5be-fca90e38aaf5';

  gerufen = [];
  antworte({ success: true, data: { player: { username: 'Notch' } } });
  pruefe('Java: playerdb liefert den Namen', (await loeseAuf(JAVA)) === 'Notch');
  pruefe('Java: playerdb wird zuerst gefragt',
    gerufen[0] === `https://playerdb.co/api/player/minecraft/${JAVA}`, gerufen[0]);
  pruefe('Java: ein Dienst reicht', gerufen.length === 1, `${gerufen.length}`);

  // Fällt der erste aus, muss der zweite einspringen.
  gerufen = [];
  let ersterRuf = true;
  globalThis.fetch = async (url) => {
    gerufen.push(String(url));
    if (ersterRuf) {
      ersterRuf = false;
      return { ok: false, status: 500, json: async () => ({}) };
    }
    return { ok: true, status: 200, json: async () => ({ username: 'Notch' }) };
  };
  pruefe('Java: ashcon fängt den Ausfall auf', (await loeseAuf(JAVA)) === 'Notch');
  pruefe('Java: und zwar unter der richtigen Adresse',
    gerufen[1] === `https://api.ashcon.app/mojang/v2/user/${JAVA}`, gerufen[1]);

  // Bedrock: Die XUID steckt als Hexzahl in den letzten beiden Blöcken.
  // 0x000901fb840db809 = 2535454554306569. Die Zahl steht hier von Hand,
  // damit der Test nicht dieselbe Rechnung prüft, die er prüfen soll.
  gerufen = [];
  antworte({ gamertag: 'Steve' });
  const bedrockUuid = '00000000-0000-0000-0009-01fb840db809';
  const XUID = '2535454554306569';

  pruefe('Bedrock: Gamertag mit führendem Punkt',
    (await loeseAuf(bedrockUuid)) === '.Steve', String(await loeseAuf(bedrockUuid)));
  pruefe('Bedrock: XUID richtig aus der UUID gelesen',
    gerufen[0] === `https://api.geysermc.org/v2/xbox/gamertag/${XUID}`, gerufen[0]);
  pruefe('Bedrock: kein Java-Dienst wird belästigt',
    !gerufen.some((u) => u.includes('playerdb') || u.includes('ashcon')), gerufen.join(' '));

  // Und der Rückweg muss auf dieselbe UUID führen: Genau so rechnet der
  // Bot in spielerZuName(), wenn jemand einen Bedrock-Namen eintippt.
  // Gehen die beiden auseinander, findet /spieler den Händler nicht, den
  // der Index kennt — und niemand käme auf die Idee, warum.
  const zurueckHex = BigInt(XUID).toString(16).padStart(16, '0');
  pruefe('Bedrock: der Rückweg trifft dieselbe UUID',
    `00000000-0000-0000-${zurueckHex.slice(0, 4)}-${zurueckHex.slice(4)}` === bedrockUuid);

  gerufen = [];
  antworte({}, false);
  pruefe('Ein toter Dienst ergibt null, keinen Absturz', (await loeseAuf(JAVA)) === null);

  globalThis.fetch = echterFetch;

  // ── 5. Und so kommt es im Index an ────────────────────────────────
  console.log('\n— Im Index —');

  // Derselbe Handgriff wie in update-history.js. Steht hier, weil die
  // fünfte Stelle der Spielerzeile eine Absprache zwischen zwei Dateien
  // ist — und Absprachen ohne Prüfung halten nicht.
  fs.rmSync(ablage, { force: true });

  const { baueIndex } = require('./wert-index.js');
  const verkauf = {
    seller: 'uuid-a',
    highestBidder: 'uuid-c',
    finalPrice: 500,
    currentBid: 500,
    soldAt: new Date(JETZT - TAG).toISOString(),
    bids: { 'uuid-c': 500 },
    item: { material: 'STONE', displayName: 'Stein', amount: 1, lore: [] },
  };
  const { index } = baueIndex({ Stein: [verkauf] }, JETZT);

  const { namen: fuerIndex } = await lauf(index.spieler, attrappe(), { jeLauf: 10 });
  for (const [uuid, name] of Object.entries(fuerIndex)) {
    if (index.spieler[uuid]) index.spieler[uuid][4] = name;
  }

  pruefe('Die vier Zahlen bleiben, wo sie waren',
    index.spieler['uuid-a'].slice(0, 4).join(',') === '500,0,1,0',
    index.spieler['uuid-a'].slice(0, 4).join(','));
  pruefe('Der Name steht an fünfter Stelle',
    index.spieler['uuid-a'][4] === 'Spieler_uuid', String(index.spieler['uuid-a'][4]));
  pruefe('Beide Seiten bekommen einen',
    typeof index.spieler['uuid-c'][4] === 'string');
  pruefe('Keine zweite Namensliste in der Datei', index.namen === undefined);

  fs.rmSync(path.dirname(ablage), { recursive: true, force: true });

  console.log(fehler ? `\n${fehler} Fehler.` : '\nAlle Prüfungen bestanden.');
  process.exit(fehler ? 1 : 0);
}

main();

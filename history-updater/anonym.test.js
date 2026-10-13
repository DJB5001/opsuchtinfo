// Prüft, dass keine Spielerdaten ins Repo kommen (anonym.js).
//
// Der letzte Abschnitt lässt den ganzen Updater laufen, gegen eine
// nachgebaute API mit echten UUIDs, und sieht in jede geschriebene Datei.
//
// Aufruf: node history-updater/anonym.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const anonymisierung = require('./anonym.js');
const { itemVariante, variantenSchluessel, baueIndex } = require('./wert-index.js');
const strom = require('./strom.js');

let fehler = 0;
function pruefe(text, bedingung, zusatz = '') {
  console.log(`${bedingung ? '  ok  ' : ' FEHL '} ${text}${zusatz ? '  → ' + zusatz : ''}`);
  if (!bedingung) fehler += 1;
}

const SCHLUESSEL = 'test-schluessel-nur-fuer-diesen-lauf';
const VERKAEUFER = '11111111-0000-4000-8000-000000000001';
const BIETER = '22222222-0000-4000-8000-000000000002';
const BIETER2 = '33333333-0000-4000-8000-000000000003';
const GESPERRT_A = 'aaaaaaaa-1111-4222-8333-444444444444';
const GESPERRT_B = 'bbbbbbbb-1111-4222-8333-444444444444';
const GESPERRT_C = 'cccccccc-1111-4222-8333-444444444444'; // erst nachgeschlagen
const GESPERRT = `Sperrling:${GESPERRT_A},Zweitsperre:${GESPERRT_B},Ohne_Uuid`;

const auktion = (o = {}) => ({
  seller: o.seller ?? VERKAEUFER,
  startBid: 100,
  currentBid: 500,
  instantBuyPrice: null,
  endTime: o.endTime ?? '2026-10-13T12:00:00.000Z',
  bids: o.bids ?? { [BIETER]: 300, [BIETER2]: 500 },
  item: {
    material: 'NETHERITE_SWORD',
    displayName: o.name ?? 'Traumschwert',
    amount: 1,
    lore: o.lore ?? ['Ein Schwert', 'Signiert von SpielerA am 09.07.2026'],
    enchantments: {},
  },
});

async function main() {
  // ── 1. Ohne Schlüssel kein Lauf ─────────────────────────────────────
  console.log('— Schlüssel —');

  let geworfen = null;
  try { anonymisierung.erstelle({}); } catch (e) { geworfen = e; }
  pruefe('Ohne Schlüssel wirft er', /ANONYM_SCHLUESSEL/.test(geworfen?.message ?? ''), geworfen?.message);
  geworfen = null;
  try { anonymisierung.erstelle({ schluessel: 'kurz' }); } catch (e) { geworfen = e; }
  pruefe('Ein zu kurzer Schlüssel genauso', Boolean(geworfen));

  const anonym = anonymisierung.erstelle({ schluessel: SCHLUESSEL, gesperrt: GESPERRT });

  // ── 2. Kürzel statt UUIDs ───────────────────────────────────────────
  console.log('\n— Kürzel —');

  const k1 = anonym.kuerzel(VERKAEUFER);
  pruefe('Ein Kürzel hat zwölf Hexziffern', /^[0-9a-f]{12}$/.test(k1), k1);
  pruefe('Gleiche UUID, gleiches Kürzel — auch groß und ohne Bindestriche',
    anonym.kuerzel(VERKAEUFER.toUpperCase().replace(/-/g, '')) === k1);
  pruefe('Andere UUID, anderes Kürzel', anonym.kuerzel(BIETER) !== k1);
  pruefe('Anderer Schlüssel, anderes Kürzel',
    anonymisierung.erstelle({ schluessel: 'ein-ganz-anderer-schluessel' }).kuerzel(VERKAEUFER) !== k1);

  const a = anonym.auktion(auktion());
  pruefe('Verkäufer ist ein Kürzel', a.seller === k1, a.seller);
  pruefe('Bieter sind Kürzel, die Beträge bleiben',
    a.bids[anonym.kuerzel(BIETER)] === 300 && a.bids[anonym.kuerzel(BIETER2)] === 500,
    JSON.stringify(a.bids));
  pruefe('Keine UUID mehr in der Auktion', !anonymisierung.enthaeltUuid(a), JSON.stringify(a).slice(0, 80));
  pruefe('Das Original bleibt unangetastet', auktion().seller === VERKAEUFER);

  const mitKaeufer = anonym.auktion({ ...auktion(), highestBidder: BIETER2 });
  pruefe('Der Käufer wird ebenso zum Kürzel', mitKaeufer.highestBidder === anonym.kuerzel(BIETER2));

  // ── 3. Schwärzen, aber k aus der echten Lore ────────────────────────
  console.log('\n— Lore —');

  const roh = auktion();
  const kEcht = variantenSchluessel(itemVariante(roh.item));
  pruefe('k stammt aus der ungeschwärzten Lore', a.item.k === kEcht, `${a.item.k} / ${kEcht}`);
  pruefe('Die Signatur ist geschwärzt, das Datum bleibt',
    a.item.lore[1] === 'Signiert von *** am 09.07.2026', a.item.lore[1]);
  pruefe('Ein zweiter Durchgang lässt k stehen', anonym.item(a.item).k === kEcht);

  const zeilen = [
    ['Signiert von OPSUCHT am 01.09.2024', 'Signiert von OPSUCHT am 01.09.2024', 'Die Signatur des Servers bleibt'],
    ['♦ Signiert von Muster ♦', '♦ Signiert von *** ♦', 'Zierrat bleibt'],
    ['♦ Signiert von Muster am 01.01.2026 ♦', '♦ Signiert von *** am 01.01.2026 ♦', 'Zierrat und Datum bleiben'],
    ['Signiert von .Felix ist 12 am 03.03.2026', 'Signiert von *** am 03.03.2026', 'Bedrock-Namen mit Leerzeichen'],
    ['Signiert von Muster', 'Signiert von ***', 'Ohne Datum'],
    ['Inhaber: Muster', 'Inhaber: ***', 'Inhaber'],
    ['Bestimmt für Muster', 'Bestimmt für ***', 'Bestimmt für'],
    ['Seltenheit » Jackpot', 'Seltenheit » Jackpot', 'Andere Zeilen bleiben'],
  ];
  for (const [vorher, nachher, was] of zeilen) {
    const ist = anonymisierung.schwaerzeZeile(vorher);
    pruefe(`${was}: „${vorher}"`, ist === nachher, ist);
  }

  // ── 4. Gesperrte Spieler ────────────────────────────────────────────
  console.log('\n— Gesperrte —');

  pruefe('Ihre Auktionen fallen ganz weg', anonym.auktion(auktion({ seller: GESPERRT_A })) === null);
  pruefe('Auch in anderer Schreibweise der UUID',
    anonym.auktion(auktion({ seller: GESPERRT_B.toUpperCase() })) === null);

  const mitGesperrten = anonym.auktion(auktion({ bids: { [GESPERRT_A]: 900, [GESPERRT_B]: 700, [BIETER]: 300 } }));
  pruefe('Ihre Gebote stehen als „ausgeblendet", das höhere zählt',
    mitGesperrten.bids[anonymisierung.AUSGEBLENDET] === 900, JSON.stringify(mitGesperrten.bids));
  pruefe('Ihre UUID steht nirgends', !JSON.stringify(mitGesperrten).includes(GESPERRT_A.slice(0, 8)));

  const mitNamen = anonym.auktion(auktion({ name: 'Plüsch sperrling', lore: ['Für ZWEITSPERRE gebacken'] }));
  pruefe('Ihre Namen werden überall geschwärzt',
    mitNamen.item.displayName === 'Plüsch ***' && mitNamen.item.lore[0] === 'Für *** gebacken',
    `${mitNamen.item.displayName} / ${mitNamen.item.lore[0]}`);

  // Ohne_Uuid hat keine UUID: Der Updater schlägt nach. Die erste Quelle
  // streikt, die zweite kennt ihn.
  const gefragt = [];
  const holen = async (url) => {
    gefragt.push(url);
    if (url.includes('playerdb')) return { ok: false, status: 503, json: async () => null };
    return { ok: true, status: 200, json: async () => ({ uuid: GESPERRT_C }) };
  };
  pruefe('Vorher geht seine Auktion noch durch', anonym.auktion(auktion({ seller: GESPERRT_C })) !== null);
  const ergebnis = await anonym.loeseAuf(holen);
  pruefe('Nachgeschlagen, auch über die zweite Quelle', ergebnis.aufgeloest === 1 && ergebnis.offen === 0,
    JSON.stringify(ergebnis));
  pruefe('Danach fällt sie weg', anonym.auktion(auktion({ seller: GESPERRT_C })) === null);
  pruefe('Der Bericht enthält nur Zahlen', !JSON.stringify(ergebnis).includes('Ohne'));

  // ── 5. Die Entdopplung arbeitet mit Kürzeln wie mit UUIDs ───────────
  console.log('\n— Entdopplung —');

  // Dieselbe Auktion dreimal aufgenommen, weil sie sich verlängert hat.
  const t0 = Date.parse('2026-10-13T10:00:00Z');
  const verkauf = (minuten, bids) => ({
    ...auktion({ bids }),
    finalPrice: Math.max(...Object.values(bids)),
    soldAt: new Date(t0 + minuten * 60000).toISOString(),
  });
  const kette = [verkauf(0, { [BIETER]: 300, [BIETER2]: 400 }), verkauf(4, { [BIETER]: 300, [BIETER2]: 450 }),
    verkauf(8, { [BIETER]: 500, [BIETER2]: 450 })];
  const mitUuids = baueIndex({ Traumschwert: kette }, t0 + 3600000);
  const mitKuerzeln = baueIndex({ Traumschwert: kette.map(anonym.auktion) }, t0 + 3600000);
  pruefe('Gleich viele Zwischenstände erkannt', mitKuerzeln.entdoppelt === mitUuids.entdoppelt &&
    mitKuerzeln.entdoppelt === 2, `${mitKuerzeln.entdoppelt} / ${mitUuids.entdoppelt}`);
  pruefe('Und derselbe Wert', mitKuerzeln.index.items.Traumschwert[0].d === mitUuids.index.items.Traumschwert[0].d);
  pruefe('Mit demselben k für die Mod', mitKuerzeln.index.items.Traumschwert[0].k === kEcht);

  // ── 6. Der Strom ────────────────────────────────────────────────────
  console.log('\n— Strom —');

  const kodieren = new TextEncoder();
  const ereignis = (daten) => `id: 1\nevent: auction.sold\ndata: ${JSON.stringify(daten)}\n\n`;
  const stuecke = [ereignis(auktion()), ereignis(auktion({ seller: GESPERRT_A, endTime: '2026-10-13T13:00:00.000Z' }))];
  let i = 0;
  const bericht = await strom.holeRueckstand({
    holen: async () => ({
      ok: true,
      status: 200,
      body: { getReader: () => ({ read: async () => (i < stuecke.length
        ? { done: false, value: kodieren.encode(stuecke[i++]) } : { done: true }) }) },
    }),
    schluesselVon: (x) => `${x.seller}_${x.item.material}_${x.endTime}`,
    aufbereiten: anonym.auktion,
    log: { warn() {} },
  });
  const v = bericht.verkaeufe[0];
  pruefe('Ein Verkauf aus dem Strom', bericht.verkaeufe.length === 1, `${bericht.verkaeufe.length}`);
  pruefe('Seine Kennung entsteht aus dem Kürzel', v?.id?.startsWith(k1), v?.id);
  pruefe('Keine UUID im Verkauf aus dem Strom', !anonymisierung.enthaeltUuid(v));
  pruefe('Der Gesperrte wurde übergangen', bericht.verworfen.ausgeschlossen === 1, JSON.stringify(bericht.verworfen));

  // ── 7. Der ganze Updater ────────────────────────────────────────────
  console.log('\n— Ein ganzer Lauf —');

  const ordner = fs.mkdtempSync(path.join(os.tmpdir(), 'anonym-test-'));
  try {
    const updater = path.join(ordner, 'history-updater');
    fs.mkdirSync(updater);
    for (const datei of ['update-history.js', 'wert-index.js', 'strom.js', 'anonym.js']) {
      fs.copyFileSync(path.join(__dirname, datei), path.join(updater, datei));
    }

    // Relativ zu jetzt: Der Updater wirft Verkäufe über 90 Tage weg, und
    // ein festes Datum ließe diesen Test eines Tages von selbst scheitern.
    const stunden = (h) => new Date(Date.now() + h * 3600000).toISOString();

    // Der vorige Lauf hat eine Auktion gemerkt, die jetzt fehlt: ein Verkauf.
    const ende = stunden(-1);
    const vorher = anonym.auktion(auktion({ endTime: ende }));
    const schluessel = `${vorher.seller}_NETHERITE_SWORD_${ende}`.replace(/[.#$[\]]/g, '-');
    fs.writeFileSync(path.join(updater, 'state.json'), JSON.stringify({ auctions: { [schluessel]: vorher } }));
    fs.writeFileSync(path.join(ordner, 'auction-history.json'), '{}');

    // Die nachgebaute API: echte UUIDs, wie sie vom Server kommen.
    const attrappe = path.join(ordner, 'attrappe.js');
    fs.writeFileSync(attrappe, `
      const laufend = ${JSON.stringify([
        auktion({ endTime: stunden(48) }),
        auktion({ seller: GESPERRT_A, endTime: stunden(72) }),
      ])};
      globalThis.fetch = async (url) => {
        url = String(url);
        if (url.includes('/auctions/active')) return { ok: true, status: 200, json: async () => laufend };
        return { ok: false, status: 404, json: async () => ({}) };
      };`);

    const lauf = (env) => {
      try {
        const aus = execFileSync(process.execPath, ['--require', attrappe, path.join(updater, 'update-history.js')], {
          env: { ...process.env, STROM: 'aus', ANONYM_SCHLUESSEL: '', GESPERRT: '', ...env },
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        return { code: 0, aus };
      } catch (e) {
        return { code: e.status, aus: `${e.stdout}${e.stderr}` };
      }
    };

    const vorherState = fs.readFileSync(path.join(updater, 'state.json'), 'utf8');
    const ohne = lauf({});
    pruefe('Ohne Schlüssel endet der Lauf mit Fehler', ohne.code !== 0, `Code ${ohne.code}`);
    pruefe('… und schreibt nichts',
      fs.readFileSync(path.join(updater, 'state.json'), 'utf8') === vorherState &&
        !fs.existsSync(path.join(ordner, 'wert-index.json')));

    const mit = lauf({ ANONYM_SCHLUESSEL: SCHLUESSEL, GESPERRT });
    pruefe('Mit Schlüssel läuft er durch', mit.code === 0, mit.aus.split('\n').slice(-3).join(' | '));

    const geschrieben = ['auction-history.json', 'wert-index.json', 'history-updater/state.json']
      .map((d) => [d, fs.existsSync(path.join(ordner, d)) ? fs.readFileSync(path.join(ordner, d), 'utf8') : '']);
    for (const [datei, inhalt] of geschrieben) {
      pruefe(`${datei}: geschrieben, ohne eine UUID`, inhalt.length > 2 && !anonymisierung.enthaeltUuid(inhalt),
        `${inhalt.length} Zeichen`);
    }
    const verlauf = JSON.parse(geschrieben[0][1] || '{}');
    pruefe('Der Verkauf ist archiviert', (verlauf.Traumschwert ?? []).length === 1);
    pruefe('Mit geschwärzter Signatur und echtem k',
      verlauf.Traumschwert?.[0]?.item?.lore?.[1] === 'Signiert von *** am 09.07.2026' &&
        verlauf.Traumschwert?.[0]?.item?.k === kEcht);
    const state = JSON.parse(geschrieben[2][1] || '{}');
    pruefe('Die Auktion des Gesperrten wurde nicht gemerkt', Object.keys(state.auctions ?? {}).length === 1,
      `${Object.keys(state.auctions ?? {}).length}`);
    pruefe('Das Protokoll nennt keinen Namen', !/Sperrling|Zweitsperre|Ohne_Uuid/i.test(mit.aus));

    // Die letzte Sicherung: Ein alter Stand von vor der Umstellung, noch
    // mit UUID. Wird die Auktion daraus als Verkauf archiviert, stünde die
    // UUID im Verlauf — der Lauf muss abbrechen, statt das zu schreiben.
    const alt = { ...auktion({ endTime: stunden(-2) }) };
    const altSchluessel = `${VERKAEUFER}_NETHERITE_SWORD_${alt.endTime}`.replace(/[.#$[\]]/g, '-');
    fs.writeFileSync(path.join(updater, 'state.json'), JSON.stringify({ auctions: { [altSchluessel]: alt } }));
    const verlaufVorher = fs.readFileSync(path.join(ordner, 'auction-history.json'), 'utf8');
    const mitAltlast = lauf({ ANONYM_SCHLUESSEL: SCHLUESSEL, GESPERRT });
    pruefe('Mit einer UUID im alten Stand bricht der Lauf ab', mitAltlast.code !== 0, `Code ${mitAltlast.code}`);
    pruefe('… und der Verlauf bleibt ohne UUID',
      fs.readFileSync(path.join(ordner, 'auction-history.json'), 'utf8') === verlaufVorher);
    pruefe('Die Meldung nennt die Datei, nicht die UUID',
      /enthielte eine Spieler-UUID/.test(mitAltlast.aus) && !mitAltlast.aus.includes(VERKAEUFER),
      mitAltlast.aus.split('\n').find((z) => /enthielte/.test(z)) ?? '');
  } finally {
    fs.rmSync(ordner, { recursive: true, force: true });
  }

  console.log(fehler ? `\n${fehler} Fehler.` : '\nAlle Prüfungen bestanden.');
  process.exit(fehler ? 1 : 0);
}

main();

// Prüft den Ereignisstrom des Auktionshauses.
//
// Zwei Teile, und der zweite ist der wichtigere.
//
// Der erste prüft strom.js für sich: das Zerlegen des Drahtformats, das
// Bauen eines Verkaufs aus einem Ereignis, das Verbinden und Auflegen.
//
// Der zweite lässt den **echten** update-history.js in einem
// Sandkasten laufen, mit einem gefälschten Auktionshaus davor. Nur so
// ist zu sehen, worauf es ankommt: dass ein Verkauf aus dem Strom im
// Verlauf landet, dass der Vergleich ihn nicht ein zweites Mal
// archiviert, und dass der Beobachten-Modus wirklich nichts schreibt.
// Am Verlauf hängen /wert, die Website und die Mod — dort etwas
// Doppeltes oder Halbes hineinzuschreiben wäre der teuerste Fehler in
// diesem Repo.
//
// Aufruf: node history-updater/strom.test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const strom = require('./strom.js');

let fehler = 0;
function pruefe(text, bedingung, zusatz = '') {
  console.log(`${bedingung ? '  ok  ' : ' FEHL '} ${text}${zusatz ? '  → ' + zusatz : ''}`);
  if (!bedingung) fehler += 1;
}

/** Derselbe Schlüssel wie im Updater. */
const auctionKey = (a) => {
  if (a.id) return String(a.id);
  const mat = (a.item && a.item.material) || '';
  return `${a.seller}_${mat}_${a.endTime}`.replace(/[.#$[\]]/g, '-');
};

// Der Rumpf liegt in einer Funktion, weil die Datei CommonJS ist:
// require() und await auf oberster Ebene schliessen sich aus.
async function main() {
  // ── 1. Das Drahtformat ──────────────────────────────────────────────
  //
  // Die Ränder sind der Punkt: Ein Schub aus dem Netz endet mitten in
  // einer Zeile, und ein \r am Schubende kann der Anfang eines \r\n im
  // nächsten sein. Wird das falsch gemacht, geht genau die Zeile
  // verloren, an der es passiert — selten und ohne Meldung.
  console.log('— Wie ein Ereignis gelesen wird —');

  function sammle() {
    const raus = [];
    const z = strom.macheZerleger((e) => raus.push(e));
    return { z, raus };
  }

  {
    const { z, raus } = sammle();
    z.schub('id: 5\nevent: auction.sold\ndata: {"a":1}\n\n');
    pruefe('Art, Daten und Kennung',
      raus.length === 1 && raus[0].art === 'auction.sold' && raus[0].daten === '{"a":1}' &&
        raus[0].kennung === '5',
      JSON.stringify(raus));
  }

  const nachricht = 'id: 42\nevent: auction.sold\ndata: {"item":{"material":"DIAMOND"}}\n\n';
  for (const breite of [1, 2, 5, 17, 9999]) {
    const { z, raus } = sammle();
    for (let i = 0; i < nachricht.length; i += breite) z.schub(nachricht.slice(i, i + breite));
    pruefe(`Schübe von ${breite} Zeichen ergeben dasselbe Ereignis`,
      raus.length === 1 && raus[0].kennung === '42' &&
        raus[0].daten === '{"item":{"material":"DIAMOND"}}',
      JSON.stringify(raus.length));
  }

  {
    const { z, raus } = sammle();
    z.schub('data: a\r');
    z.schub('\ndata: b\r\n\r\n');
    pruefe('Ein \\r am Schubende und \\n im nächsten sind ein Umbruch',
      raus.length === 1 && raus[0].daten === 'a\nb', JSON.stringify(raus));
  }

  {
    const { z, raus } = sammle();
    z.schub(': Herzschlag\n\n');
    z.schub('data: x\n\n');
    pruefe('Kommentarzeilen sind keine Ereignisse', raus.length === 1, `${raus.length}`);
  }

  {
    const { z, raus } = sammle();
    z.schub('id: 7\ndata: eins\n\n');
    z.schub('data: zwei\n\n');
    pruefe('Die Kennung überlebt das Ereignis', raus[1]?.kennung === '7', `${raus[1]?.kennung}`);
  }

  {
    const { z, raus } = sammle();
    z.schub('event: auction.sold\ndata: {"halb":');
    z.ende();
    pruefe('Ein abgeschnittenes Ereignis wird verworfen, nicht halb geliefert',
      raus.length === 0, JSON.stringify(raus));
  }

  // ── 2. Ein Verkauf aus einem Ereignis ───────────────────────────────
  console.log('\n— Was aus einem Ereignis wird —');

  const auktion = {
    id: 'a1', seller: 'uuid-v', startBid: 1000, currentBid: 5000, instantBuyPrice: 9000,
    endTime: new Date(Date.now() - 60_000).toISOString(),
    bids: { 'uuid-k1': 3000, 'uuid-k2': 5000 },
    item: { material: 'DIAMOND', displayName: 'Prüfstück', amount: 1, lore: [], enchantments: {} },
  };

  {
    const { verkauf } = strom.verkaufAus(auktion, 'auction.sold', null, auctionKey);
    pruefe('Ersteigert nimmt das höchste Gebot', verkauf?.finalPrice === 5000, `${verkauf?.finalPrice}`);
    pruefe('Und den, der es abgegeben hat', verkauf?.highestBidder === 'uuid-k2', verkauf?.highestBidder);
    pruefe('Die Verkaufsart steht fest, statt geraten zu sein',
      verkauf?.saleType === 'auction', verkauf?.saleType);
    pruefe('Die Form ist die des Verlaufs',
      ['id', 'seller', 'highestBidder', 'startBid', 'currentBid', 'finalPrice', 'instantBuyPrice',
        'saleType', 'endTime', 'soldAt', 'sold', 'bids', 'item'].every((f) => f in verkauf),
      Object.keys(verkauf).join(', '));
  }

  {
    const { verkauf } = strom.verkaufAus(auktion, 'auction.instant_bought', null, auctionKey);
    pruefe('Sofortkauf nimmt den Sofortkaufpreis', verkauf?.finalPrice === 9000, `${verkauf?.finalPrice}`);
  }

  {
    const damals = Date.now() - 6 * 60_000;
    const { verkauf } = strom.verkaufAus(auktion, 'auction.sold', damals, auctionKey);
    pruefe('Der Zeitpunkt aus dem Ereignis zählt',
      Date.parse(verkauf.soldAt) === Math.floor(damals / 1000) * 1000 ||
        Math.abs(Date.parse(verkauf.soldAt) - damals) < 1000,
      verkauf.soldAt);
  }

  // Was nicht schlüssig ist, wird verworfen — lieber ein Verkauf
  // weniger als ein falscher im Verlauf. Der Vergleich hat später noch
  // seine Gelegenheit.
  const verwirft = (was, art = 'auction.sold') => strom.verkaufAus(was, art, null, auctionKey).grund;
  pruefe('Eine abgebrochene Auktion ist kein Verkauf',
    verwirft(auktion, 'auction.cancelled') === 'keine Verkaufsart', verwirft(auktion, 'auction.cancelled'));
  pruefe('Eine abgelaufene auch nicht',
    verwirft(auktion, 'auction.expired') === 'keine Verkaufsart');
  pruefe('Ohne Item kein Verkauf', verwirft({ ...auktion, item: null }) === 'kein Item');
  pruefe('Ohne Material kein Verkauf',
    verwirft({ ...auktion, item: { displayName: 'x' } }) === 'kein Item');
  pruefe('Ohne Verkäufer kein Verkauf', verwirft({ ...auktion, seller: null }) === 'kein Verkäufer');
  pruefe('Ohne Preis kein Verkauf',
    verwirft({ ...auktion, bids: {}, currentBid: 0, startBid: 0, instantBuyPrice: null }) === 'kein Preis');

  pruefe('Die Auktion wird auch eingepackt gefunden',
    strom.auktionAus(JSON.stringify({ auction: auktion }))?.id === 'a1');
  pruefe('Kaputtes JSON ergibt null', strom.auktionAus('{nicht json') === null);
  pruefe('Etwas ohne Item ergibt null', strom.auktionAus('{"id":"a1"}') === null);

  // ── 3. Verbinden und wieder auflegen ────────────────────────────────
  console.log('\n— Die Verbindung —');

  /** Eine Antwort, deren Rumpf die Schübe liefert und dann offen bleibt. */
  function antwortMit(stuecke, { status = 200, offenHalten = true, taub = false, signal } = {}) {
    const kodieren = new TextEncoder();
    let i = 0;
    return {
      ok: status >= 200 && status < 300,
      status,
      body: {
        getReader: () => ({
          read: () => {
            if (i < stuecke.length) {
              return Promise.resolve({ done: false, value: kodieren.encode(stuecke[i++]) });
            }
            if (!offenHalten) return Promise.resolve({ done: true, value: undefined });
            if (taub || !signal) return new Promise(() => {});
            return new Promise((_, ab) =>
              signal.addEventListener('abort', () => ab(new Error('abgebrochen')), { once: true }));
          },
        }),
      },
    };
  }

  const verkaufsEreignis = (id, art = 'auction.sold') =>
    `id: ev-${id}\nevent: ${art}\ndata: ${JSON.stringify({ ...auktion, id })}\n\n`;

  {
    const bericht = await strom.holeRueckstand({
      holen: async (url, opt) => antwortMit([verkaufsEreignis('s1'), verkaufsEreignis('s2')], { signal: opt.signal }),
      schluesselVon: auctionKey,
      stilleMs: 60,
      hoechstensMs: 2000,
    });
    pruefe('Zwei Verkäufe kommen an', bericht.verkaeufe.length === 2,
      bericht.verkaeufe.map((v) => v.id).join(', '));
    pruefe('Und die letzte Kennung wird gemerkt', bericht.kennung === 'ev-s2', `${bericht.kennung}`);
    pruefe('Nach der Stille wird aufgelegt', bericht.dauerMs < 1500, `${bericht.dauerMs} ms`);
  }

  {
    // Der Anschlusspunkt muss mitgehen, sonst fehlt beim nächsten Lauf
    // genau das, was seit diesem passiert ist.
    let gesehen = null;
    await strom.holeRueckstand({
      kennung: 'ev-vorher',
      holen: async (url, opt) => { gesehen = opt.headers; return antwortMit([], { offenHalten: false }); },
      schluesselVon: auctionKey,
      stilleMs: 50,
    });
    pruefe('Last-Event-ID geht mit', gesehen?.['Last-Event-ID'] === 'ev-vorher',
      JSON.stringify(gesehen?.['Last-Event-ID']));
    pruefe('Und der Strom meldet sich als Ereignisstrom an',
      gesehen?.Accept === 'text/event-stream', gesehen?.Accept);
  }

  {
    const bericht = await strom.holeRueckstand({
      holen: async (url, opt) =>
        antwortMit([`event: stream.reset\ndata: {}\n\n`, verkaufsEreignis('s3')], { signal: opt.signal }),
      schluesselVon: auctionKey,
      stilleMs: 60,
    });
    pruefe('stream.reset wird gemeldet', bericht.zurueckgesetzt === true);
    pruefe('Und was danach kommt, zählt trotzdem', bericht.verkaeufe.length === 1,
      `${bericht.verkaeufe.length}`);
  }

  {
    const bericht = await strom.holeRueckstand({
      holen: async () => { throw new Error('ECONNREFUSED'); },
      schluesselVon: auctionKey,
    });
    pruefe('Ein toter Strom wirft nicht, er berichtet',
      bericht.fehler === 'ECONNREFUSED' && bericht.verkaeufe.length === 0, `${bericht.fehler}`);
  }

  {
    const bericht = await strom.holeRueckstand({
      holen: async () => antwortMit([], { status: 503, offenHalten: false }),
      schluesselVon: auctionKey,
    });
    pruefe('Eine abweisende API auch', bericht.fehler === 'HTTP 503', `${bericht.fehler}`);
  }

  {
    // Ein Rumpf, der den Abbruch ignoriert, darf den Lauf nicht in die
    // Zeitgrenze der Action treiben.
    const begonnen = Date.now();
    const bericht = await strom.holeRueckstand({
      holen: async () => antwortMit([verkaufsEreignis('s4')], { taub: true }),
      schluesselVon: auctionKey,
      stilleMs: 80,
      hoechstensMs: 2000,
    });
    const gedauert = Date.now() - begonnen;
    pruefe('Ein tauber Rumpf hält den Lauf nicht fest', gedauert < 1000, `${gedauert} ms`);
    pruefe('Und was vorher kam, ist trotzdem da', bericht.verkaeufe.length === 1);
  }

  {
    const bericht = await strom.holeRueckstand({
      holen: async (url, opt) =>
        antwortMit([
          `event: auction.sold\ndata: {kaputt\n\n`,
          `event: auction.sold\ndata: ${JSON.stringify({ ...auktion, id: 'ohne', seller: null })}\n\n`,
        ], { signal: opt.signal }),
      schluesselVon: auctionKey,
      stilleMs: 60,
    });
    pruefe('Unlesbares wird gezählt, nicht archiviert',
      bericht.verkaeufe.length === 0 && bericht.verworfen.unlesbar === 1 &&
        bericht.verworfen['kein Verkäufer'] === 1,
      JSON.stringify(bericht.verworfen));
  }

  // ── 4. Der echte Updater, im Sandkasten ─────────────────────────────
  //
  // Hier läuft update-history.js selbst, mit einem gefälschten
  // Auktionshaus davor. Alles darüber prüft Bausteine; das hier prüft,
  // was tatsächlich in auction-history.json landet.
  console.log('\n— Der ganze Lauf —');

  const HIER = __dirname;

  /**
   * Einen Lauf in einem eigenen Verzeichnis durchführen.
   *
   * Kopiert wird der echte Code; gefälscht wird nur das Netz, über ein
   * vorgeladenes Modul, das globalThis.fetch ersetzt. Würde hier eine
   * eigene, vereinfachte Fassung des Updaters stehen, prüfte der Test
   * seine eigene Attrappe.
   */
  function laufe({ ereignisse = [], aktiv = [], verlauf = {}, zustand = null, modus = 'an' }) {
    const kiste = fs.mkdtempSync(path.join(os.tmpdir(), 'strom-lauf-'));
    const unter = path.join(kiste, 'history-updater');
    fs.mkdirSync(unter);
    for (const datei of ['update-history.js', 'strom.js', 'wert-index.js', 'namen.js']) {
      fs.copyFileSync(path.join(HIER, datei), path.join(unter, datei));
    }
    fs.writeFileSync(path.join(kiste, 'auction-history.json'), JSON.stringify(verlauf));
    fs.writeFileSync(path.join(unter, 'namen.json'), '{}');
    if (zustand) fs.writeFileSync(path.join(unter, 'state.json'), JSON.stringify(zustand));

    const netz = `
      const stromText = ${JSON.stringify(ereignisse.join(''))};
      const aktiv = ${JSON.stringify(aktiv)};
      globalThis.fetch = async (url) => {
        const u = String(url);
        if (u.includes('/auctions/stream')) {
          const roh = new TextEncoder().encode(stromText);
          let raus = false;
          return { ok: true, status: 200, body: { getReader: () => ({
            read: async () => {
              if (raus) return new Promise(() => {});   // offen und still
              raus = true;
              return { done: false, value: roh };
            },
          }) } };
        }
        if (u.includes('/auctions/active')) {
          return { ok: true, status: 200, json: async () => aktiv };
        }
        throw new Error('nicht erreichbar: ' + u);
      };
    `;
    const netzDatei = path.join(kiste, 'netz.js');
    fs.writeFileSync(netzDatei, netz);

    const ausgabe = execFileSync(
      process.execPath,
      ['--require', netzDatei, path.join(unter, 'update-history.js')],
      { encoding: 'utf8', env: { ...process.env, STROM: modus }, timeout: 60_000 }
    );

    return {
      ausgabe,
      verlauf: JSON.parse(fs.readFileSync(path.join(kiste, 'auction-history.json'), 'utf8')),
      zustand: JSON.parse(fs.readFileSync(path.join(unter, 'state.json'), 'utf8')),
      kiste,
    };
  }

  /** Alle Verkäufe eines Laufs, flach. */
  const alleVerkaeufe = (verlauf) => Object.values(verlauf).flat();

  // Der Fall, um den es geht: eine Auktion, die eingestellt *und*
  // verkauft wurde, ohne je in einer Momentaufnahme zu stehen. Für den
  // Vergleich hat es sie nie gegeben.
  {
    const schnell = { ...auktion, id: 'schnell-1' };
    const lauf = laufe({
      ereignisse: [`id: e1\nevent: auction.instant_bought\ndata: ${JSON.stringify(schnell)}\n\n`],
      aktiv: [],
      zustand: { auctions: {} },
    });
    const verkaeufe = alleVerkaeufe(lauf.verlauf);
    pruefe('Ein Verkauf, den der Vergleich nie gesehen hätte, wird archiviert',
      verkaeufe.length === 1 && verkaeufe[0].id === 'schnell-1',
      verkaeufe.map((v) => v.id).join(', '));
    pruefe('Mit der Verkaufsart aus dem Ereignis',
      verkaeufe[0]?.saleType === 'instant', verkaeufe[0]?.saleType);
    pruefe('Und dem Sofortkaufpreis', verkaeufe[0]?.finalPrice === 9000, `${verkaeufe[0]?.finalPrice}`);
    pruefe('Der Anschlusspunkt steht im Zustand', lauf.zustand.stromKennung === 'e1',
      `${lauf.zustand.stromKennung}`);
  }

  // Und der Kern: Sehen ihn beide, landet er trotzdem nur einmal — mit
  // den Zahlen des Stroms, weil der vorher dran ist.
  {
    const beide = { ...auktion, id: 'beide-1', currentBid: 5000 };
    // So, wie der Vergleich sie zuletzt gesehen hat: mit einem älteren,
    // niedrigeren Gebot. Genau der Fall, in dem er zu wenig meldet.
    const alt = { ...beide, currentBid: 2000, bids: { 'uuid-k1': 2000 } };
    const lauf = laufe({
      ereignisse: [`id: e2\nevent: auction.sold\ndata: ${JSON.stringify(beide)}\n\n`],
      aktiv: [],
      zustand: { auctions: { 'beide-1': alt } },
    });
    const verkaeufe = alleVerkaeufe(lauf.verlauf);
    pruefe('Sehen beide denselben Verkauf, steht er einmal im Verlauf',
      verkaeufe.length === 1, `${verkaeufe.length}× ${verkaeufe.map((v) => v.id).join(', ')}`);
    pruefe('Und zwar mit dem Preis aus dem Strom, nicht dem letzten gesehenen Gebot',
      verkaeufe[0]?.finalPrice === 5000, `${verkaeufe[0]?.finalPrice} statt 2000`);
    pruefe('Der Bericht zeigt die Abweichung',
      /Preis abweichend bei 1/.test(lauf.ausgabe), lauf.ausgabe.split('\n').at(-2)?.slice(0, 160));
  }

  // Gegenprobe: Ohne Strom findet der Vergleich denselben Verkauf wie
  // immer — nur eben mit der schlechteren Zahl.
  {
    const alt = { ...auktion, id: 'nur-vergleich', currentBid: 2000, bids: { 'uuid-k1': 2000 } };
    const lauf = laufe({ ereignisse: [], aktiv: [], zustand: { auctions: { 'nur-vergleich': alt } }, modus: 'aus' });
    const verkaeufe = alleVerkaeufe(lauf.verlauf);
    pruefe('Gegenprobe: Ohne Strom arbeitet der Vergleich wie bisher',
      verkaeufe.length === 1 && verkaeufe[0].finalPrice === 2000,
      `${verkaeufe.length}× zu ${verkaeufe[0]?.finalPrice}`);
    pruefe('Und der Bericht sagt, dass der Strom aus ist',
      /Strom: abgeschaltet/.test(lauf.ausgabe));
  }

  // Beobachten heißt beobachten: rechnen, berichten, nichts schreiben.
  {
    const schnell = { ...auktion, id: 'beobachtet-1' };
    const lauf = laufe({
      ereignisse: [`id: e3\nevent: auction.sold\ndata: ${JSON.stringify(schnell)}\n\n`],
      aktiv: [],
      zustand: { auctions: {} },
      modus: 'beobachten',
    });
    pruefe('Im Beobachten-Modus bleibt der Verlauf unberührt',
      alleVerkaeufe(lauf.verlauf).length === 0, JSON.stringify(Object.keys(lauf.verlauf)));
    pruefe('Der Bericht nennt trotzdem, was es gewesen wäre',
      /1 Verkäufe erkannt/.test(lauf.ausgabe) && /Geschrieben wurde nichts/.test(lauf.ausgabe),
      lauf.ausgabe.split('\n').at(-2)?.slice(0, 160));
    pruefe('Der Anschlusspunkt wird auch beim Beobachten gemerkt',
      lauf.zustand.stromKennung === 'e3', `${lauf.zustand.stromKennung}`);
  }

  // Unsinn aus dem Strom darf nicht in den Verlauf.
  {
    const lauf = laufe({
      ereignisse: [
        `id: e4\nevent: auction.sold\ndata: {kaputt\n\n`,
        `id: e5\nevent: auction.sold\ndata: ${JSON.stringify({ ...auktion, id: 'ohne-preis', bids: {}, currentBid: 0, startBid: 0, instantBuyPrice: null })}\n\n`,
        `id: e6\nevent: auction.cancelled\ndata: ${JSON.stringify({ ...auktion, id: 'abgebrochen' })}\n\n`,
      ],
      aktiv: [],
      zustand: { auctions: {} },
    });
    pruefe('Unlesbares, Preisloses und Abgebrochenes landet nicht im Verlauf',
      alleVerkaeufe(lauf.verlauf).length === 0, JSON.stringify(lauf.verlauf).slice(0, 120));
    pruefe('Der Bericht sagt, was verworfen wurde',
      /Verworfen:/.test(lauf.ausgabe), lauf.ausgabe.split('\n').at(-2)?.slice(0, 160));
  }

  // Die dritte Ungenauigkeit: Eine zurueckgezogene Auktion mit Gebot
  // faellt aus /active heraus und sieht fuer den Vergleich aus wie eine
  // verkaufte. Sagt der Strom "zurueckgezogen", weiss er es besser.
  {
    const zurueck = { ...auktion, id: 'zurueck-1', endTime: new Date(Date.now() + 3_600_000).toISOString() };
    const lauf = laufe({
      ereignisse: [`id: e7\nevent: auction.cancelled\ndata: ${JSON.stringify(zurueck)}\n\n`],
      aktiv: [],
      zustand: { auctions: { 'zurueck-1': zurueck } },
    });
    pruefe('Eine zurueckgezogene Auktion wird nicht als Verkauf archiviert',
      alleVerkaeufe(lauf.verlauf).length === 0, JSON.stringify(Object.keys(lauf.verlauf)));
    pruefe('Und der Bericht sagt, dass es verhindert wurde',
      /1, die der Vergleich sonst als Verkauf archiviert hätte — verhindert/.test(lauf.ausgabe),
      lauf.ausgabe.split('\n').at(-2)?.slice(0, 200));
  }

  // Gegenprobe, und sie ist der Grund fuer die Zeile darueber: Ohne die
  // Meldung des Stroms archiviert der Vergleich sie sehr wohl -- zum
  // Gebotspreis, den nie jemand bezahlt hat.
  {
    const zurueck = { ...auktion, id: 'zurueck-2', endTime: new Date(Date.now() + 3_600_000).toISOString() };
    const lauf = laufe({ ereignisse: [], aktiv: [], zustand: { auctions: { 'zurueck-2': zurueck } }, modus: 'aus' });
    const verkaeufe = alleVerkaeufe(lauf.verlauf);
    pruefe('Gegenprobe: Ohne den Strom gilt sie als Verkauf',
      verkaeufe.length === 1 && verkaeufe[0].finalPrice === 5000,
      `${verkaeufe.length}x zu ${verkaeufe[0]?.finalPrice}`);
  }

  // Beim Beobachten wird nur gezaehlt, nicht eingegriffen -- sonst waere
  // der Modus nicht mehr das, was er verspricht.
  {
    const zurueck = { ...auktion, id: 'zurueck-3', endTime: new Date(Date.now() + 3_600_000).toISOString() };
    const lauf = laufe({
      ereignisse: [`id: e8\nevent: auction.cancelled\ndata: ${JSON.stringify(zurueck)}\n\n`],
      aktiv: [],
      zustand: { auctions: { 'zurueck-3': zurueck } },
      modus: 'beobachten',
    });
    pruefe('Beim Beobachten wird sie weiter archiviert, aber gezaehlt',
      alleVerkaeufe(lauf.verlauf).length === 1 &&
        /1, die der Vergleich sonst als Verkauf archiviert hätte\./.test(lauf.ausgabe),
      lauf.ausgabe.split('\n').at(-2)?.slice(0, 200));
  }

  // Noch laufende Auktionen fasst niemand an.
  {
    const laeuft = { ...auktion, id: 'laeuft-1', endTime: new Date(Date.now() + 3_600_000).toISOString() };
    const lauf = laufe({ ereignisse: [], aktiv: [laeuft], zustand: { auctions: { 'laeuft-1': laeuft } } });
    pruefe('Eine laufende Auktion wird nicht archiviert',
      alleVerkaeufe(lauf.verlauf).length === 0, JSON.stringify(Object.keys(lauf.verlauf)));
    pruefe('Sie steht aber weiter im gemerkten Stand',
      Object.keys(lauf.zustand.auctions).join(',') === 'laeuft-1',
      Object.keys(lauf.zustand.auctions).join(', '));
  }

  console.log(fehler ? `\n${fehler} Fehler.` : '\nAlle Prüfungen bestanden.');
  process.exitCode = fehler ? 1 : 0;

}

main();

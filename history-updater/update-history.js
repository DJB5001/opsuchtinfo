// =====================================================================
// OPSUCHT Auktions-Verlauf Updater
// =====================================================================
// Läuft alle 30 Minuten via GitHub Actions.
//
// Idee:
//  - Wir holen die aktuell aktiven Auktionen von der OPSUCHT-API.
//  - Wir merken uns diesen "Live"-Zustand in state.json.
//  - Beim nächsten Lauf vergleichen wir: Jede Auktion, die letztes Mal
//    noch aktiv war, jetzt aber verschwunden ist UND deren Endzeit
//    vorbei ist, gilt als "verkauft/beendet" -> sie wandert in
//    auction-history.json.
//  - Auktionen, die einfach nur zurückgezogen wurden (Endzeit noch in
//    der Zukunft), werden NICHT als Verkauf gewertet.
//
// Ergebnis-Format von auction-history.json (identisch zum alten Repo):
//   { "<ItemName>": [ { sale }, { sale }, ... ], ... }
// wobei ItemName = item.displayName (Fallback: item.material).
// =====================================================================

const fs = require('fs');
const path = require('path');

const API_URL = 'https://api.opsucht.net/auctions/active';
const HISTORY_FILE = path.join(__dirname, '..', 'auction-history.json');
const STATE_FILE = path.join(__dirname, 'state.json');

// Die kleine Zusammenfassung für den Discord-Bot. Warum es sie gibt und
// was drinsteht, erklärt wert-index.js.
const { baueIndex } = require('./wert-index.js');
const { ergaenzeNamen } = require('./namen.js');
const { holeRueckstand } = require('./strom.js');
const INDEX_FILE = path.join(__dirname, '..', 'wert-index.json');

// =====================================================================
// Der Ereignisstrom (seit 23.09.2026)
// =====================================================================
//
// Was er besser kann als der Vergleich unten und warum, steht in
// strom.js. Kurz: Der Vergleich *schließt* aus zwei Momentaufnahmen,
// was passiert ist; der Strom *sagt* es. Drei Dinge werden damit
// richtig, die bisher geraten waren — schnelle Verkäufe, der Endpreis,
// und ob überhaupt verkauft wurde.
//
// Beide laufen. Immer. Der Strom kommt vor dem Vergleich dran, damit
// bei einem Verkauf, den beide sehen, die genauere Fassung im Verlauf
// landet — die zweite prallt an der Dublettenprüfung ab. Fällt der
// Strom aus, macht der Vergleich die Arbeit allein, so wie seit
// Monaten.
//
// ── Der Schalter ────────────────────────────────────────────────────
//
//   STROM=beobachten  (Vorgabe) Der Strom läuft und rechnet, schreibt
//                     aber nichts. Der Lauf berichtet, was er
//                     archiviert *hätte* und wie es sich zum Vergleich
//                     verhält.
//   STROM=an          Der Strom archiviert.
//   STROM=aus         Kein Strom.
//
// Die Vorgabe ist Absicht und keine Zaghaftigkeit. Dieser Code ist
// gegen eine Ankündigung geschrieben, nicht gegen die laufende API;
// welche Felder ein Ereignis wirklich trägt, stellt sich erst hier
// heraus. Am anderen Ende hängt auction-history.json — 90 Tage
// Verkäufe, aus denen /wert, die Website und die Mod ihre Zahlen
// nehmen. Ein Blick in das Protokoll eines Laufs kostet eine Minute
// und sagt, ob der Strom liefert, was er soll. Danach auf `an`.
const STROM_MODI = ['beobachten', 'an', 'aus'];
const STROM_MODUS_ROH = (process.env.STROM ?? 'beobachten').trim().toLowerCase();
const STROM_MODUS = STROM_MODI.includes(STROM_MODUS_ROH) ? STROM_MODUS_ROH : 'beobachten';

// Wie viele Verkäufe pro Item maximal behalten werden (verhindert, dass
// die Datei unendlich wächst). Bei Bedarf höher stellen.
const MAX_SALES_PER_ITEM = 500;

// Verkäufe, die älter als so viele Tage sind, werden gelöscht.
const MAX_AGE_DAYS = 90; // ~3 Monate

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 0));
}

// Eindeutige ID einer Auktion (gleich wie im Frontend aufgebaut)
function auctionKey(a) {
  if (a.id) return String(a.id);
  const mat = (a.item && a.item.material) || '';
  return `${a.seller}_${mat}_${a.endTime}`.replace(/[.#$[\]]/g, '-');
}

// Item-Name als Schlüssel im Verlauf
function itemNameOf(a) {
  return (a.item && (a.item.displayName || a.item.material)) || 'Unbekannt';
}

// Höchstbietenden + Endpreis aus dem bids-Objekt bestimmen
function deriveWinner(a) {
  let highestBidder = null;
  let finalPrice = a.currentBid ?? a.startBid ?? 0;
  if (a.bids && typeof a.bids === 'object') {
    let best = -Infinity;
    for (const [uuid, amount] of Object.entries(a.bids)) {
      const val = Number(amount);
      if (val > best) { best = val; highestBidder = uuid; }
    }
    if (best > -Infinity) finalPrice = best;
  }
  return { highestBidder, finalPrice };
}

/**
 * Einen Verkauf in den Verlauf legen. Rückgabe: ob er neu war.
 *
 * Die Dublettenprüfung ist die Stelle, an der Strom und Vergleich sich
 * nicht ins Gehege kommen: Beide sehen denselben Verkauf, aber nur der
 * erste landet — und das ist der Strom, weil er vorher dran ist.
 */
function archiviere(history, name, sale) {
  if (!history[name]) history[name] = [];
  if (history[name].some((s) => s.id === sale.id)) return false;

  history[name].push(sale);
  if (history[name].length > MAX_SALES_PER_ITEM) {
    history[name] = history[name].slice(-MAX_SALES_PER_ITEM);
  }
  return true;
}

async function main() {
  // 1) Vorherigen Zustand laden — vor allem anderen, weil im Zustand
  //    steht, wo der Strom beim letzten Mal aufgehört hat.
  const prevState = readJson(STATE_FILE, { auctions: {} });
  const prevAuctions = prevState.auctions || {};

  // 2) Verlauf laden
  const history = readJson(HISTORY_FILE, {});

  // 3) Der Ereignisstrom: was seit dem letzten Lauf wirklich passiert ist
  let strom = null;
  if (STROM_MODUS !== 'aus') {
    strom = await holeRueckstand({
      kennung: prevState.stromKennung,
      schluesselVon: auctionKey,
    });
  }

  let ausStrom = 0;
  const stromIds = new Set();
  const stromPreise = new Map(); // id -> Endpreis, für den Abgleich unten
  for (const sale of strom?.verkaeufe ?? []) {
    stromIds.add(sale.id);
    stromPreise.set(sale.id, sale.finalPrice);
    if (STROM_MODUS !== 'an') continue; // beobachten: rechnen, nicht schreiben
    if (archiviere(history, itemNameOf(sale), sale)) ausStrom += 1;
  }

  // 4) Aktuelle aktive Auktionen holen
  let active;
  try {
    const res = await fetch(API_URL, { headers: { 'User-Agent': 'opsucht-history-updater' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    active = await res.json();
  } catch (e) {
    console.error('Konnte aktive Auktionen nicht laden:', e.message);
    // Was der Strom gebracht hat, ist deshalb nicht weniger wert —
    // und der Anschlusspunkt darf nicht verloren gehen, sonst fehlt
    // beim nächsten Lauf genau dieser Abschnitt.
    return beendeOhneVergleich(history, prevState, strom, ausStrom);
  }
  if (!Array.isArray(active)) {
    console.error('Unerwartetes API-Format, breche ab.');
    return beendeOhneVergleich(history, prevState, strom, ausStrom);
  }

  // Map: key -> Auktion (aktueller Zustand)
  const activeMap = {};
  for (const a of active) activeMap[auctionKey(a)] = a;

  const now = Date.now();
  let newlyArchived = 0;
  const vergleichsIds = new Set();
  const vergleichsPreise = new Map();

  // Was der Strom als Ende OHNE Verkauf gemeldet hat. Der Vergleich
  // würde genau das als Verkauf archivieren: Eine zurückgezogene
  // Auktion mit Gebot fällt aus /active heraus und sieht für ihn aus
  // wie eine verkaufte. Der Preis, den nie jemand bezahlt hat, ginge in
  // den Schnitt ein.
  const ohneVerkauf = strom?.ohneVerkauf ?? new Map();
  let verhindert = 0;

  // 4) Verkaufte/beendete Auktionen finden: war vorher da, ist jetzt weg.
  //    Drei Fälle, wenn eine Auktion aus der Liste verschwindet:
  //    a) Endzeit vorbei + Gebote  -> regulär ersteigert
  //    b) Endzeit noch offen, aber Sofortkaufpreis vorhanden -> per Sofortkauf gekauft
  //    c) Endzeit noch offen, kein Sofortkauf -> vorzeitig zurückgezogen (KEIN Verkauf)
  for (const [key, prevAuction] of Object.entries(prevAuctions)) {
    if (activeMap[key]) continue; // noch aktiv -> nichts tun

    const endMs = new Date(prevAuction.endTime).getTime();
    if (isNaN(endMs)) continue;

    const bidValues = prevAuction.bids ? Object.values(prevAuction.bids).map(Number) : [];
    const hadBids = bidValues.length > 0;
    const highestBid = hadBids ? Math.max(...bidValues) : 0;
    const hasInstantBuy = prevAuction.instantBuyPrice != null && prevAuction.instantBuyPrice > 0;

    // "Echtes" Gebot = jemand hat mindestens das Startgebot geboten.
    // (Bei OPSUCHT ist schon das erste Gebot ein echtes Kaufgebot.)
    const startBid = Number(prevAuction.startBid) || 0;
    const hadRealBid = hadBids && highestBid > 0 && highestBid >= startBid;

    // Sofortkauf: höchstes Gebot erreicht/übertrifft den Sofortkaufpreis.
    const boughtViaInstant = hasInstantBuy && hadBids && highestBid >= prevAuction.instantBuyPrice;

    let saleType = null;
    if (boughtViaInstant) {
      saleType = 'instant';        // per Sofortkauf gekauft
    } else if (hadRealBid) {
      // Verschwunden + hatte ein echtes Gebot -> verkauft.
      // Egal ob die Endzeit exakt erreicht ist: fällt eine Auktion MIT Gebot
      // aus der Liste, wurde sie so gut wie immer verkauft. Das erfasst auch
      // Auktionen, die zwischen zwei Läufen kurz vor Schluss weggingen.
      saleType = 'auction';
    }
    // Kein Gebot -> unverkauft/zurückgegeben, nicht archivieren.
    if (!saleType) continue;

    // Der Strom weiß es besser. Beim Beobachten wird nur gezählt: Die
    // Zahl gehört in den Bericht, damit sichtbar ist, was das Umlegen
    // des Schalters ausmacht.
    if (ohneVerkauf.has(key)) {
      verhindert += 1;
      if (STROM_MODUS === 'an') continue;
    }

    const { highestBidder, finalPrice } = deriveWinner(prevAuction);
    // Bei Sofortkauf ist der Endpreis der Sofortkaufpreis
    const soldPrice = saleType === 'instant' ? prevAuction.instantBuyPrice : finalPrice;

    const sale = {
      id: key,
      seller: prevAuction.seller,
      highestBidder: highestBidder,
      startBid: prevAuction.startBid,
      currentBid: prevAuction.currentBid ?? soldPrice,
      finalPrice: soldPrice,
      instantBuyPrice: prevAuction.instantBuyPrice ?? null,
      saleType: saleType, // 'auction' oder 'instant'
      endTime: prevAuction.endTime,
      soldAt: new Date(Math.min(endMs, now)).toISOString(),
      sold: true,
      bids: prevAuction.bids || {},
      item: prevAuction.item
    };

    vergleichsIds.add(sale.id);
    vergleichsPreise.set(sale.id, soldPrice);

    if (archiviere(history, itemNameOf(prevAuction), sale)) newlyArchived++;
  }

  // 5) Neuen Zustand speichern (nur die Felder, die wir zum Archivieren
  //    brauchen). `stromKennung` ist der Anschlusspunkt für den nächsten
  //    Lauf — geht sie verloren, fängt der Strom von vorn an, und alles,
  //    was seit diesem Lauf passiert ist, kommt nie an.
  const newState = {
    updatedAt: new Date().toISOString(),
    stromKennung: strom?.kennung ?? prevState.stromKennung ?? null,
    auctions: {},
  };
  for (const [key, a] of Object.entries(activeMap)) {
    newState.auctions[key] = {
      seller: a.seller,
      startBid: a.startBid,
      currentBid: a.currentBid,
      instantBuyPrice: a.instantBuyPrice ?? null,
      endTime: a.endTime,
      bids: a.bids || {},
      item: a.item
    };
  }

  // 5b) Verkäufe älter als MAX_AGE_DAYS entfernen (~3 Monate)
  const cutoff = now - MAX_AGE_DAYS * 24 * 60 * 60 * 1000;
  let removedOld = 0;
  for (const name of Object.keys(history)) {
    const kept = (history[name] || []).filter(sale => {
      // Zeitpunkt des Verkaufs bestimmen (soldAt bevorzugt, sonst endTime)
      const t = new Date(sale.soldAt || sale.endTime).getTime();
      // Wenn kein gültiges Datum vorhanden ist, sicherheitshalber behalten
      if (isNaN(t)) return true;
      return t >= cutoff;
    });
    removedOld += (history[name].length - kept.length);
    if (kept.length === 0) {
      delete history[name]; // leere Item-Einträge ganz entfernen
    } else {
      history[name] = kept;
    }
  }

  writeJson(HISTORY_FILE, history);
  writeJson(STATE_FILE, newState);

  // 6) Zusammenfassung für den Bot.
  //
  // Scheitert sie, ist das kein Grund, den Lauf als gescheitert zu
  // melden: Der Verlauf selbst steht bereits sicher auf der Platte, und
  // ein Bot ohne frischen Index zeigt eben die Zahlen von vorhin.
  let indexZeile = '';
  try {
    const { index, entdoppelt } = baueIndex(history);

    // Namen dazu, soweit sie bekannt sind. Aufgelöst wird nur ein
    // Häppchen pro Lauf — warum, steht in namen.js. Auch hier gilt: Ein
    // Aussetzer bei einem fremden Dienst darf den Index nicht kosten.
    let namenZeile = '';
    try {
      const { namen, bericht } = await ergaenzeNamen(index.spieler);
      // Fünfte Stelle der Spielerzeile, siehe wert-index.js.
      for (const [uuid, name] of Object.entries(namen)) {
        if (index.spieler[uuid]) index.spieler[uuid][4] = name;
      }
      namenZeile =
        ` Namen: ${bericht.bekannt}/${bericht.gesamt} bekannt ` +
        `(${bericht.neu} neu, ${bericht.leer} ohne Treffer` +
        `${bericht.abgebrochen ? `, ${bericht.offen} vertagt — Zeitbudget` : ''}).`;
    } catch (e) {
      namenZeile = ` Namen nicht ergänzt: ${e.message}`;
    }

    writeJson(INDEX_FILE, index);
    const groesse = Math.round(fs.statSync(INDEX_FILE).size / 1024);
    indexZeile =
      ` Index: ${Object.keys(index.items).length} Items, ` +
      `${Object.keys(index.spieler).length} Spieler, ${groesse} KB ` +
      `(${entdoppelt} Zwischenstände zusammengefasst).${namenZeile}`;
  } catch (e) {
    indexZeile = ` Index NICHT geschrieben: ${e.message}`;
  }

  console.log(
    `Fertig. Aktive Auktionen: ${active.length}, neu archiviert: ${newlyArchived + ausStrom}` +
      `${ausStrom ? ` (davon ${ausStrom} aus dem Strom)` : ''}, ` +
      `alte entfernt (>${MAX_AGE_DAYS}d): ${removedOld}.${indexZeile}`
  );
  console.log(
    stromBericht(strom, { stromIds, stromPreise, vergleichsIds, vergleichsPreise, verhindert })
  );
}

/**
 * Was der Strom gebracht hat — und wie er sich zum Vergleich verhält.
 *
 * Das ist der Zweck des Beobachten-Modus und die Grundlage für die
 * Entscheidung, ob `STROM=an` gesetzt werden kann. Drei Zahlen zählen:
 *
 *  - **„nur der Strom"**: Verkäufe, die der Vergleich gar nicht gesehen
 *    hat. Das ist der Gewinn — überwiegend schnelle Sofortkäufe.
 *  - **„anderer Preis"**: Verkäufe, die beide kennen, mit
 *    unterschiedlichem Endpreis. Der Strom hat recht; der Vergleich
 *    rechnet mit dem letzten Gebot, das er gesehen hat.
 *  - **„nur der Vergleich"**: Verkäufe, die der Strom nicht gemeldet
 *    hat. Eine kleine Zahl ist normal (der Rückstand reicht nicht
 *    beliebig weit zurück). Eine große heißt: Der Strom liefert nicht,
 *    was er soll — dann wäre `an` verfrüht. Schlimm ist es nie, denn
 *    der Vergleich läuft in jedem Fall mit.
 */
function stromBericht(strom, { stromIds, stromPreise, vergleichsIds, vergleichsPreise, verhindert }) {
  if (!strom) return `Strom: ${STROM_MODUS === 'aus' ? 'abgeschaltet' : 'nicht gelaufen'}.`;
  if (strom.fehler) return `Strom: nicht erreichbar (${strom.fehler}) — der Vergleich hat allein gearbeitet.`;

  const beide = [...stromIds].filter((id) => vergleichsIds.has(id));
  const abweichend = beide.filter((id) => Number(stromPreise.get(id)) !== Number(vergleichsPreise.get(id)));
  const nurStrom = [...stromIds].filter((id) => !vergleichsIds.has(id)).length;
  const nurVergleich = [...vergleichsIds].filter((id) => !stromIds.has(id)).length;

  const verworfen = Object.entries(strom.verworfen ?? {});
  const teile = [
    `Strom [${STROM_MODUS}]: ${strom.ereignisse} Ereignisse in ${Math.round(strom.dauerMs / 1000)} s,`,
    `${stromIds.size} Verkäufe erkannt.`,
    `Davon ${beide.length} auch im Vergleich`,
    `(Preis abweichend bei ${abweichend.length}),`,
    `${nurStrom} nur im Strom,`,
    `${nurVergleich} nur im Vergleich.`,
  ];
  if (verworfen.length) {
    teile.push(`Verworfen: ${verworfen.map(([g, n]) => `${n}× ${g}`).join(', ')}.`);
  }
  if (strom.ohneVerkauf?.size) {
    teile.push(
      `${strom.ohneVerkauf.size} endeten ohne Verkauf` +
        (verhindert
          ? `, davon ${verhindert}, die der Vergleich sonst als Verkauf archiviert hätte` +
            `${STROM_MODUS === 'an' ? ' — verhindert' : ''}.`
          : '.')
    );
  }
  if (strom.zurueckgesetzt) {
    teile.push('Der Server hat um Neuabgleich gebeten — der Rückstand fehlt, der Vergleich fängt ihn auf.');
  }
  if (STROM_MODUS === 'beobachten') {
    teile.push('Geschrieben wurde nichts davon (STROM=beobachten).');
  }

  // Ein paar Beispiele, wo die Preise auseinandergehen. Ohne sie ist
  // „abweichend bei 7" eine Zahl, mit ihnen eine Aussage.
  const beispiele = abweichend.slice(0, 3)
    .map((id) => `${id}: Strom ${stromPreise.get(id)} / Vergleich ${vergleichsPreise.get(id)}`);
  if (beispiele.length) teile.push(`Beispiele: ${beispiele.join(' | ')}.`);

  return teile.join(' ');
}

/**
 * Notausgang: Das Auktionshaus antwortet nicht.
 *
 * Bisher endete der Lauf hier ohne zu schreiben, und das war richtig —
 * ohne /active gibt es nichts zu vergleichen. Jetzt kann der Strom
 * trotzdem etwas gebracht haben, und vor allem steckt in ihm der
 * Anschlusspunkt für den nächsten Lauf. Ginge der verloren, fehlte beim
 * nächsten Mal genau der Abschnitt dazwischen.
 *
 * Der Index wird hier bewusst nicht neu gebaut: Dafür ist ein Lauf
 * ohne Vergleich kein Anlass, und der alte Index ist nicht falsch,
 * nur ein paar Minuten alt.
 */
function beendeOhneVergleich(history, prevState, strom, ausStrom) {
  if (ausStrom > 0) writeJson(HISTORY_FILE, history);
  writeJson(STATE_FILE, {
    ...prevState,
    updatedAt: new Date().toISOString(),
    stromKennung: strom?.kennung ?? prevState.stromKennung ?? null,
  });
  console.log(
    `Ohne Vergleich beendet. Aus dem Strom archiviert: ${ausStrom}. ` +
      `Der gemerkte Stand bleibt, der nächste Lauf vergleicht gegen ihn.`
  );
}

main();

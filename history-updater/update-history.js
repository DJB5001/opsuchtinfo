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

async function main() {
  // 1) Aktuelle aktive Auktionen holen
  let active;
  try {
    const res = await fetch(API_URL, { headers: { 'User-Agent': 'opsucht-history-updater' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    active = await res.json();
  } catch (e) {
    console.error('Konnte aktive Auktionen nicht laden:', e.message);
    process.exit(0); // Kein harter Fehler -> nächster Lauf versucht es erneut
  }
  if (!Array.isArray(active)) {
    console.error('Unerwartetes API-Format, breche ab.');
    process.exit(0);
  }

  // Map: key -> Auktion (aktueller Zustand)
  const activeMap = {};
  for (const a of active) activeMap[auctionKey(a)] = a;

  // 2) Vorherigen Zustand laden
  const prevState = readJson(STATE_FILE, { auctions: {} });
  const prevAuctions = prevState.auctions || {};

  // 3) Verlauf laden
  const history = readJson(HISTORY_FILE, {});

  const now = Date.now();
  let newlyArchived = 0;

  // 4) Verkaufte/beendete Auktionen finden: war vorher da, ist jetzt weg.
  //    Drei Fälle, wenn eine Auktion aus der Liste verschwindet:
  //    a) Endzeit vorbei + Gebote  -> regulär ersteigert
  //    b) Endzeit noch offen, aber Sofortkaufpreis vorhanden -> per Sofortkauf gekauft
  //    c) Endzeit noch offen, kein Sofortkauf -> vorzeitig zurückgezogen (KEIN Verkauf)
  for (const [key, prevAuction] of Object.entries(prevAuctions)) {
    if (activeMap[key]) continue; // noch aktiv -> nichts tun

    const endMs = new Date(prevAuction.endTime).getTime();
    if (isNaN(endMs)) continue;

    const expired = endMs <= now + 2 * 60 * 1000; // Endzeit (fast) erreicht
    const hadBids = prevAuction.bids && Object.keys(prevAuction.bids).length > 0;
    const hasInstantBuy = prevAuction.instantBuyPrice != null && prevAuction.instantBuyPrice > 0;

    // Ein Sofortkauf hinterlässt ein Gebot in Höhe des Sofortkaufpreises.
    // Das ist das zuverlässigste Signal für "wurde per Sofortkauf gekauft".
    let boughtViaInstant = false;
    if (hasInstantBuy && hadBids) {
      const highestBid = Math.max(...Object.values(prevAuction.bids).map(Number));
      if (highestBid >= prevAuction.instantBuyPrice) boughtViaInstant = true;
    }

    let saleType = null;
    if (boughtViaInstant) {
      saleType = 'instant';        // per Sofortkauf gekauft (Gebot >= Sofortkaufpreis)
    } else if (expired && hadBids) {
      saleType = 'auction';        // regulär ersteigert (abgelaufen + Gebote)
    }
    // Alles andere (vor Ablauf verschwunden ohne Sofortkauf-Gebot, oder
    // abgelaufen ohne Gebote) -> zurückgezogen/unverkauft, nicht archivieren.
    if (!saleType) continue;

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

    const name = itemNameOf(prevAuction);
    if (!history[name]) history[name] = [];

    // Duplikate vermeiden (gleiche id nicht doppelt archivieren)
    if (!history[name].some(s => s.id === sale.id)) {
      history[name].push(sale);
      newlyArchived++;
      // Auf Maximalgröße kürzen (älteste zuerst raus)
      if (history[name].length > MAX_SALES_PER_ITEM) {
        history[name] = history[name].slice(-MAX_SALES_PER_ITEM);
      }
    }
  }

  // 5) Neuen Zustand speichern (nur die Felder, die wir zum Archivieren brauchen)
  const newState = { updatedAt: new Date().toISOString(), auctions: {} };
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

  console.log(`Fertig. Aktive Auktionen: ${active.length}, neu archiviert: ${newlyArchived}, alte entfernt (>${MAX_AGE_DAYS}d): ${removedOld}.`);
}

main();

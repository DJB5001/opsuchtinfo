// =====================================================================
// Der Ereignisstrom des Auktionshauses
// =====================================================================
//
// Seit dem 23.09.2026 schickt api.opsucht.net jede Änderung im
// Auktionshaus sofort, als Server-Sent Events.
//
// Warum das hier den Unterschied macht: Der Updater vergleicht alle 15
// Minuten zwei Momentaufnahmen von /active und *schließt* daraus, was
// passiert ist. Das kostet drei Dinge, und alle drei landen im
// Wert-Index — und damit in /wert, auf der Website und in der Mod.
//
//  1. **Schnelle Verkäufe fehlen ganz.** Was zwischen zwei Läufen
//     eingestellt *und* gekauft wird, steht in keiner der beiden
//     Aufnahmen. Es hat nie stattgefunden. Sofortkäufe laufen genau so.
//  2. **Der Endpreis ist zu niedrig.** Gerechnet wird mit dem letzten
//     gesehenen Gebot. Jedes Gebot aus den letzten 15 Minuten fehlt —
//     und kurz vor Schluss wird am meisten geboten.
//  3. **„Verkauft" ist geraten.** Eine zurückgezogene Auktion mit Gebot
//     sieht aus wie ein Verkauf und wird als einer archiviert.
//
// Der Strom sagt stattdessen: verkauft, zu diesem Preis, an den.
//
// ── Wie ein Cron-Job an einem endlosen Strom hängt ──────────────────
//
// Gar nicht — und das muss er auch nicht. Der Lauf verbindet sich, gibt
// mit `Last-Event-ID` an, wo er beim letzten Mal aufgehört hat, nimmt
// entgegen, was seitdem aufgelaufen ist, und legt wieder auf. Genau
// dafür ist der Kopfzeilen-Anschluss gedacht.
//
// Aufgelegt wird, wenn eine Weile nichts mehr kommt (dann ist der
// Rückstand abgearbeitet) oder spätestens nach einer Obergrenze. Ein
// Action-Läufer, der 15 Minuten lang eine Verbindung offen hält, wäre
// die Alternative — für dieselbe Auskunft, bei 96 Läufen am Tag.
//
// Kann der Server den Anschluss nicht herstellen, schickt er
// `stream.reset`. Dann ist der Rückstand verloren, und es bleibt beim
// Vergleich — der läuft ohnehin bei jedem Durchgang.

const STROM_URL = 'https://api.opsucht.net/auctions/stream';

/** Nach so langer Stille gilt der Rückstand als abgearbeitet. */
const STILLE_MS = 8000;

/** Länger hält kein Lauf die Verbindung, egal wie viel noch kommt. */
const HOECHSTENS_MS = 60_000;

/** Die Ereignisse, die einen Verkauf bedeuten — und welcher Art er ist. */
const VERKAUFSARTEN = {
  'auction.sold': 'auction',
  'auction.instant_bought': 'instant',
};

/**
 * Die Ereignisse, die ein Ende OHNE Verkauf bedeuten.
 *
 * Das ist die dritte der drei Ungenauigkeiten des Vergleichs, und die
 * einzige, die der Strom nicht schon dadurch behebt, dass er einen
 * Verkauf genauer meldet: Eine zurückgezogene Auktion mit Gebot fällt
 * aus /active heraus und sieht für den Vergleich aus wie ein Verkauf.
 * Er archiviert sie als einen — zum Gebotspreis, den nie jemand bezahlt
 * hat, und der Preis geht in den Schnitt ein.
 *
 * Sagt der Strom „zurückgezogen" oder „abgelaufen", weiß der Vergleich
 * es besser und lässt die Finger davon.
 */
const ENDEN_OHNE_VERKAUF = {
  'auction.cancelled': 'zurückgezogen',
  'auction.expired': 'abgelaufen',
};

// ── Der Draht ────────────────────────────────────────────────────────

/**
 * Zerlegt den Zeichenstrom in Ereignisse, nach der SSE-Spezifikation.
 *
 * Eigene Zeilenlogik statt eines Pakets: Das Format ist winzig, und die
 * Tücken liegen alle in den Rändern — ein Schub aus dem Netz endet
 * mitten in einer Zeile, und ein `\r` am Schubende kann der Anfang
 * eines `\r\n` im nächsten sein. Wird das falsch gemacht, geht die
 * Zeile verloren, an der es passiert. Ohne Meldung.
 *
 * Dieselbe Zerlegung steht im Discord-Bot in `src/auktionsstrom.js`.
 * Zwei Repos, zwei Kopien — so wie die Verkaufsart-Erkennung schon
 * doppelt steht. Wer hier etwas ändert, sollte drüben nachsehen.
 */
function macheZerleger(aufEreignis) {
  let puffer = '';
  let typ = '';
  let daten = '';
  let kennung = null;
  let ersterSchub = true;

  function abschicken() {
    if (daten === '') {
      typ = '';
      return;
    }
    const nutzlast = daten.endsWith('\n') ? daten.slice(0, -1) : daten;
    daten = '';
    const art = typ || 'message';
    typ = '';
    aufEreignis({ art, daten: nutzlast, kennung });
  }

  function zeile(z) {
    if (z === '') return abschicken();
    if (z.startsWith(':')) return; // Kommentar — als Herzschlag gemeint

    const trenner = z.indexOf(':');
    const feld = trenner === -1 ? z : z.slice(0, trenner);
    let wert = trenner === -1 ? '' : z.slice(trenner + 1);
    if (wert.startsWith(' ')) wert = wert.slice(1);

    if (feld === 'event') typ = wert;
    else if (feld === 'data') daten += wert + '\n';
    else if (feld === 'id' && !wert.includes('\0')) kennung = wert;
  }

  return {
    schub(text) {
      if (ersterSchub) {
        if (text.startsWith('﻿')) text = text.slice(1);
        ersterSchub = false;
      }
      puffer += text;

      let i = 0;
      let anfang = 0;
      while (i < puffer.length) {
        const c = puffer[i];
        if (c === '\n') {
          zeile(puffer.slice(anfang, i));
          i += 1;
          anfang = i;
        } else if (c === '\r') {
          if (i === puffer.length - 1) break; // könnte ein \r\n werden
          zeile(puffer.slice(anfang, i));
          i += puffer[i + 1] === '\n' ? 2 : 1;
          anfang = i;
        } else {
          i += 1;
        }
      }
      puffer = puffer.slice(anfang);
    },

    ende() {
      if (puffer.endsWith('\r')) zeile(puffer.slice(0, -1));
      puffer = '';
      typ = '';
      daten = '';
    },

    kennung: () => kennung,
  };
}

// ── Was in einem Ereignis steht ──────────────────────────────────────

/**
 * Die Auktion aus einem Ereignis — oder null.
 *
 * Hier sitzt die Unsicherheit dieser Datei an einer Stelle. Angekündigt
 * sind „die vollständigen Daten der Auktion"; ob sie blank im Ereignis
 * stehen oder eingepackt, sagt die Ankündigung nicht. Statt zu raten
 * werden die plausiblen Formen durchprobiert, und was nicht wie eine
 * Auktion aussieht, wird verworfen.
 */
function auktionAus(daten) {
  let roh;
  try {
    roh = typeof daten === 'string' ? JSON.parse(daten) : daten;
  } catch {
    return null;
  }
  if (!roh || typeof roh !== 'object') return null;

  for (const kandidat of [roh, roh.auction, roh.data, roh.payload]) {
    if (kandidat && typeof kandidat === 'object' && kandidat.item?.material) return kandidat;
  }
  return null;
}

/** Der Zeitpunkt eines Ereignisses in Millisekunden — oder null. */
function zeitpunktAus(daten) {
  let roh;
  try {
    roh = typeof daten === 'string' ? JSON.parse(daten) : daten;
  } catch {
    return null;
  }
  if (!roh || typeof roh !== 'object') return null;

  for (const feld of ['timestamp', 'time', 'at', 'soldAt', 'occurredAt']) {
    const wert = roh[feld];
    if (wert == null) continue;
    const ms = typeof wert === 'number' ? (wert < 1e11 ? wert * 1000 : wert) : Date.parse(wert);
    if (Number.isFinite(ms) && ms > 0) return ms;
  }
  return null;
}

// ── Der Verkauf ──────────────────────────────────────────────────────

/**
 * Aus einem Ereignis einen Verkauf machen — in genau der Form, die
 * `auction-history.json` seit jeher hat.
 *
 * Die Prüfungen am Ende sind der eigentliche Punkt dieser Funktion.
 * Diese Datei ist gegen eine Ankündigung geschrieben, nicht gegen die
 * laufende API; welche Felder ein Ereignis wirklich trägt, stellt sich
 * erst im Betrieb heraus. Der Verlauf ist aber die Grundlage von
 * /wert, der Website und der Mod — dort etwas Halbes hineinzuschreiben
 * wäre schlimmer, als den Verkauf zu verpassen. Was die Prüfungen nicht
 * besteht, wird verworfen; der Vergleich hat später noch seine
 * Gelegenheit.
 *
 * Rückgabe: `{ verkauf }` oder `{ grund }`.
 */
function verkaufAus(auktion, art, zeitpunkt, schluesselVon) {
  const saleType = VERKAUFSARTEN[art];
  if (!saleType) return { grund: 'keine Verkaufsart' };
  if (!auktion?.item?.material) return { grund: 'kein Item' };
  if (!auktion.seller) return { grund: 'kein Verkäufer' };

  const id = schluesselVon(auktion);
  if (!id) return { grund: 'keine Kennung' };

  let hoechstbietender = null;
  let bestes = -Infinity;
  if (auktion.bids && typeof auktion.bids === 'object') {
    for (const [uuid, betrag] of Object.entries(auktion.bids)) {
      const wert = Number(betrag);
      if (Number.isFinite(wert) && wert > bestes) {
        bestes = wert;
        hoechstbietender = uuid;
      }
    }
  }
  const gebot = bestes > -Infinity ? bestes : (auktion.currentBid ?? auktion.startBid ?? 0);
  const endpreis = Number(saleType === 'instant' ? (auktion.instantBuyPrice ?? gebot) : gebot);

  if (!Number.isFinite(endpreis) || endpreis <= 0) return { grund: 'kein Preis' };

  const endeMs = new Date(auktion.endTime).getTime();

  return {
    verkauf: {
      id,
      seller: auktion.seller,
      highestBidder: hoechstbietender,
      startBid: auktion.startBid,
      currentBid: auktion.currentBid ?? endpreis,
      finalPrice: endpreis,
      instantBuyPrice: auktion.instantBuyPrice ?? null,
      saleType,
      endTime: auktion.endTime,
      // Der Zeitpunkt aus dem Ereignis, wo es einen gibt. Beim
      // Nachreichen eines Rückstands wäre „jetzt" um Minuten daneben,
      // und aus soldAt rechnet der Index die Tagesreihe.
      soldAt: new Date(zeitpunkt ?? (Number.isNaN(endeMs) ? Date.now() : Math.min(endeMs, Date.now())))
        .toISOString(),
      sold: true,
      bids: auktion.bids || {},
      item: auktion.item,
    },
  };
}

// ── Die Verbindung ───────────────────────────────────────────────────

/**
 * Holt, was seit `kennung` aufgelaufen ist, und legt wieder auf.
 *
 * Wirft nie. Ein Strom, der nicht geht, ist kein Grund, den Lauf
 * scheitern zu lassen — der Vergleich macht dann die Arbeit allein, so
 * wie er es seit Monaten tut.
 */
async function holeRueckstand({
  kennung = null,
  stilleMs = STILLE_MS,
  hoechstensMs = HOECHSTENS_MS,
  adresse = STROM_URL,
  holen = fetch,
  schluesselVon,
  log = console,
} = {}) {
  const bericht = {
    verkaeufe: [],
    /** Kennungen, die laut Strom geendet haben, ohne verkauft zu werden. */
    ohneVerkauf: new Map(),
    kennung,
    ereignisse: 0,
    verworfen: {},
    zurueckgesetzt: false,
    fehler: null,
    dauerMs: 0,
  };
  const begonnen = Date.now();

  const steuerung = new AbortController();
  let stilleUhr = null;
  const schluss = () => steuerung.abort();

  const rechtzeitig = setTimeout(schluss, hoechstensMs);
  const stilleZuruecksetzen = () => {
    if (stilleUhr) clearTimeout(stilleUhr);
    stilleUhr = setTimeout(schluss, stilleMs);
  };

  try {
    const kopf = {
      Accept: 'text/event-stream',
      'Cache-Control': 'no-cache',
      'User-Agent': 'opsucht-history-updater',
    };
    if (kennung) kopf['Last-Event-ID'] = String(kennung);

    const antwort = await holen(adresse, { headers: kopf, signal: steuerung.signal });
    if (!antwort.ok) throw new Error('HTTP ' + antwort.status);
    if (!antwort.body) throw new Error('Antwort ohne Rumpf');

    const zerleger = macheZerleger((ereignis) => {
      bericht.ereignisse += 1;
      if (ereignis.kennung) bericht.kennung = ereignis.kennung;

      if (ereignis.art === 'stream.reset') {
        // „Ich kann dich nicht mehr anknüpfen." Der Rückstand ist
        // verloren; was danach kommt, ist trotzdem gut. Der Vergleich
        // holt den Rest.
        bericht.zurueckgesetzt = true;
        return;
      }
      const ohneVerkauf = ENDEN_OHNE_VERKAUF[ereignis.art];
      if (!VERKAUFSARTEN[ereignis.art] && !ohneVerkauf) return;

      const auktion = auktionAus(ereignis.daten);
      if (!auktion) {
        bericht.verworfen.unlesbar = (bericht.verworfen.unlesbar ?? 0) + 1;
        return;
      }

      if (ohneVerkauf) {
        const id = schluesselVon(auktion);
        if (id) bericht.ohneVerkauf.set(id, ohneVerkauf);
        return;
      }

      const { verkauf, grund } = verkaufAus(
        auktion,
        ereignis.art,
        zeitpunktAus(ereignis.daten),
        schluesselVon
      );
      if (grund) {
        bericht.verworfen[grund] = (bericht.verworfen[grund] ?? 0) + 1;
        return;
      }
      bericht.verkaeufe.push(verkauf);
    });

    const leser = antwort.body.getReader();
    const entziffern = new TextDecoder('utf-8');
    stilleZuruecksetzen();

    // Das Lesen läuft gegen den Abbruch. Sich darauf zu verlassen, dass
    // fetch die offene Anforderung beim Abbruch fallen lässt, hieße den
    // ganzen Lauf daran zu hängen — ein Rumpf, der nie zurückkommt,
    // ließe den Job in die Zeitgrenze der Action laufen.
    const abgebrochen = new Promise((_, ablehnen) => {
      const raus = () => ablehnen(new Error('abgebrochen'));
      if (steuerung.signal.aborted) raus();
      else steuerung.signal.addEventListener('abort', raus, { once: true });
    });

    for (;;) {
      const { done, value } = await Promise.race([leser.read(), abgebrochen]);
      if (done) break;
      stilleZuruecksetzen();
      zerleger.schub(entziffern.decode(value, { stream: true }));
    }
    zerleger.ende();
  } catch (fehler) {
    // Ein Abbruch ist hier der Normalfall und kein Fehler: So wird die
    // Verbindung beendet, wenn der Rückstand durch ist.
    const abbruch = fehler?.name === 'AbortError' || /abgebrochen/i.test(fehler?.message ?? '');
    if (!abbruch) {
      bericht.fehler = fehler.message;
      log.warn?.('Auktionsstrom nicht erreichbar:', fehler.message);
    }
  } finally {
    clearTimeout(rechtzeitig);
    if (stilleUhr) clearTimeout(stilleUhr);
  }

  bericht.dauerMs = Date.now() - begonnen;
  return bericht;
}

module.exports = {
  holeRueckstand,
  ENDEN_OHNE_VERKAUF,
  macheZerleger,
  auktionAus,
  zeitpunktAus,
  verkaufAus,
  STROM_URL,
  STILLE_MS,
  HOECHSTENS_MS,
  VERKAUFSARTEN,
};

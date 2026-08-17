// =====================================================================
// Wert-Index
// =====================================================================
// Der Verlauf ist inzwischen 34 MB groß — 41.000 Verkäufe zu 2.500
// Items. Die Website lädt das einmal in den Browser und lebt damit; ein
// Discord-Bot, der auf jeden /wert-Befehl in Sekunden antworten soll,
// kann das nicht.
//
// Deshalb entsteht bei jedem Lauf zusätzlich diese Zusammenfassung:
// je Item und Variante die Zahlen der letzten 30 Tage, dazu die Bilanz
// jedes Spielers. Rund 700 KB statt 34 MB, über die Leitung gezippt
// etwa 150 KB.
//
//
// Warum hier Code aus der Website steht
// -------------------------------------
// Die Funktionen unten sind aus DNV-Website/js/script.js übernommen:
// salePricePerUnit, loreAlsText, itemVariante, variantenLabel,
// verkaufsZeit, istFortsetzung, verlaufEntdoppeln.
//
// Sie wurden bewusst kopiert und nicht neu gedacht. Der Grund ist die
// Entdopplung: Wird kurz vor Schluss noch geboten, verlängert sich die
// Auktion, und der Verlauf hält jeden Zwischenstand als eigenen Eintrag.
// Das betrifft gut 16 % aller Einträge. Die Website räumt das beim Laden
// auf — täte der Index es anders, nennte der Bot andere Durchschnitte
// als die Website, und zwei Quellen, die sich widersprechen, sind
// schlimmer als eine.
//
// Wer eine dieser Funktionen ändert, muss sie an beiden Stellen ändern.
// Der Test history-updater/wert-index.test.js hält die Zusage fest.
// =====================================================================

const VERLAENGERUNG_FENSTER_MS = 10 * 60 * 1000;
const TAGE = 30;

// ── Aus DNV-Website/js/script.js ─────────────────────────────────────

function salePricePerUnit(sale) {
  const price = sale.finalPrice ?? sale.currentBid ?? sale.startBid ?? 0;
  return price / (sale.item?.amount || 1);
}

function loreAlsText(item) {
  const l = item?.lore;
  if (!l) return '';
  return Array.isArray(l) ? l.join('\n') : String(l);
}

/** Stabiler Schlüssel einer Variante; \u0000 kommt in keinem Feld vor. */
function itemVariante(item) {
  return `${item?.material ?? ''}\u0000${loreAlsText(item)}`;
}

function materialLesbar(material) {
  return String(material || '')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Kurzes Unterscheidungsmerkmal, wenn zwei Dinge gleich heißen. */
function variantenLabel(item) {
  const lore = loreAlsText(item);
  const teile = [];

  const typ = lore.match(/Gewinntyp\s*»\s*(.+)/);
  if (typ && typ[1].trim() && typ[1].trim() !== 'Item') teile.push(typ[1].trim());

  const zustand = lore.match(/Zustand:\s*(\S+)/);
  if (zustand) teile.push(zustand[1]);

  if (!teile.length && item?.material) teile.push(materialLesbar(item.material));
  return teile.join(' · ');
}

function verkaufsZeit(verkauf) {
  const t = new Date(verkauf?.soldAt || verkauf?.endTime || 0).getTime();
  return isNaN(t) ? 0 : t;
}

/**
 * Ist der zweite Eintrag die Fortsetzung des ersten?
 *
 * Der Ausschlag gibt nicht die Zeit, sondern die Gebotsliste: Bei einer
 * Verlängerung bleibt jeder bisherige Bieter drin und bietet nie weniger
 * als zuvor. Zwei getrennte Auktionen müssten exakt dieselbe Bieterschaft
 * mit durchweg höheren Beträgen haben — das passiert nicht zufällig.
 */
function istFortsetzung(vorher, jetzt) {
  if (verkaufsZeit(jetzt) - verkaufsZeit(vorher) > VERLAENGERUNG_FENSTER_MS) return false;

  const alt = vorher?.bids || {};
  const neu = jetzt?.bids || {};
  const bieter = Object.keys(alt);

  if (!bieter.length || !Object.keys(neu).length) return false;

  for (const uuid of bieter) {
    if (!(uuid in neu)) return false;
    if (neu[uuid] < alt[uuid]) return false;
  }
  return true;
}

/** Jede Auktion genau einmal, mit ihrer letzten Aufnahme. */
function verlaufEntdoppeln(verlauf) {
  const sauber = {};
  let entfernt = 0;

  for (const name in verlauf) {
    const liste = verlauf[name];
    if (!Array.isArray(liste)) {
      sauber[name] = liste;
      continue;
    }

    const gruppen = new Map();
    for (const verkauf of liste) {
      const schluessel = `${verkauf?.seller ?? ''}\u0000${itemVariante(verkauf?.item)}`;
      if (!gruppen.has(schluessel)) gruppen.set(schluessel, []);
      gruppen.get(schluessel).push(verkauf);
    }

    const behalten = [];
    for (const gruppe of gruppen.values()) {
      gruppe.sort((a, b) => verkaufsZeit(a) - verkaufsZeit(b));
      let letzte = gruppe[0];
      for (let i = 1; i < gruppe.length; i++) {
        if (istFortsetzung(letzte, gruppe[i])) entfernt++;
        else behalten.push(letzte);
        letzte = gruppe[i];
      }
      behalten.push(letzte);
    }

    sauber[name] = behalten;
  }

  return { verlauf: sauber, entfernt };
}

// ── Der Index selbst ─────────────────────────────────────────────────

/** Tagesstempel in UTC, wie ihn auch die Verkäufe tragen. */
function tagVon(zeit) {
  return new Date(zeit).toISOString().slice(0, 10);
}

function mittel(zahlen) {
  return Math.round(zahlen.reduce((s, z) => s + z, 0) / zahlen.length);
}

/**
 * Baut die Zusammenfassung aus dem rohen Verlauf.
 *
 * jetzt ist überschreibbar, damit der Test mit festen Daten arbeiten
 * kann statt mit der Uhr des Rechners.
 */
function baueIndex(rohVerlauf, jetzt = Date.now()) {
  const { verlauf, entfernt } = verlaufEntdoppeln(rohVerlauf || {});
  const grenze = jetzt - TAGE * 24 * 60 * 60 * 1000;

  const items = {};
  const spieler = {};

  // ein, aus, verkauft, gewonnen — und an fünfter Stelle der Spielername,
  // sobald namen.js ihn aufgelöst hat. Der hängt hier und nicht in einer
  // eigenen Liste, weil die UUID sonst ein zweites Mal in der Datei
  // stünde: 350 KB nur für Schlüssel, die schon da sind.
  const konto = (uuid) => {
    if (!spieler[uuid]) spieler[uuid] = [0, 0, 0, 0];
    return spieler[uuid];
  };

  for (const name in verlauf) {
    const liste = verlauf[name];
    if (!Array.isArray(liste)) continue;

    // Nach Variante trennen: "Bohrer V3" gibt es als Sammelkarte aus
    // Papier und als Netherit-Spitzhacke — Faktor 1500 im Preis. Ein
    // gemeinsamer Durchschnitt wäre für beide falsch.
    const nachVariante = new Map();

    for (const verkauf of liste) {
      const zeit = verkaufsZeit(verkauf);
      const preis = Math.round(salePricePerUnit(verkauf));

      // Die Spielerbilanz zählt den ganzen Verlauf, nicht nur 30 Tage:
      // Sie beantwortet "wie viel hat jemand insgesamt umgesetzt".
      if (verkauf.seller) {
        const k = konto(verkauf.seller);
        k[0] += verkauf.finalPrice ?? verkauf.currentBid ?? 0;
        k[2] += 1;
      }
      if (verkauf.highestBidder) {
        const k = konto(verkauf.highestBidder);
        k[1] += verkauf.finalPrice ?? verkauf.currentBid ?? 0;
        k[3] += 1;
      }

      if (zeit < grenze) continue;

      const schluessel = itemVariante(verkauf.item);
      if (!nachVariante.has(schluessel)) {
        nachVariante.set(schluessel, {
          m: verkauf.item?.material ?? '',
          v: variantenLabel(verkauf.item),
          preise: [],
          tage: new Map(),
        });
      }
      const eintrag = nachVariante.get(schluessel);
      eintrag.preise.push(preis);

      const tag = tagVon(zeit);
      if (!eintrag.tage.has(tag)) eintrag.tage.set(tag, []);
      eintrag.tage.get(tag).push(preis);
    }

    const eintraege = [];
    for (const e of nachVariante.values()) {
      if (!e.preise.length) continue;
      const tage = {};
      for (const [tag, preise] of [...e.tage].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        tage[tag] = [preise.length, mittel(preise)];
      }
      eintraege.push({
        m: e.m,
        v: e.v,
        n: e.preise.length,
        d: mittel(e.preise),
        min: Math.min(...e.preise),
        max: Math.max(...e.preise),
        t: tage,
      });
    }

    // Die häufigste Variante zuerst: Wer den Namen eingibt, meint fast
    // immer die, die es am häufigsten gibt.
    eintraege.sort((a, b) => b.n - a.n);
    if (eintraege.length) items[name] = eintraege;
  }

  // Konten ohne Umsatz tragen nichts bei und würden die Datei nur füllen.
  for (const uuid of Object.keys(spieler)) {
    const k = spieler[uuid];
    if (k[2] === 0 && k[3] === 0) delete spieler[uuid];
    else {
      k[0] = Math.round(k[0]);
      k[1] = Math.round(k[1]);
    }
  }

  return {
    index: {
      erstellt: new Date(jetzt).toISOString(),
      tage: TAGE,
      items,
      spieler,
    },
    entdoppelt: entfernt,
  };
}

module.exports = {
  baueIndex,
  // Für den Test und für alle, die die Logik gegen die Website halten wollen.
  salePricePerUnit,
  itemVariante,
  variantenLabel,
  verkaufsZeit,
  istFortsetzung,
  verlaufEntdoppeln,
};

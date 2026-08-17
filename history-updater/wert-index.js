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
// salePricePerUnit, loreAlsText, verzauberungsStempel, itemVariante,
// verzauberungsNamen, stufenZeichen, verzauberungName,
// verzauberungenListe, variantenLabel, verkaufsZeit, istFortsetzung,
// verlaufEntdoppeln.
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

/**
 * Verzauberungen als sortierte Kette, z.B. "efficiency=5,mending=1".
 *
 * Sortiert, weil die Reihenfolge im JSON nicht verlässlich ist — sonst
 * bekäme derselbe Gegenstand je nach Laune der API zwei Schlüssel. Der
 * Namensraum "minecraft:" fällt weg, er steht vor jedem Eintrag.
 */
function verzauberungsStempel(item) {
  const roh = item?.enchantments;
  if (!roh || typeof roh !== 'object') return '';
  return Object.entries(roh)
    .map(([k, v]) => `${String(k).split(':').pop()}=${v}`)
    .sort()
    .join(',');
}

/**
 * Stabiler Schlüssel einer Variante; \u0000 kommt in keinem Feld vor.
 *
 * Die Verzauberungen standen hier einmal ausdrücklich nicht drin, mit der
 * Begründung, sie würden die Gruppen zersplittern. Die Zahlen sagen etwas
 * anderes: 183 Gruppen mit 5.874 Verkäufen lagen dadurch in einem
 * gemeinsamen Durchschnitt, in 18 davon weicht der Schnitt um Faktor 2
 * bis 15 ab ("Normaler ★ Helm": 274 Verkäufe von Ø 25 Tsd bis Ø 155 Tsd).
 * Und zersplittert wird nichts — die Varianten steigen von 3.278 auf
 * 3.908, die tragfähigen mit mindestens fünf Verkäufen aber von 1.268 auf
 * 1.275.
 */
function itemVariante(item) {
  return `${item?.material ?? ''}\u0000${loreAlsText(item)}\u0000${verzauberungsStempel(item)}`;
}

function materialLesbar(material) {
  return String(material || '')
    .toLowerCase()
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

const verzauberungsNamen = {
  aqua_affinity: 'Wasseraffinität', bane_of_arthropods: 'Nemesis der Gliederfüßer',
  binding_curse: 'Fluch der Bindung', blast_protection: 'Explosionsschutz',
  breach: 'Bruch', channeling: 'Entladung', density: 'Wucht',
  depth_strider: 'Tiefenläufer', efficiency: 'Effizienz', feather_falling: 'Federfall',
  fire_aspect: 'Verbrennung', fire_protection: 'Feuerschutz', flame: 'Flamme',
  fortune: 'Glück', frost_walker: 'Eisläufer', impaling: 'Harpune',
  infinity: 'Unendlichkeit', knockback: 'Rückstoß', looting: 'Plünderung',
  loyalty: 'Treue', luck_of_the_sea: 'Glück des Meeres', lure: 'Köder',
  mending: 'Reparatur', multishot: 'Mehrfachschuss', piercing: 'Durchdringung',
  power: 'Stärke', projectile_protection: 'Geschossschutz', protection: 'Schutz',
  punch: 'Schlag', quick_charge: 'Schnellladen', respiration: 'Atmung',
  riptide: 'Sog', sharpness: 'Schärfe', silk_touch: 'Behutsamkeit',
  smite: 'Bann', soul_speed: 'Seelenläufer', sweeping_edge: 'Schwungkraft',
  swift_sneak: 'Schleicher', thorns: 'Dornen', unbreaking: 'Haltbarkeit',
  vanishing_curse: 'Fluch des Verschwindens', wind_burst: 'Windstoß',
};

const ROEMISCH = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

/* Minecraft schreibt Stufen römisch — aber nur bis zehn. Auf OPSUCHT gibt es
   Haltbarkeit 160, und "CLX" liest niemand. */
function stufenZeichen(stufe) {
  const n = Number(stufe);
  return n >= 1 && n <= 10 ? ROEMISCH[n] : String(stufe);
}

function verzauberungName(schluessel) {
  const ohneRaum = String(schluessel).split(':').pop();
  if (verzauberungsNamen[ohneRaum]) return verzauberungsNamen[ohneRaum];
  // Unbekannt: wenigstens lesbar machen, statt den rohen Schlüssel zu zeigen
  return ohneRaum
    .split('_')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

/** ["Behutsamkeit III", "Haltbarkeit 160"] — stärkste Verzauberung zuerst. */
function verzauberungenListe(item) {
  const roh = item?.enchantments;
  if (!roh || typeof roh !== 'object') return [];

  return Object.entries(roh)
    .sort((a, b) => Number(b[1]) - Number(a[1]))
    .map(([schluessel, stufe]) => `${verzauberungName(schluessel)} ${stufenZeichen(stufe)}`);
}

/**
 * Kurzes Unterscheidungsmerkmal, wenn zwei Dinge gleich heißen.
 *
 * Seltenheit und Verzauberungen stehen mit drin, weil zwei Ausführungen
 * ohne das nicht zu unterscheiden waren: Die Knochenspitzhacke gibt es
 * als "Episch" für Ø 220 Tsd und als "Jackpot" für Ø 5,5 Mio, und beide
 * fielen auf "Netherite Pickaxe" zurück.
 *
 * mitVerzauberungen gibt es für die Auktionskarten der Website — dort
 * stehen sie schon als eigene Abzeichen darunter. Der Index braucht sie,
 * deshalb ist die Vorgabe true.
 */
function variantenLabel(item, { mitVerzauberungen = true } = {}) {
  const lore = loreAlsText(item);
  const teile = [];

  const typ = lore.match(/Gewinntyp\s*»\s*(.+)/);
  if (typ && typ[1].trim() && typ[1].trim() !== 'Item') teile.push(typ[1].trim());

  const selten = lore.match(/Seltenheit\s*»\s*(.+)/);
  if (selten && selten[1].trim()) teile.push(selten[1].trim());

  const zustand = lore.match(/Zustand:\s*(\S+)/);
  if (zustand) teile.push(zustand[1]);

  if (mitVerzauberungen) {
    const verzauberungen = verzauberungenListe(item);
    if (verzauberungen.length) teile.push(verzauberungen.join(', '));
  }

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
 * Die reinen Beschreibungszeilen der Lore.
 *
 * Ohne die Angaben mit Doppelpunkt oder » — die stecken schon im Etikett —
 * und ohne Zierlinien. Übrig bleibt der Fließtext, der bei manchen Items
 * das Einzige ist, was zwei Ausführungen unterscheidet.
 */
function beschreibungsZeilen(item) {
  return loreAlsText(item)
    .split('\n')
    .map((z) => z.trim())
    .filter((z) => z && !/[»:]\s/.test(z) && !/^[─—\-_=]+$/.test(z));
}

/** Höchstens so lang wird ein Zusatz — Discord nimmt 100 Zeichen im Ganzen. */
const ZUSATZ_MAX = 34;

/**
 * Gleich benannten Einträgen einen Zusatz geben, der sie unterscheidet.
 *
 * Warum das hier steht und nicht in variantenLabel(): Es braucht die
 * ganze Gruppe. "Gray Bundle" gibt es zweimal — einmal "Enthält 1
 * Boosterpack aus der Season of Summer" (Ø 191 Tsd), einmal "aus der
 * Redstone Season" (Ø 125 Tsd). Erst im Vergleich zeigt sich, welche
 * Zeile den Unterschied macht; für sich allein betrachtet ist jede
 * Beschreibung gleich unauffällig. variantenLabel bleibt deshalb eine
 * reine Funktion eines Items — es ist der Teil, den die Website teilt.
 *
 * Damit bleiben von 419 Namen mit mehreren Varianten noch 66 (16 %)
 * doppeldeutig benannt, vorher waren es drei Viertel. Der Rest lässt sich
 * nicht benennen: Dort sind Material, Lore-Text und Verzauberungen gleich,
 * und getrennt werden die Einträge nur durch eine Eigenheit der API — ein
 * doppelt aufgenommener "Gewinntyp »"-Block, ein Leerzeichen zu viel.
 * H4CKER.exe etwa steht so zweimal da, mit Ø 257.710 und Ø 257.520; dass
 * die Schnitte fast gleich sind, sagt schon, dass es dasselbe Item ist.
 * Unterscheidbar bleiben sie im Auswahlmenü über die Zeile darunter, die
 * Verkaufszahl und Durchschnitt nennt.
 *
 * Ändert die Einträge an Ort und Stelle.
 */
function unterscheideEtiketten(eintraege) {
  const nachEtikett = new Map();
  for (const e of eintraege) {
    if (!nachEtikett.has(e.v)) nachEtikett.set(e.v, []);
    nachEtikett.get(e.v).push(e);
  }

  for (const gruppe of nachEtikett.values()) {
    if (gruppe.length < 2) continue;

    // Zeilen, die alle teilen, unterscheiden nichts.
    const zaehler = new Map();
    for (const e of gruppe) {
      for (const zeile of new Set(e.beschreibung ?? [])) {
        zaehler.set(zeile, (zaehler.get(zeile) ?? 0) + 1);
      }
    }

    for (const e of gruppe) {
      const eigen = (e.beschreibung ?? []).filter((z) => zaehler.get(z) < gruppe.length);
      if (!eigen.length) continue;

      let zusatz = eigen.join(' ');
      if (zusatz.length > ZUSATZ_MAX) zusatz = `${zusatz.slice(0, ZUSATZ_MAX - 1).trimEnd()}…`;
      e.v = `${e.v} · ${zusatz}`;
    }
  }
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
          // Der Verzauberungsstempel wandert mit in die Datei. Nur damit
          // kann der Bot eine laufende Auktion der richtigen Variante
          // zuordnen — sonst vergleicht der Schnäppchen-Alarm eine
          // schlicht verzauberte Spitzhacke mit dem Schnitt der gut
          // verzauberten und meldet einen Rabatt, den es nicht gibt.
          e: verzauberungsStempel(verkauf.item),
          beschreibung: beschreibungsZeilen(verkauf.item),
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
        e: e.e,
        n: e.preise.length,
        d: mittel(e.preise),
        min: Math.min(...e.preise),
        max: Math.max(...e.preise),
        t: tage,
        beschreibung: e.beschreibung,
      });
    }

    // Die häufigste Variante zuerst: Wer den Namen eingibt, meint fast
    // immer die, die es am häufigsten gibt.
    eintraege.sort((a, b) => b.n - a.n);
    unterscheideEtiketten(eintraege);
    for (const e of eintraege) delete e.beschreibung;
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
  verzauberungsStempel,
  itemVariante,
  verzauberungenListe,
  variantenLabel,
  verkaufsZeit,
  istFortsetzung,
  verlaufEntdoppeln,
  unterscheideEtiketten,
  beschreibungsZeilen,
};

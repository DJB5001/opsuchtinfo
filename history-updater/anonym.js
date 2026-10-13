// =====================================================================
// Keine Spielerdaten im Repo
// =====================================================================
// Dieses Repo ist öffentlich, und alles, was hier landet, bleibt in der
// Historie. Bis zum 13.10.2026 stand in jedem Verkauf die UUID des
// Verkäufers und jedes Bieters, dazu eine Liste UUID -> Name. Daraus ließ
// sich für jeden Spieler ablesen, was er wann wofür gekauft und verkauft
// hat. Gebraucht wird das für die Itemwerte nicht.
//
// Deshalb läuft jede Auktion durch diese Datei, bevor irgendetwas sie
// speichert:
//
//  - Verkäufer und Bieter werden zu einem Kürzel. Das Kürzel ist ein
//    HMAC über die UUID mit einem Schlüssel, der nur als Actions-Secret
//    existiert (ANONYM_SCHLUESSEL). Ohne ihn lässt sich aus dem Kürzel
//    nicht auf den Spieler schließen. Ganz weglassen geht nicht: Die
//    Entdopplung verlängerter Auktionen (verlaufEntdoppeln in
//    wert-index.js, gut 16 % aller Einträge) erkennt dieselbe Auktion an
//    Verkäufer und Bieterschaft.
//
//  - Zeilen, die einen Gegenstand einer Person zuschreiben, werden
//    geschwärzt: "Signiert von …", "Inhaber: …", "Bestimmt für …". Das
//    sind gemessen fast alle Stellen, an denen Spielernamen in der Lore
//    stehen. Die Signatur des Servers ("Signiert von OPSUCHT") bleibt, sie
//    ist eine Eigenschaft des Gegenstands. Item-Namen wie "… Traumpicke"
//    bleiben ebenfalls: Das sind Produktnamen, und über genau diesen Namen
//    findet die Mod den Gegenstand.
//
//  - Vor dem Schwärzen wird der Variantenschlüssel k aus der echten Lore
//    berechnet und am Item gespeichert. Die Mod rechnet k aus dem
//    Gegenstand im Inventar, mit dem echten Namen in der Signatur, und muss
//    dieselbe Zeile im Index finden.
//
//  - Gesperrte Spieler (Actions-Secret GESPERRT) fallen ganz heraus: Ihre
//    Auktionen werden nicht gespeichert, ihre Gebote auf fremden Auktionen
//    stehen als "ausgeblendet", ihr Name verschwindet aus allen Texten.
//    Wer verlangt, nicht erfasst zu werden, kommt dort hinein, nie in eine
//    Datei im Repo.
// =====================================================================

const crypto = require('crypto');
const { itemVariante, variantenSchluessel } = require('./wert-index.js');

/** Steht an der Stelle eines gesperrten Bieters. */
const AUSGEBLENDET = 'ausgeblendet';

/** Steht an der Stelle eines geschwärzten Namens. */
const GESCHWAERZT = '***';

/** Die Signatur des Servers selbst — keine Person. */
const SERVER = 'OPSUCHT';

/** UUIDs vergleichen ohne Schreibweise und Bindestriche. */
const uuidForm = (uuid) => String(uuid ?? '').trim().toLowerCase().replace(/-/g, '');
const namensForm = (name) => String(name ?? '').trim().replace(/^\.+/, '').toLowerCase();

/** Wie eine Minecraft-UUID aussieht, mit oder ohne Bindestriche. */
const UUID_MUSTER = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Lore-Zeilen, die einen Gegenstand einer Person zuschreiben.
 *
 * Jeweils: was davor steht, der Name, was danach kommt (Datum, Zierrat).
 * Der Name endet vor " am <Datum>" oder vor Zeichen, die in keinem
 * Spielernamen vorkommen — so bleibt "♦ Signiert von X am 01.01.2026 ♦"
 * bis auf den Namen erhalten.
 */
const ZUSCHREIBUNGEN = [
  /^(.*?Signiert von\s+)(.+?)((?:\s+am\s+\d{1,2}\.\d{1,2}\.\d{2,4})?[^\p{L}\p{N}._]*)$/iu,
  /^(.*?Inhaber:\s*)(.+?)([^\p{L}\p{N}._]*)$/iu,
  /^(.*?Bestimmt für\s+)(.+?)([^\p{L}\p{N}._]*)$/iu,
];

function schwaerzeZeile(zeile) {
  for (const muster of ZUSCHREIBUNGEN) {
    const treffer = zeile.match(muster);
    if (!treffer) continue;
    const [, davor, name, danach] = treffer;
    if (name.trim().toUpperCase() === SERVER) return zeile;
    return `${davor}${GESCHWAERZT}${danach}`;
  }
  return zeile;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Baut die Anonymisierung für einen Lauf.
 *
 * schluessel: der HMAC-Schlüssel. Fehlt er, wirft die Funktion — lieber
 *             kein Lauf als einer, der Klar-UUIDs schreibt.
 * gesperrt:   "Name:UUID,Name,…" wie im Secret GESPERRT. Namen ohne UUID
 *             löst loeseAuf() nach.
 */
function erstelle({ schluessel, gesperrt = '' } = {}) {
  if (!schluessel || String(schluessel).trim().length < 16) {
    throw new Error(
      'ANONYM_SCHLUESSEL fehlt oder ist zu kurz. Ohne ihn würden Spieler-UUIDs im Klartext ' +
        'gespeichert, deshalb läuft der Updater nicht.'
    );
  }

  const spieler = String(gesperrt)
    .split(',')
    .map((eintrag) => eintrag.trim())
    .filter(Boolean)
    .map((eintrag) => {
      const [name, uuid] = eintrag.split(':').map((teil) => (teil ?? '').trim());
      return { name, uuid: uuid || null };
    })
    .filter((s) => s.name || s.uuid);

  const gesperrteUuids = new Set(spieler.filter((s) => s.uuid).map((s) => uuidForm(s.uuid)));
  const namen = spieler.map((s) => s.name).filter(Boolean);
  const namensMuster = namen.length
    ? new RegExp(namen.map((n) => escape(n.replace(/^\.+/, ''))).join('|'), 'gi')
    : null;

  const istGesperrt = (uuid) => gesperrteUuids.has(uuidForm(uuid));

  /** Das Kürzel für eine UUID. Gleiche UUID, gleiches Kürzel — solange der Schlüssel gleich bleibt. */
  function kuerzel(uuid) {
    if (uuid == null || uuid === '') return uuid;
    if (istGesperrt(uuid)) return AUSGEBLENDET;
    return crypto.createHmac('sha256', String(schluessel)).update(uuidForm(uuid)).digest('hex').slice(0, 12);
  }

  /** Ein Text ohne zugeschriebene Namen und ohne Gesperrte. */
  function text(wert) {
    if (typeof wert !== 'string') return wert;
    let sauber = wert
      .split('\n')
      .map(schwaerzeZeile)
      .join('\n');
    if (namensMuster) sauber = sauber.replace(namensMuster, GESCHWAERZT);
    return sauber;
  }

  /** Das Item: k aus der echten Lore, dann geschwärzt. */
  function item(roh) {
    if (!roh || typeof roh !== 'object') return roh;
    const neu = { ...roh };
    // Einmal berechnet, bleibt k. Ein zweites Mal aus der schon
    // geschwärzten Lore gerechnet, passte es nicht mehr zur Mod.
    if (!neu.k) neu.k = variantenSchluessel(itemVariante(roh));
    if (Array.isArray(roh.lore)) neu.lore = roh.lore.map(text);
    else if (typeof roh.lore === 'string') neu.lore = text(roh.lore);
    if (typeof roh.displayName === 'string') neu.displayName = text(roh.displayName);
    return neu;
  }

  /** Gebote mit Kürzeln statt UUIDs. Treffen zwei Gesperrte zusammen, zählt das höhere. */
  function gebote(roh) {
    if (!roh || typeof roh !== 'object') return roh ?? {};
    const neu = {};
    for (const [uuid, betrag] of Object.entries(roh)) {
      const k = kuerzel(uuid);
      if (neu[k] === undefined || Number(betrag) > Number(neu[k])) neu[k] = betrag;
    }
    return neu;
  }

  /**
   * Eine Auktion oder ein Verkauf, so wie er gespeichert werden darf.
   * null, wenn der Verkäufer gesperrt ist.
   */
  function auktion(roh) {
    if (!roh || typeof roh !== 'object') return null;
    if (istGesperrt(roh.seller)) return null;

    const neu = { ...roh, seller: kuerzel(roh.seller), bids: gebote(roh.bids), item: item(roh.item) };
    if ('highestBidder' in roh) neu.highestBidder = kuerzel(roh.highestBidder);
    return neu;
  }

  /** Welche Gesperrten noch keine UUID haben. */
  const ohneUuid = () => spieler.filter((s) => !s.uuid && s.name);

  /**
   * Fehlende UUIDs nachschlagen (playerdb, dann ashcon).
   *
   * Gibt nur Zahlen zurück, nie Namen: Das Protokoll einer Action in
   * einem öffentlichen Repo kann jeder lesen.
   */
  async function loeseAuf(holen = fetch) {
    let aufgeloest = 0;
    for (const s of ohneUuid()) {
      const uuid = await suche(s.name, holen);
      if (!uuid) continue;
      s.uuid = uuid;
      gesperrteUuids.add(uuidForm(uuid));
      aufgeloest += 1;
    }
    return { aufgeloest, offen: ohneUuid().length };
  }

  return { auktion, kuerzel, text, item, gebote, istGesperrt, loeseAuf, anzahlGesperrt: spieler.length };
}

async function suche(name, holen) {
  const sauber = encodeURIComponent(String(name).replace(/^\.+/, ''));
  const quellen = [
    [`https://playerdb.co/api/player/minecraft/${sauber}`, (d) => (d?.success ? d.data?.player?.id : null)],
    [`https://api.ashcon.app/mojang/v2/user/${sauber}`, (d) => d?.uuid ?? null],
  ];
  for (const [adresse, lies] of quellen) {
    try {
      const antwort = await holen(adresse, {
        headers: { 'User-Agent': 'opsucht-history-updater' },
        signal: AbortSignal.timeout(10_000),
      });
      if (!antwort.ok) continue;
      const uuid = lies(await antwort.json());
      if (uuid) return uuid;
    } catch {
      // Nächste Quelle.
    }
  }
  return null;
}

/**
 * Steht irgendwo in diesen Daten noch etwas, das wie eine Spieler-UUID
 * aussieht? Für die Prüfung vor dem Schreiben und für die Tests.
 */
function enthaeltUuid(daten) {
  return UUID_MUSTER.test(typeof daten === 'string' ? daten : JSON.stringify(daten));
}

module.exports = { erstelle, enthaeltUuid, schwaerzeZeile, AUSGEBLENDET, GESCHWAERZT, UUID_MUSTER };

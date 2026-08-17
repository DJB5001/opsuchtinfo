// =====================================================================
// Händlernamen
// =====================================================================
// Der Wert-Index kennt knapp siebentausend Händler, aber nur ihre UUIDs.
// Für /spieler im Discord soll man Namen tippen können — dafür müssen
// die UUIDs aufgelöst werden.
//
// Namen gibt es nur einzeln abzufragen. Alle auf einmal wären knapp
// siebentausend Anfragen an kostenlose Dienste, bei jedem Lauf aufs
// Neue. Also nach und nach: je Lauf ein kleines Häppchen, die
// umsatzstärksten zuerst, und was einmal aufgelöst ist, bleibt stehen.
//
// Bei einem Lauf alle 15 Minuten ist der ganze Bestand nach gut einem
// Tag beisammen. Die Namen, nach denen tatsächlich gefragt wird, sind
// nach der ersten Stunde da.
//
//
// Warum hier Code aus dem Bot steht
// ---------------------------------
// Die Auflösung ist aus DNV-Bot/src/opsucht.js übernommen (javaName
// Zeile 89, bedrockName Zeile 112). Dieselben Dienste in derselben
// Reihenfolge — sonst nennt der Index einen anderen Namen als der Bot,
// wenn er selbst nachfragt, und niemand wüsste, welcher stimmt.
// =====================================================================

const fs = require('fs');
const path = require('path');

const NAMEN_FILE = path.join(__dirname, 'namen.json');

/** Je Lauf. Klein genug, dass ein Lauf nicht daran hängen bleibt. */
const JE_LAUF = 50;

/** Namen ändern sich selten — öfter nachzufragen wäre nur Last. */
const HALTBAR_TAGE = 30;

/**
 * Nach einem Fehlversuch nicht sofort wieder. Sonst blockiert dieselbe
 * gelöschte UUID jeden Lauf das Häppchen und die dahinter kommen nie dran.
 */
const NEUER_VERSUCH_TAGE = 3;

/** Zwischen zwei Anfragen. Nacheinander, nicht alle gleichzeitig. */
const PAUSE_MS = 120;

/** Je Anfrage. */
const ZEIT_LIMIT_MS = 5000;

/**
 * Und für das Häppchen insgesamt.
 *
 * Im Normalfall braucht ein Lauf ein paar Sekunden. Fällt aber ein Dienst
 * aus, läuft jede Anfrage in ihr Zeitlimit — bei Java zweimal, weil ein
 * zweiter Dienst versucht wird. Fünfzig davon wären über acht Minuten,
 * und der Updater läuft alle fünfzehn. Dann stauen sich die Läufe, und
 * der Auktionsverlauf — die eigentliche Aufgabe — käme zu spät.
 *
 * Also Schluss nach anderthalb Minuten. Was übrig bleibt, ist beim
 * nächsten Lauf dran; es hat ja niemand Eile.
 */
const ZEIT_BUDGET_MS = 90_000;

const warte = (ms) => new Promise((r) => setTimeout(r, ms));
const tage = (n) => n * 24 * 60 * 60 * 1000;

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

async function holeJson(url) {
  const antwort = await fetch(url, {
    headers: { 'User-Agent': 'opsucht-history-updater' },
    signal: AbortSignal.timeout(ZEIT_LIMIT_MS),
  });
  if (!antwort.ok) throw new Error('HTTP ' + antwort.status);
  return antwort.json();
}

/** Bedrock-Spieler kommen über Geyser und haben eine UUID aus lauter Nullen. */
function istBedrockUuid(uuid) {
  return String(uuid).startsWith('00000000-0000-0000-');
}

// ── Aus DNV-Bot/src/opsucht.js ───────────────────────────────────────

async function javaName(uuid) {
  try {
    const daten = await holeJson(`https://playerdb.co/api/player/minecraft/${uuid}`);
    if (daten?.success && daten.data?.player?.username) return daten.data.player.username;
  } catch (e) {
    // Kein Grund zu lärmen: Der zweite Dienst kommt gleich.
  }

  try {
    const daten = await holeJson(`https://api.ashcon.app/mojang/v2/user/${uuid}`);
    if (daten?.username) return daten.username;
  } catch (e) {
    /* siehe oben */
  }

  return null;
}

/**
 * In der Bedrock-UUID steckt die Xbox-ID (XUID) als Hexzahl in den letzten
 * beiden Blöcken. Daraus wird der Gamertag geholt; auf OPSucht steht davor
 * noch ein Punkt, so wie es Geyser auf dem Server vergibt.
 */
async function bedrockName(uuid) {
  try {
    const hex = String(uuid).substring(19).replace(/-/g, '');
    const xuid = BigInt('0x' + hex).toString();

    const daten = await holeJson(`https://api.geysermc.org/v2/xbox/gamertag/${xuid}`);
    if (daten?.gamertag) return `.${daten.gamertag}`;
  } catch (e) {
    /* nicht auflösbar, wird vermerkt */
  }
  return null;
}

async function loeseAuf(uuid) {
  return istBedrockUuid(uuid) ? bedrockName(uuid) : javaName(uuid);
}

// ── Der Bestand ──────────────────────────────────────────────────────

/**
 * Was in namen.json steht:
 *
 *   { "<uuid>": { n: "Name", z: <ms> }         aufgelöst
 *   { "<uuid>": { n: null,   z: <ms> }         noch nie aufgelöst
 *   { "<uuid>": { n: "Name", z: <ms>, f: 1 }   alter Name, letzter Versuch scheiterte
 *
 * z ist der Zeitpunkt des letzten Versuchs. Er entscheidet, wann wieder
 * gefragt wird — bei Erfolg nach 30 Tagen, sonst nach dreien.
 */
function laden(datei) {
  const roh = readJson(datei, {});
  return roh && typeof roh === 'object' ? roh : {};
}

function speichern(datei, bestand) {
  fs.writeFileSync(datei, JSON.stringify(bestand, null, 0));
}

/** Ist der Eintrag noch gut genug, um ihn nicht neu zu holen? */
function frisch(eintrag, jetzt) {
  if (!eintrag || typeof eintrag.z !== 'number') return false;
  // Ein Name, dessen Auffrischung gescheitert ist, gilt als offen: Er
  // wird weiter benutzt, aber früher wieder geprüft als ein bestätigter.
  const haltbar = eintrag.n && !eintrag.f ? tage(HALTBAR_TAGE) : tage(NEUER_VERSUCH_TAGE);
  return jetzt - eintrag.z < haltbar;
}

/**
 * Wer ist als Nächstes dran?
 *
 * Nach Umsatz, weil danach gesucht wird: Wer viel handelt, wird im Chat
 * genannt. Der Index hat die Zahlen schon — spieler[uuid] ist
 * [eingenommen, ausgegeben, verkauft, gewonnen].
 */
function offeneUuids(spieler, bestand, jetzt, hoechstens) {
  return Object.entries(spieler || {})
    .filter(([uuid]) => !frisch(bestand[uuid], jetzt))
    .sort((a, b) => b[1][0] + b[1][1] - (a[1][0] + a[1][1]))
    .slice(0, hoechstens)
    .map(([uuid]) => uuid);
}

/**
 * Ein Häppchen auflösen und den Bestand zurückgeben.
 *
 * Nichts hier darf den Lauf abbrechen. Der Verlauf ist die eigentliche
 * Aufgabe des Updaters; Namen sind eine Zugabe, und eine Zugabe, die den
 * Rest mitreißt, ist keine.
 *
 * Die Einsprünge (holen, jetzt, jeLauf, datei, pauseMs) gibt es für den
 * Test: Er soll ohne Netz, ohne die Uhr des Rechners und ohne den
 * echten Bestand im Repo auskommen.
 */
async function ergaenzeNamen(
  spieler,
  {
    holen = loeseAuf,
    jetzt = Date.now(),
    jeLauf = JE_LAUF,
    datei = NAMEN_FILE,
    pauseMs = PAUSE_MS,
    budgetMs = ZEIT_BUDGET_MS,
    uhr = () => Date.now(),
  } = {}
) {
  const bestand = laden(datei);
  const offen = offeneUuids(spieler, bestand, jetzt, jeLauf);

  const start = uhr();
  let neu = 0;
  let leer = 0;
  let versucht = 0;
  let abgebrochen = false;

  for (const uuid of offen) {
    if (budgetMs && uhr() - start >= budgetMs) {
      abgebrochen = true;
      break;
    }
    versucht++;

    let name = null;
    try {
      name = await holen(uuid);
    } catch (e) {
      // Ein Ausfall betrifft diese eine UUID, nicht den Lauf.
      name = null;
    }

    if (name) {
      bestand[uuid] = { n: name, z: jetzt };
      neu++;
    } else {
      // Ein Aussetzer bei einem fremden Dienst darf keinen Namen kosten,
      // den wir schon hatten. Der alte bleibt stehen und wird nur eher
      // wieder geprüft — genau wie der Bot bei den Marktdaten lieber
      // einen alten Stand zeigt als gar keinen.
      const alt = bestand[uuid]?.n ?? null;
      bestand[uuid] = alt ? { n: alt, z: jetzt, f: 1 } : { n: null, z: jetzt };
      leer++;
    }

    if (pauseMs) await warte(pauseMs);
  }

  if (versucht) speichern(datei, bestand);

  // Nur die aufgelösten wandern weiter. Ein null im Index wäre ein
  // Eintrag, der nichts sagt und trotzdem Platz kostet.
  const namen = {};
  let bekannt = 0;
  for (const uuid of Object.keys(spieler || {})) {
    const eintrag = bestand[uuid];
    if (eintrag?.n) {
      namen[uuid] = eintrag.n;
      bekannt++;
    }
  }

  return {
    namen,
    bericht: {
      versucht,
      neu,
      leer,
      bekannt,
      gesamt: Object.keys(spieler || {}).length,
      offen: offen.length - versucht,
      abgebrochen,
    },
  };
}

module.exports = {
  ergaenzeNamen,
  // Für den Test.
  loeseAuf,
  offeneUuids,
  frisch,
  istBedrockUuid,
  JE_LAUF,
  HALTBAR_TAGE,
  NEUER_VERSUCH_TAGE,
  NAMEN_FILE,
};

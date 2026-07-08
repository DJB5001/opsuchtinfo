// =====================================================================
// OPSUCHT Shard-Verlauf Updater
// =====================================================================
// Läuft zusammen mit dem Auktions-Updater (alle 30 Min via GitHub Actions).
//
// Holt die aktuellen Shard-Wechselkurse und hängt einen Zeitstempel-
// Snapshot an shard-history.json an.
//
// Format (wie vom Frontend erwartet, siehe openChart(..., 'shards')):
//   { "<timestamp_ms>": [ { source, exchangeRate, ... }, ... ], ... }
// =====================================================================

const fs = require('fs');
const path = require('path');

const API_URL = 'https://api.opsucht.net/merchant/rates';
const SHARD_FILE = path.join(__dirname, '..', 'shard-history.json');

// Wie viele Zeit-Snapshots maximal behalten werden.
const MAX_SNAPSHOTS = 2000;

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return fallback; }
}
function writeJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 0));
}

async function main() {
  let rates;
  try {
    const res = await fetch(API_URL, { headers: { 'User-Agent': 'opsucht-history-updater' } });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    rates = await res.json();
  } catch (e) {
    console.error('Konnte Shard-Kurse nicht laden:', e.message);
    process.exit(0);
  }
  if (!Array.isArray(rates)) {
    console.error('Unerwartetes Shard-API-Format, breche ab.');
    process.exit(0);
  }

  const history = readJson(SHARD_FILE, {});
  const ts = String(Date.now());

  // Nur die relevanten Felder pro Kurs behalten
  history[ts] = rates.map(r => ({
    source: r.source,
    exchangeRate: r.exchangeRate
  }));

  // Auf Maximalgröße kürzen (älteste Zeitstempel zuerst raus)
  const keys = Object.keys(history).sort((a, b) => Number(a) - Number(b));
  if (keys.length > MAX_SNAPSHOTS) {
    for (const k of keys.slice(0, keys.length - MAX_SNAPSHOTS)) delete history[k];
  }

  writeJson(SHARD_FILE, history);
  console.log(`Shard-Snapshot gespeichert (${rates.length} Kurse).`);
}

main();

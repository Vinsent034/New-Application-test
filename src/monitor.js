const { searchItems } = require('./vinted');

// Solo parole che DA SOLE indicano certamente un accessorio (non la console/prodotto)
const NEGATIVE_KEYWORDS = [
  'custodia', 'joycon', 'joy-con', 'caricatore', 'charger',
  'pellicola', 'screen protector', 'amiibo',
];

// Parole che sono accessori SOLO se appaiono all'inizio del titolo
const NEGATIVE_START = [
  'gioco ', 'giochi ', 'cavo ', 'cavi ', 'controller ', 'cover ',
  'dock ', 'scheda ', 'accessori',
];

function isObviouslyIrrelevant(title) {
  const lower = title.toLowerCase();
  if (NEGATIVE_KEYWORDS.some((kw) => lower.includes(kw))) return true;
  if (NEGATIVE_START.some((kw) => lower.startsWith(kw))) return true;
  return false;
}

// Spezza ogni keyword in parole singole e verifica che almeno una sia nel titolo
function matchesKeywords(title, keywords) {
  const lower = title.toLowerCase();
  for (const kw of keywords) {
    const words = kw.toLowerCase().split(/\s+/).filter((w) => w.length > 2);
    if (words.some((w) => lower.includes(w))) return true;
  }
  return false;
}

const INTERVAL_MS = parseInt(process.env.MONITOR_INTERVAL_MS, 10) || 3 * 60 * 1000;

// Quante volte consecutive può fallire il fetch prima di notificare l'utente
const MAX_CONSECUTIVE_ERRORS = 3;

class Monitor {
  constructor(onMatch) {
    this.onMatch = onMatch;
    this.onError = null;       // callback(message) per notificare errori persistenti all'utente
    this.onTokenLimit = null;  // callback() per limite token raggiunto
    this.seenIds = new Set();
    this.searchConfig = null;
    this.timer = null;
    this.running = false;
    this.consecutiveErrors = 0;
  }

  start(searchConfig) {
    this.searchConfig = searchConfig;
    this.seenIds.clear();
    this.running = true;
    this.consecutiveErrors = 0;

    console.log(`[Monitor] Avvio: "${searchConfig.keywords.join(', ')}" | ${searchConfig.priceMin}€ - ${searchConfig.priceMax}€`);

    this._seedInitialIds()
      .then(() => {
        console.log(`[Monitor] Seed completato. Monitoro ogni ${INTERVAL_MS / 1000}s.`);
        this.timer = setInterval(() => this._tick(), INTERVAL_MS);
      })
      .catch((err) => {
        console.error('[Monitor] Errore seed:', err.message);
        if (this.onError) this.onError(`❌ Errore avvio monitoraggio: ${err.message}`);
        this.stop();
      });
  }

  stop() {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.seenIds.clear();
    this.searchConfig = null;
    console.log('[Monitor] Fermato.');
  }

  isRunning() { return this.running; }

  // Al seed registra gli ID E invia subito quelli che matchano i filtri
  async _seedInitialIds() {
    const items = await this._fetch();
    for (const item of items) this.seenIds.add(item.id);
    console.log(`[Monitor] ${items.length} annunci trovati al seed, valuto i match...`);
    if (items.length === 0) {
      console.warn('[Monitor] ATTENZIONE: 0 annunci trovati. Prova keywords più semplici.');
      return;
    }
    for (const item of items) {
      await this._evaluate(item);
    }
  }

  async _tick() {
    if (!this.running) return;
    console.log(`[Monitor] Scansione alle ${new Date().toLocaleTimeString('it-IT')}...`);

    let items;
    try {
      items = await this._fetch();
      this.consecutiveErrors = 0; // reset al successo
    } catch (err) {
      this.consecutiveErrors++;
      console.error(`[Monitor] Errore fetch Vinted (${this.consecutiveErrors}/${MAX_CONSECUTIVE_ERRORS}):`, err.message);

      if (this.consecutiveErrors >= MAX_CONSECUTIVE_ERRORS && this.onError) {
        this.onError(`⚠️ Vinted non raggiungibile da ${MAX_CONSECUTIVE_ERRORS} scansioni consecutive.\nRiprovo tra ${INTERVAL_MS / 60000} minuti.`);
        this.consecutiveErrors = 0; // reset per non spammare
      }
      return;
    }

    const newItems = items.filter((item) => !this.seenIds.has(item.id));
    if (newItems.length > 0) {
      console.log(`[Monitor] ${newItems.length} nuovi annunci trovati.`);
    }

    for (const item of newItems) {
      this.seenIds.add(item.id);
      await this._evaluate(item);
    }
  }

  async _fetch() {
    const { keywords, priceMin, priceMax, statusIds } = this.searchConfig;
    // Usa la keyword più corta: Vinted restituisce 0 risultati con frasi lunghe.
    // Il filtro post-fetch (matchesKeywords + isObviouslyIrrelevant) elimina i falsi positivi.
    const searchText = keywords.reduce((a, b) => a.length <= b.length ? a : b);
    console.log(`[Monitor] Ricerca Vinted: "${searchText}"`);
    return searchItems({
      searchText,
      priceFrom: priceMin,
      priceTo: priceMax,
      statusIds,
    });
  }

  async _evaluate(item) {
    const { keywords } = this.searchConfig;

    if (isObviouslyIrrelevant(item.title)) {
      console.log(`[Monitor] Scartato (accessorio): ${item.title}`);
      return;
    }

    if (!matchesKeywords(item.title, keywords)) {
      console.log(`[Monitor] Scartato (keyword assente): ${item.title}`);
      return;
    }

    try {
      await this.onMatch(item);
    } catch (err) {
      console.error('[Monitor] Errore invio notifica:', err.message);
    }
  }
}

module.exports = Monitor;

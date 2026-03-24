const axios = require('axios');

const VINTED_API = 'https://www.vinted.it/api/v2/catalog/items';
const VINTED_HOME = 'https://www.vinted.it';
const TIMEOUT_MS = 15000;

const HEADERS_BASE = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'application/json',
  'Accept-Language': 'it-IT,it;q=0.9',
  Referer: 'https://www.vinted.it/',
};

// Mappa condizioni Vinted (stringa) -> categorie interne
const STATUS_MAP = {
  'Nuovo con cartellino': 'nuovo_cartellino',
  'Nuovo':               'nuovo',
  'Ottime':              'ottime',
  'Ottime condizioni':   'ottime',
  'Buone':               'buone',
  'Buone condizioni':    'buone',
  'Soddisfacenti':       'accettabili',
  'Condizioni accettabili': 'accettabili',
  'Alla frutta':         'frutta',
};

function getStatusCategory(status) {
  if (!status) return 'sconosciuto';
  const key = Object.keys(STATUS_MAP).find(k => status.toLowerCase().includes(k.toLowerCase()));
  return key ? STATUS_MAP[key] : 'sconosciuto';
}

function getStatusLabel(status) {
  return status || 'Sconosciuto';
}

let cookieJar = null;
let cookieFetchedAt = null;
const COOKIE_TTL_MS = 30 * 60 * 1000; // rinnova dopo 30 minuti

function isCookieStale() {
  if (!cookieJar || !cookieFetchedAt) return true;
  return Date.now() - cookieFetchedAt > COOKIE_TTL_MS;
}

async function fetchCookies() {
  console.log('[Vinted] Ottengo cookie di sessione...');
  const res = await axios.get(VINTED_HOME, {
    headers: { ...HEADERS_BASE, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
    maxRedirects: 5,
    timeout: TIMEOUT_MS,
  });

  const setCookie = res.headers['set-cookie'] || [];
  const jar = {};
  for (const c of setCookie) {
    const match = c.match(/^([^=]+)=([^;]*)/);
    if (match) jar[match[1].trim()] = match[2].trim();
  }

  if (!jar['access_token_web'] && !jar['_vinted_fr_session']) {
    throw new Error('Nessun cookie di autenticazione trovato nella risposta della home');
  }

  cookieJar = jar;
  cookieFetchedAt = Date.now();
  console.log('[Vinted] Cookie ottenuti:', Object.keys(jar).join(', '));
}

async function ensureCookies() {
  if (isCookieStale()) {
    await fetchCookies();
  }
}

function buildCookieHeader() {
  return Object.entries(cookieJar)
    .map(([k, v]) => `${k}=${v}`)
    .join('; ');
}

async function searchItems({ searchText, priceFrom, priceTo, statusIds, page = 1 }) {
  await ensureCookies();

  // catalog_ids[] viene ignorato dall'API Vinted IT (restituisce sempre gli stessi risultati)
  // Il filtraggio per categoria avviene esclusivamente lato client dopo il fetch.
  const searchParams = new URLSearchParams();
  searchParams.set('search_text', searchText);
  searchParams.set('price_from', priceFrom);
  searchParams.set('price_to', priceTo);
  searchParams.set('per_page', '96');
  searchParams.set('page', String(page));
  searchParams.set('order', 'newest_first');
  if (statusIds?.length) {
    for (const id of statusIds) searchParams.append('status_ids[]', String(id));
  }

  const params = searchParams;

  const url = `${VINTED_API}?${params.toString()}`;
  console.log(`[Vinted] GET ${url}`);

  async function doRequest() {
    const response = await axios.get(url, {
      headers: { ...HEADERS_BASE, Cookie: buildCookieHeader() },
      timeout: TIMEOUT_MS,
    });
    return response;
  }

  try {
    let response = await doRequest();

    if (response.status === 401) {
      console.log('[Vinted] Cookie scaduto, rinnovo...');
      cookieJar = null;
      cookieFetchedAt = null;
      await fetchCookies();
      response = await doRequest();
    }

    const items = response.data.items || [];
    console.log(`[Vinted] Risposta: ${items.length} items | totale: ${response.data.pagination?.total_entries ?? '?'}`);
    return items.map(mapItem);
  } catch (err) {
    if (err.response?.status === 401) {
      console.log('[Vinted] Cookie scaduto, rinnovo...');
      cookieJar = null;
      cookieFetchedAt = null;
      await fetchCookies();
      const response = await doRequest();
      const items = response.data.items || [];
      return items.map(mapItem);
    }
    throw err;
  }
}

function mapItem(item) {
  const priceRaw = item.price?.amount ?? item.price;
  return {
    id: item.id,
    title: item.title,
    price: parseFloat(priceRaw) || 0,
    currency: item.price?.currency_code || 'EUR',
    status: getStatusLabel(item.status),
    statusCategory: getStatusCategory(item.status),
    description: item.description || '',
    url: `https://www.vinted.it/items/${item.id}`,
    photoUrl: item.photo?.url || item.photos?.[0]?.url || null,
    brandTitle: item.brand_title || '',
    size: item.size_title || '',
  };
}

module.exports = { searchItems };

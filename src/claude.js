require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const GROQ_API_URL = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL = 'llama-3.3-70b-versatile';
const DAILY_LIMIT = 500000;
const USAGE_FILE = path.join(__dirname, '..', 'token_usage.json');
const TIMEOUT_MS = 20000;

const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434/api/chat';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || null;

// ─── Token usage (solo per Groq) ─────────────────────────────────────────────

function loadUsage() {
  try {
    const data = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    if (data.date !== new Date().toISOString().slice(0, 10)) {
      return { date: new Date().toISOString().slice(0, 10), tokens: 0 };
    }
    return data;
  } catch {
    return { date: new Date().toISOString().slice(0, 10), tokens: 0 };
  }
}

function saveUsage(usage) {
  fs.writeFileSync(USAGE_FILE, JSON.stringify(usage), 'utf8');
}

function getTokenStats() {
  if (OLLAMA_MODEL) return { used: 0, limit: Infinity, remaining: Infinity, provider: 'ollama' };
  const usage = loadUsage();
  return { used: usage.tokens, limit: DAILY_LIMIT, remaining: DAILY_LIMIT - usage.tokens, provider: 'groq' };
}

function isTokenLimitReached() {
  if (OLLAMA_MODEL) return false;
  const { remaining } = getTokenStats();
  return remaining <= 0;
}

// ─── Chiamata AI (Groq o Ollama) ──────────────────────────────────────────────

// Groq: sempre usato per la disambiguazione iniziale (alta qualità, una volta sola)
// Ollama: usato per i filtri ripetuti durante il monitoraggio (gratuito, locale)
// Se OLLAMA_MODEL non è impostato, tutto va su Groq.

async function callAI(messages, { forceGroq = false } = {}) {
  if (OLLAMA_MODEL && !forceGroq) {
    return callOllama(messages);
  }
  return callGroq(messages);
}

async function callGroq(messages) {
  if (isTokenLimitReached()) {
    throw new Error('TOKEN_LIMIT_REACHED');
  }

  let response;
  try {
    response = await axios.post(
      GROQ_API_URL,
      { model: GROQ_MODEL, messages, temperature: 0.3 },
      {
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          'Content-Type': 'application/json',
        },
        timeout: TIMEOUT_MS,
      }
    );
  } catch (err) {
    if (err.code === 'ECONNABORTED') throw new Error('Timeout chiamata Groq API');
    if (err.response?.status === 429) throw new Error('Rate limit Groq raggiunto, riprova tra qualche secondo');
    if (err.response?.status === 401) throw new Error('GROQ_API_KEY non valida o scaduta');
    throw err;
  }

  const tokensUsed = response.data.usage?.total_tokens || 0;
  const usage = loadUsage();
  usage.tokens += tokensUsed;
  saveUsage(usage);

  return response.data.choices[0].message.content;
}

async function callOllama(messages) {
  let response;
  try {
    response = await axios.post(
      OLLAMA_URL,
      { model: OLLAMA_MODEL, messages, stream: false },
      { headers: { 'Content-Type': 'application/json' }, timeout: TIMEOUT_MS }
    );
  } catch (err) {
    if (err.code === 'ECONNABORTED') throw new Error('Timeout chiamata Ollama');
    if (err.code === 'ECONNREFUSED') throw new Error('Ollama non raggiungibile. È avviato?');
    throw err;
  }
  return response.data.message.content;
}

// ─── Parsing JSON sicuro ──────────────────────────────────────────────────────

function parseJsonFromAI(raw) {
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) throw new Error('AI non ha restituito JSON valido');
  try {
    return JSON.parse(match[0]);
  } catch {
    throw new Error('AI ha restituito JSON malformato');
  }
}

function validateDisambiguationResult(obj) {
  if (typeof obj.nome_canonico !== 'string' || !obj.nome_canonico.trim())
    throw new Error('Campo nome_canonico mancante o non valido');
  if (typeof obj.prezzo_min !== 'number' || obj.prezzo_min < 0)
    throw new Error('Campo prezzo_min non valido');
  if (typeof obj.prezzo_max !== 'number' || obj.prezzo_max <= obj.prezzo_min)
    throw new Error('Campo prezzo_max non valido');
  if (!Array.isArray(obj.keywords) || obj.keywords.length === 0)
    throw new Error('Campo keywords mancante o vuoto');
}

// ─── Funzioni AI ──────────────────────────────────────────────────────────────

async function disambiguateProduct(userInput) {
  const messages = [
    {
      role: 'system',
      content: `Sei un esperto di mercato dell'usato. L'utente vuole cercare un prodotto specifico su Vinted.
Rispondi SOLO con un JSON valido (nessun testo prima o dopo) con questa struttura:
{
  "nome_canonico": "nome ufficiale e completo del prodotto",
  "prezzo_min": <numero intero in euro>,
  "prezzo_max": <numero intero in euro>,
  "keywords": ["keyword1", "keyword2", "keyword3"]
}
Regole per le keywords:
- Devono identificare SOLO il prodotto esatto, non accessori, giochi, custodie o articoli correlati
- Se è una console, includi la parola "console" nelle keywords
- Usa il nome ufficiale completo (es. "Nintendo Switch console" non solo "Nintendo Switch")
- Massimo 4 keywords, tutte molto specifiche
La fascia prezzo deve essere realistica per il mercato italiano dell'usato su Vinted.`,
    },
    {
      role: 'user',
      content: `Voglio cercare: ${userInput}`,
    },
  ];

  // Usa sempre Groq per la disambiguazione: serve alta qualità, viene chiamata una sola volta
  const raw = await callAI(messages, { forceGroq: true });
  const result = parseJsonFromAI(raw);
  validateDisambiguationResult(result);
  return result;
}

async function analyzeDescription(item) {
  const messages = [
    {
      role: 'system',
      content: `Sei un esperto acquirente su Vinted. Analizza questo annuncio e rispondi SOLO con "SI" o "NO".
Rispondi "SI" se l'oggetto sembra in buone condizioni reali nonostante la categoria "Buone condizioni".
Rispondi "NO" se dalla descrizione emergono difetti nascosti, usura eccessiva o problemi.`,
    },
    {
      role: 'user',
      content: `Titolo: ${item.title}
Prezzo: ${item.price} €
Descrizione: ${item.description || 'Nessuna descrizione'}
Condizioni dichiarate: ${item.status}`,
    },
  ];

  const answer = await callAI(messages);
  return answer.trim().toUpperCase().startsWith('SI');
}

async function isTitleRelevant(title, description, nomeCanonco) {
  const messages = [
    {
      role: 'system',
      content: `Sei un filtro di ricerca su Vinted. Rispondi SOLO con "SI" o "NO".
Rispondi "SI" se l'annuncio vende il prodotto cercato.
Rispondi "NO" se è un accessorio, gioco, custodia, cavo, controller, o articolo correlato.`,
    },
    {
      role: 'user',
      content: `Prodotto cercato: ${nomeCanonco}
Titolo: ${title}
Descrizione: ${description ? description.slice(0, 300) : 'nessuna'}`,
    },
  ];

  const answer = await callAI(messages);
  return answer.trim().toUpperCase().startsWith('SI');
}

module.exports = { disambiguateProduct, analyzeDescription, isTitleRelevant, getTokenStats, isTokenLimitReached };

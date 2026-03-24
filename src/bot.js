require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { disambiguateProduct, getTokenStats } = require('./claude');
const { saveProfile, getProfile, saveFeedback } = require('./db');
const { runLearner } = require('./learner');
const Monitor = require('./monitor');

const token = process.env.TELEGRAM_TOKEN;
let chatId = process.env.TELEGRAM_CHAT_ID || null;
const AUTO_BUY = process.env.AUTO_BUY === 'true';

if (!token) {
  console.error('TELEGRAM_TOKEN mancante nel .env');
  process.exit(1);
}
if (!chatId) {
  console.log('TELEGRAM_CHAT_ID non impostato: verrà salvato automaticamente dal primo utente che scrive al bot.');
}

const bot = new TelegramBot(token, { polling: true });

// Recovery automatico su errori di rete transitori
bot.on('polling_error', (err) => {
  const transient = ['ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EFATAL'];
  if (transient.some(c => err.message.includes(c))) {
    console.warn('[Bot] Errore di rete transitorio, riprendo polling...', err.message);
    return;
  }
  console.error('[Bot] Polling error:', err.message);
});

const monitor = new Monitor(notifyMatch);

monitor.onTokenLimit = () => {
  if (chatId) bot.sendMessage(chatId, '⚠️ Limite token giornaliero raggiunto. Monitoraggio fermato.').catch(() => {});
};

monitor.onError = (message) => {
  if (chatId) bot.sendMessage(chatId, message).catch(() => {});
};

// ─── Stati conversazione per utente ──────────────────────────────────────────

const userStates = new Map();
const STATE_TTL_MS = 30 * 60 * 1000; // pulisce stati inattivi dopo 30 minuti

// Cleanup periodico degli stati inattivi
setInterval(() => {
  const now = Date.now();
  for (const [uid, state] of userStates) {
    if (state.step !== 'monitoring' && now - (state.updatedAt || 0) > STATE_TTL_MS) {
      userStates.delete(uid);
    }
  }
}, 10 * 60 * 1000);

function setState(uid, data) {
  userStates.set(uid, { ...data, updatedAt: Date.now() });
}

function getState(uid) {
  return userStates.get(uid) || null;
}

// ─── Categorie Vinted ─────────────────────────────────────────────────────────

const CATEGORIE = [
  { label: '🎮 Console',         id: 139  },
  { label: '🕹 Videogiochi',     id: 1320 },
  { label: '📱 Smartphone',      id: 1597 },
  { label: '💻 Laptop/PC',       id: 1598 },
  { label: '🎵 Audio',           id: 1600 },
  { label: '📷 Foto/Video',      id: 1601 },
  { label: '🔌 Elettronica',     id: 2    },
  { label: '👕 Abbigliamento',   id: 4    },
  { label: '👟 Scarpe',          id: 5    },
  { label: '🎒 Borse',           id: 6    },
  { label: '🏠 Casa',            id: 8    },
  { label: '📦 Altro',           id: null },
];

const CONDIZIONI = [
  { label: '🏷 Nuovo con cartellino', id: 6 },
  { label: '✨ Nuovo',                id: 1 },
  { label: '👌 Ottime condizioni',    id: 2 },
  { label: '👍 Buone condizioni',     id: 3 },
  { label: '👎 Accettabili',          id: 4 },
];

// ─── Helpers bottoni ──────────────────────────────────────────────────────────

function categorieKeyboard() {
  const rows = [];
  for (let i = 0; i < CATEGORIE.length; i += 2) {
    const row = [{ text: CATEGORIE[i].label, callback_data: `cat_${i}` }];
    if (CATEGORIE[i + 1]) row.push({ text: CATEGORIE[i + 1].label, callback_data: `cat_${i + 1}` });
    rows.push(row);
  }
  return { inline_keyboard: rows };
}

function condizioniKeyboard(selected) {
  const rows = CONDIZIONI.map((c, i) => [{
    text: selected.includes(i) ? `✅ ${c.label}` : c.label,
    callback_data: `cond_${i}`,
  }]);
  rows.push([{ text: '▶️ Conferma selezione', callback_data: 'cond_confirm' }]);
  return { inline_keyboard: rows };
}

// ─── /start ───────────────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  const uid = msg.chat.id;
  if (monitor.isRunning()) {
    monitor.stop();
  }
  setState(uid, { step: 'awaiting_product' });
  await bot.sendMessage(uid, '👋 Ciao! Cosa vuoi cercare su Vinted?\n\nScrivi il nome del prodotto:');
});

// ─── /stop ────────────────────────────────────────────────────────────────────

bot.onText(/\/stop/, async (msg) => {
  const uid = msg.chat.id;
  if (monitor.isRunning()) {
    monitor.stop();
    setState(uid, { step: 'awaiting_product' });
    await bot.sendMessage(uid, '⏹ Monitoraggio fermato.\nScrivi un nuovo prodotto per ricominciare:');
  } else {
    await bot.sendMessage(uid, 'Nessun monitoraggio attivo. Scrivi /start per iniziare.');
  }
});

// ─── /status ──────────────────────────────────────────────────────────────────

bot.onText(/\/status/, async (msg) => {
  const uid = msg.chat.id;
  const { used, limit, provider } = getTokenStats();
  const state = getState(uid);
  const monitoringInfo = monitor.isRunning() && state?.searchConfig
    ? `🔍 *Monitoraggio attivo:* ${escapeMarkdown(state.searchConfig.nomeCanonoco || state.searchConfig.keywords?.join(', ') || '–')}\n` +
      `💶 *Prezzo:* ${state.searchConfig.priceMin}€ – ${state.searchConfig.priceMax}€\n`
    : '⏹ *Monitoraggio:* inattivo\n';

  const tokenInfo = provider === 'ollama'
    ? `🤖 *AI:* Ollama (${process.env.OLLAMA_MODEL})`
    : `🤖 *AI:* Groq | Token oggi: ${used.toLocaleString('it-IT')} / ${limit.toLocaleString('it-IT')}`;

  await bot.sendMessage(uid,
    `📊 *Stato Vinted Hunter*\n\n${monitoringInfo}\n${tokenInfo}`,
    { parse_mode: 'Markdown' }
  );
});

// ─── Messaggi di testo ────────────────────────────────────────────────────────

bot.on('message', async (msg) => {
  const uid = msg.chat.id;
  const text = msg.text;

  if (!chatId) {
    chatId = String(uid);
    console.log(`[Bot] Chat ID salvato automaticamente: ${chatId}`);
  }

  if (!text || text.startsWith('/')) return;

  const state = getState(uid);
  if (!state) {
    await bot.sendMessage(uid, 'Scrivi /start per iniziare.');
    return;
  }

  if (state.step === 'awaiting_product') {
    await handleProductInput(uid, text);
    return;
  }

  if (state.step === 'awaiting_price') {
    await handlePriceInput(uid, text);
    return;
  }

  if (state.step === 'monitoring') {
    await bot.sendMessage(uid, '🔍 Sto già monitorando. Usa /stop per fermare o /status per lo stato.');
    return;
  }
});

// ─── Callback bottoni inline ──────────────────────────────────────────────────

bot.on('callback_query', async (query) => {
  const uid = query.message.chat.id;
  const data = query.data;
  const state = getState(uid);

  await bot.answerCallbackQuery(query.id);

  if (!state) return;

  // ── Selezione categoria
  if (data.startsWith('cat_') && state.step === 'awaiting_category') {
    const idx = parseInt(data.split('_')[1]);
    const cat = CATEGORIE[idx];
    setState(uid, {
      ...state,
      step: 'awaiting_conditions',
      catalogId: cat.id,
      categoryLabel: cat.label,
      selectedConditions: [0, 1, 2, 3],
    });

    await bot.editMessageText(
      `${cat.label} selezionata.\n\n🔘 Seleziona le condizioni accettabili:\n_(puoi selezionare più opzioni)_`,
      { chat_id: uid, message_id: query.message.message_id, parse_mode: 'Markdown',
        reply_markup: condizioniKeyboard([0, 1, 2, 3]) }
    );
    return;
  }

  // ── Toggle condizione
  if (data.startsWith('cond_') && data !== 'cond_confirm' && state.step === 'awaiting_conditions') {
    const idx = parseInt(data.split('_')[1]);
    const sel = [...state.selectedConditions];
    const pos = sel.indexOf(idx);
    if (pos === -1) sel.push(idx);
    else sel.splice(pos, 1);

    setState(uid, { ...state, selectedConditions: sel });
    await bot.editMessageReplyMarkup(condizioniKeyboard(sel), {
      chat_id: uid, message_id: query.message.message_id,
    });
    return;
  }

  // ── Conferma condizioni
  if (data === 'cond_confirm' && state.step === 'awaiting_conditions') {
    if (state.selectedConditions.length === 0) {
      await bot.answerCallbackQuery(query.id, { text: 'Seleziona almeno una condizione!' });
      return;
    }

    const statusIds = state.selectedConditions.map((i) => CONDIZIONI[i].id);
    setState(uid, { ...state, step: 'awaiting_price', statusIds });

    const { priceMin, priceMax } = state.searchConfig;
    await bot.editMessageText(
      `✅ Condizioni: ${state.selectedConditions.map((i) => CONDIZIONI[i].label).join(', ')}\n\n` +
      `💶 Fascia prezzo suggerita: *${priceMin}€ – ${priceMax}€*\n\n` +
      `Scrivi *min max* per cambiarla (es. \`30 80\`) oppure *ok* per usare quella suggerita.`,
      { chat_id: uid, message_id: query.message.message_id, parse_mode: 'Markdown' }
    );
    return;
  }

  // ── Conferma riepilogo → avvia
  if (data === 'confirm_start' && state.step === 'awaiting_final_confirm') {
    await bot.editMessageText(
      `✅ Monitoraggio avviato!\nUsa /stop per fermare o /status per lo stato.`,
      { chat_id: uid, message_id: query.message.message_id }
    );
    startMonitor(uid, state.finalConfig);
    return;
  }

  if (data === 'confirm_cancel' && state.step === 'awaiting_final_confirm') {
    setState(uid, { step: 'awaiting_product' });
    await bot.editMessageText('❌ Annullato. Scrivi un nuovo prodotto:', { chat_id: uid, message_id: query.message.message_id });
    return;
  }

  // ── Feedback annuncio
  if (data.startsWith('good_') || data.startsWith('false_')) {
    const isGood = data.startsWith('good_');
    const itemId = data.slice(isGood ? 5 : 6);
    const feedbackType = isGood ? 'good' : 'false_positive';
    const profileId = state?.searchConfig?.profileId || state?.finalConfig?.profileId || null;
    const itemTitle = query.message.caption || query.message.text || '';

    try {
      await saveFeedback({ profileId, itemId, itemTitle, feedback: feedbackType });
      if (feedbackType === 'false_positive' && profileId) {
        runLearner(profileId).catch((err) => console.error('[Bot] Errore learner:', err.message));
      }
    } catch (err) {
      console.error('[Bot] Errore salvataggio feedback:', err.message);
    }

    await bot.answerCallbackQuery(query.id, { text: 'Grazie per il feedback!' });
    await bot.editMessageReplyMarkup({ inline_keyboard: [] }, {
      chat_id: uid,
      message_id: query.message.message_id,
    });
    return;
  }
});

// ─── Step 1: input prodotto ───────────────────────────────────────────────────

async function handleProductInput(uid, text) {
  await bot.sendMessage(uid, '🔍 Cerco il prodotto...');

  let profileId = null;
  let searchConfig = null;

  // Cerca prima nel DB per nome canonico (case-insensitive)
  const existing = await getProfile(text.trim());
  if (existing) {
    console.log(`[Bot] Profilo trovato nel DB: ${existing.product_name} (id=${existing.id})`);
    profileId = existing.id;
    searchConfig = {
      keywords: existing.keywords,
      priceMin: existing.price_min,
      priceMax: existing.price_max,
      nomeCanonoco: existing.product_name,
      profileId,
    };
    await bot.sendMessage(uid, `✅ Profilo già esistente: *${escapeMarkdown(existing.product_name)}*\n_(dati caricati dal DB, nessuna chiamata AI)_`, { parse_mode: 'Markdown' });
  } else {
    // Nuovo prodotto: chiama Groq
    await bot.sendMessage(uid, '🤖 Analizzo con AI...');
    let result;
    try {
      result = await disambiguateProduct(text);
    } catch (err) {
      console.error('[Bot] Errore disambiguazione:', err.message);
      const userMsg = err.message === 'TOKEN_LIMIT_REACHED'
        ? '⚠️ Limite token giornaliero raggiunto. Riprova domani.'
        : `❌ Errore AI: ${err.message}\n\nRiprova o scrivi il prodotto diversamente.`;
      await bot.sendMessage(uid, userMsg);
      return;
    }

    profileId = await saveProfile({
      productName: result.nome_canonico,
      keywords: result.keywords,
      priceMin: result.prezzo_min,
      priceMax: result.prezzo_max,
    });
    console.log(`[Bot] Nuovo profilo salvato nel DB: ${result.nome_canonico} (id=${profileId})`);

    searchConfig = {
      keywords: result.keywords,
      priceMin: result.prezzo_min,
      priceMax: result.prezzo_max,
      nomeCanonoco: result.nome_canonico,
      profileId,
    };
  }

  setState(uid, {
    step: 'awaiting_category',
    searchConfig,
  });

  await bot.sendMessage(
    uid,
    `📦 *${escapeMarkdown(result.nome_canonico)}*\n🔑 Keywords: ${result.keywords.map(escapeMarkdown).join(', ')}\n\n📂 Seleziona la categoria:`,
    { parse_mode: 'Markdown', reply_markup: categorieKeyboard() }
  );
}

// ─── Step 3: fascia prezzo ────────────────────────────────────────────────────

async function handlePriceInput(uid, text) {
  const state = getState(uid);
  const { searchConfig, catalogId, categoryLabel, statusIds } = state;
  const answer = text.trim().toLowerCase();

  let priceMin = searchConfig.priceMin;
  let priceMax = searchConfig.priceMax;

  if (answer !== 'ok') {
    const parts = answer.split(/\s+/);
    const min = parseInt(parts[0], 10);
    const max = parseInt(parts[1], 10);

    if (parts.length !== 2 || isNaN(min) || isNaN(max) || min < 0 || max <= min) {
      await bot.sendMessage(uid, '❌ Formato non valido. Scrivi due numeri (es. `30 80`) oppure *ok*.', { parse_mode: 'Markdown' });
      return;
    }
    priceMin = min;
    priceMax = max;
  }

  const finalConfig = { ...searchConfig, priceMin, priceMax, catalogId, statusIds };
  setState(uid, { step: 'awaiting_final_confirm', finalConfig });

  const condsLabel = statusIds.map((id) => CONDIZIONI.find((c) => c.id === id)?.label || id).join(', ');
  const summary =
    `📋 *Riepilogo ricerca*\n\n` +
    `📦 *Prodotto:* ${escapeMarkdown(searchConfig.nomeCanonoco)}\n` +
    `📂 *Categoria:* ${categoryLabel}\n` +
    `🔘 *Condizioni:* ${condsLabel}\n` +
    `💶 *Prezzo:* ${priceMin}€ – ${priceMax}€\n\n` +
    `Avvio il monitoraggio?`;

  await bot.sendMessage(uid, summary, {
    parse_mode: 'Markdown',
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Avvia', callback_data: 'confirm_start' },
        { text: '❌ Annulla', callback_data: 'confirm_cancel' },
      ]],
    },
  });
}

// ─── Avvio monitor ────────────────────────────────────────────────────────────

function startMonitor(uid, config) {
  setState(uid, { step: 'monitoring', searchConfig: config });
  if (monitor.isRunning()) monitor.stop();
  monitor.start(config);
}

// ─── Notifica match ───────────────────────────────────────────────────────────

async function notifyMatch(item) {
  if (!chatId) return;
  console.log(`[Bot] Notifica: ${item.title} - ${item.price}€`);

  const caption =
    `🛍 *${escapeMarkdown(item.title)}*\n` +
    `💶 *${item.price}€*\n` +
    `📋 ${escapeMarkdown(item.status)}\n` +
    (item.brandTitle ? `🏷 ${escapeMarkdown(item.brandTitle)}\n` : '') +
    (item.size ? `📏 ${escapeMarkdown(item.size)}\n` : '') +
    `🔗 [Vedi annuncio](${item.url})`;

  const feedbackKeyboard = {
    inline_keyboard: [[
      { text: '✅ Buono', callback_data: `good_${item.id}` },
      { text: '❌ Falso positivo', callback_data: `false_${item.id}` },
    ]],
  };

  if (item.photoUrl) {
    try {
      await bot.sendPhoto(chatId, item.photoUrl, { caption, parse_mode: 'Markdown', reply_markup: feedbackKeyboard });
      if (AUTO_BUY) await autoBuy(item);
      return;
    } catch {
      // foto non disponibile, fallback a messaggio testo
    }
  }

  await bot.sendMessage(chatId, caption, { parse_mode: 'Markdown', reply_markup: feedbackKeyboard });
  if (AUTO_BUY) await autoBuy(item);
}

// ─── Acquisto automatico (placeholder) ───────────────────────────────────────

async function autoBuy(item) {
  console.log(`[AutoBuy] Placeholder per item ${item.id}: ${item.title}`);
}

// ─── Utility ──────────────────────────────────────────────────────────────────

function escapeMarkdown(text) {
  if (!text) return '';
  return String(text).replace(/[_*[\]()~`>#+=|{}.!-]/g, '\\$&');
}

// ─── Avvio ────────────────────────────────────────────────────────────────────

const { used, limit } = getTokenStats();
console.log(`🤖 Vinted Hunter avviato. Token oggi: ${used} / ${limit}`);

if (chatId) {
  bot.sendMessage(chatId,
    `🤖 *Vinted Hunter è online\\!*\n\nScrivi /start per iniziare\\.\n📊 Token oggi: ${used} / ${limit}`,
    { parse_mode: 'MarkdownV2' }
  ).catch(() => console.warn('[Bot] Impossibile inviare messaggio di avvio.'));
} else {
  console.log('[Bot] Scrivi al bot su Telegram per registrare il tuo Chat ID.');
}

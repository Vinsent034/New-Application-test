const { getFeedbackTitles, addNegativeKeywords, getProfile } = require('./db');

// Parole troppo comuni per essere negative keyword utili
const STOPWORDS = new Set([
  'il', 'lo', 'la', 'i', 'gli', 'le', 'un', 'uno', 'una',
  'di', 'a', 'da', 'in', 'con', 'su', 'per', 'tra', 'fra',
  'e', 'o', 'ma', 'se', 'che', 'non', 'è', 'del', 'della',
  'dei', 'degli', 'delle', 'al', 'allo', 'alla', 'ai', 'agli', 'alle',
  'nel', 'nello', 'nella', 'nei', 'negli', 'nelle', 'come', 'anche',
]);

const MIN_FALSE_POSITIVES = 3; // soglia minima per promuovere una parola

async function runLearner(profileId) {
  if (!profileId) return;

  const rows = await getFeedbackTitles(profileId);
  if (rows.length === 0) return;

  const fpWords = new Map();  // parola -> conteggio false_positive
  const goodWords = new Set(); // parole che appaiono in almeno un good

  for (const { item_title, feedback } of rows) {
    if (!item_title) continue;
    const words = item_title
      .toLowerCase()
      .split(/\s+/)
      .map((w) => w.replace(/[^a-zàèéìòù0-9]/g, ''))
      .filter((w) => w.length > 2 && !STOPWORDS.has(w));

    for (const word of words) {
      if (feedback === 'false_positive') {
        fpWords.set(word, (fpWords.get(word) || 0) + 1);
      } else if (feedback === 'good') {
        goodWords.add(word);
      }
    }
  }

  // Parole che appaiono >= MIN_FALSE_POSITIVES volte nei false_positive e mai nei good
  const candidates = [];
  for (const [word, count] of fpWords) {
    if (count >= MIN_FALSE_POSITIVES && !goodWords.has(word)) {
      candidates.push(word);
    }
  }

  if (candidates.length === 0) return;

  // Recupera le negative_keywords già presenti per evitare duplicati nel log
  const profile = await getProfile(profileId);
  const existing = new Set(profile?.negative_keywords || []);
  const newWords = candidates.filter((w) => !existing.has(w));

  if (newWords.length === 0) return;

  await addNegativeKeywords(profileId, newWords);
  for (const word of newWords) {
    console.log(`[Learner] Aggiunta negative keyword: "${word}" (profilo ${profileId})`);
  }
}

module.exports = { runLearner };

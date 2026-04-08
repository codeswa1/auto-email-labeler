// ml_model.js
// Single-engine Model: TF-IDF

var MAX_DATASET = 2000;
var trainingDataset = [];
var senderMemory = {};
var vocabulary = [];
var idf = {};
var centroids = {};
var debugLog = [];

function normalize(text){ return text?text.toLowerCase().replace(/[^a-z0-9 ]+/g," ").trim():""; }
function tokenize(text){ return normalize(text).split(" ").filter(Boolean); }
function getTokens(sender, subject, snippet="") {
  const senderT = tokenize(sender).map(t => "sdr_" + t);
  const subjT = tokenize(subject).map(t => "sub_" + t);
  const snipT = tokenize(snippet).map(t => "snp_" + t);
  return [...senderT, ...subjT, ...snipT];
}
function getDecayedCount(memoryValue) {
  if (typeof memoryValue === 'number') return memoryValue;
  if (memoryValue && typeof memoryValue === 'object') {
    const daysPassed = (Date.now() - (memoryValue.lastUpdated || Date.now())) / (1000 * 60 * 60 * 24);
    return memoryValue.count * Math.pow(0.5, daysPassed / 120);
  }
  return 0;
}

function cosineSimilarity(a, b) {
  let dot=0,na=0,nb=0;
  for(let i=0; i<a.length; i++){
    dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i];
  } 
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// =======================
// TF-IDF MATH
// =======================
function buildVocabulary(){
  const set = new Set();
  trainingDataset.forEach(d => getTokens(d.sender, d.subject, d.snippet || "").forEach(t=>set.add(t)));
  vocabulary = Array.from(set);
}

function computeIDF(){
  idf = {};
  vocabulary.forEach(term => {
    let count = 0;
    trainingDataset.forEach(d => { if(getTokens(d.sender, d.subject, d.snippet || "").includes(term)) count++; });
    idf[term] = Math.log(trainingDataset.length / (1+count));
  });
}

function tfIdfVectorize(sender, subject, snippet="") {
  const tokens = getTokens(sender, subject, snippet);
  return vocabulary.map(t => tokens.includes(t)?idf[t]||0:0);
}

// =======================
// UNIFIED PIPELINE
// =======================

// Awaitable predict instead of sync
async function predictLabel(sender, subject, snippet, settings) {
  let vec = tfIdfVectorize(sender, subject, snippet);

  const senderKey = normalize(sender);
  let best = { label: "AUTO", confidence: 0 };
  
  if (vec && vec.length > 0) {
    Object.entries(centroids).forEach(([label, centroid]) => {
      if (!centroid || centroid.length === 0 || centroid.length !== vec.length) return; // Mismatched vector architectures
      
      let score = cosineSimilarity(vec, centroid);
      let memDecayed = settings.senderBoost && senderMemory[senderKey]?.[label] ? getDecayedCount(senderMemory[senderKey][label]) : 0;
      if (memDecayed > 0) score += 0.15; // Give boost if some memory exists
      if (score > best.confidence) best = { label, confidence: Math.min(score, 1) };
    });
  }

  let isGraduated = false;
  let bestSenderOverride = null;
  
  if (senderMemory[senderKey]) {
    let totalApprovals = 0;
    let maxDecayed = 0;

    Object.entries(senderMemory[senderKey]).forEach(([lbl, val]) => {
      const decayed = getDecayedCount(val);
      totalApprovals += decayed;
      if (decayed > maxDecayed) {
        maxDecayed = decayed;
        bestSenderOverride = lbl;
      }
    });

    if (totalApprovals >= 3) {
      isGraduated = true;
    }
    
    if (bestSenderOverride && maxDecayed >= 2) {
       best = { label: bestSenderOverride, confidence: 1.0 };
    }
  }
  
  if (best.confidence < 0.35 && !isGraduated && (!bestSenderOverride || getDecayedCount(senderMemory[senderKey]?.[bestSenderOverride]) < 2)) {
     best.label = "AUTO";
  }
  
  best.isGraduated = isGraduated;

  debugLog.push({ sender, subject, ...best });
  if(debugLog.length > 30) debugLog.shift();
  return best;
}

// Group emails into mathematical averages based on label
async function rebuildCentroids(settings) {
  centroids = {};
  const grouped = {};
  
  for (let i = 0; i < trainingDataset.length; i++) {
    const d = trainingDataset[i];
    let vec = tfIdfVectorize(d.sender, d.subject, d.snippet || "");
    
    if (vec.length > 0 && d.label !== "AUTO") {
      grouped[d.label] ??= []; 
      grouped[d.label].push(vec);
    }
  }
  
  // Calculate average vector point (Cluster Centroid) for each label
  Object.entries(grouped).forEach(([label, vectors]) => {
    if (vectors.length === 0) return;
    const dim = vectors[0].length;
    const avg = new Array(dim).fill(0);
    
    vectors.forEach(v => {
      for (let i = 0; i < dim; i++) {
        avg[i] += (v[i] || 0) / vectors.length;
      }
    });
    centroids[label] = avg;
  });
}

// Exposed rebuild method. Run predominantly by offscreen.js
async function rebuildModel(settings) {
  buildVocabulary();
  computeIDF();
  await rebuildCentroids(settings);
}

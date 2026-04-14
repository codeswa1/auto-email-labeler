// ml_model.js
// Single-engine Model: TF-IDF Optimized

var MAX_DATASET = 25000;
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
// TF-IDF MATH (O(N) Optimized)
// =======================
function rebuildMatrices() {
  const termCounts = {};
  const vocabSet = new Set();
  
  console.time("ML: Matrix Rebuild");
  
  // Single pass to build vocabulary and count document frequencies
  trainingDataset.forEach(d => {
    if (!d || !d.sender) return;
    const tokens = new Set(getTokens(d.sender, d.subject, d.snippet || ""));
    tokens.forEach(term => {
      vocabSet.add(term);
      termCounts[term] = (termCounts[term] || 0) + 1;
    });
  });
  
  vocabulary = Array.from(vocabSet);
  idf = {};
  const N = trainingDataset.length;
  
  vocabulary.forEach(term => {
     idf[term] = Math.log(N / (1 + (termCounts[term] || 0)));
  });
  
  console.timeEnd("ML: Matrix Rebuild");
}


function tfIdfVectorize(sender, subject, snippet="") {
  const tokens = getTokens(sender, subject, snippet);
  const vector = new Array(vocabulary.length).fill(0);
  
  // Optimize: Use an index map for vocabulary if it gets very large
  tokens.forEach(token => {
    const idx = vocabulary.indexOf(token);
    if (idx !== -1) {
      vector[idx] = idf[token] || 0;
    }
  });
  return vector;
}

// =======================
// UNIFIED PIPELINE
// =======================

async function predictLabel(sender, subject, snippet, settings) {
  if (vocabulary.length === 0) return { label: "AUTO", confidence: 0, isGraduated: false };
  
  const vec = tfIdfVectorize(sender, subject, snippet);
  const senderKey = normalize(sender);
  let best = { label: "AUTO", confidence: 0 };
  
  Object.entries(centroids).forEach(([label, centroid]) => {
    if (!centroid || centroid.length !== vec.length) return;
    
    let score = cosineSimilarity(vec, centroid);
    let memDecayed = settings.senderBoost && senderMemory[senderKey]?.[label] ? getDecayedCount(senderMemory[senderKey][label]) : 0;
    if (memDecayed > 0) score += 0.15; // Feedback boost
    if (score > best.confidence) best = { label, confidence: Math.min(score, 1) };
  });

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

    if (totalApprovals >= 3) isGraduated = true;
    if (bestSenderOverride && maxDecayed >= 2) {
       best = { label: bestSenderOverride, confidence: 1.0 };
    }
  }
  
  if (best.confidence < 0.35 && !isGraduated) {
     best.label = "AUTO";
  }
  
  best.isGraduated = isGraduated;

  debugLog.push({ sender, subject, ...best });
  if(debugLog.length > 30) debugLog.shift();
  return best;
}

async function rebuildCentroids(settings) {
  centroids = {};
  const grouped = {};
  
  trainingDataset.forEach(d => {
    if (d.label === "AUTO") return;
    const vec = tfIdfVectorize(d.sender, d.subject, d.snippet || "");
    grouped[d.label] ??= []; 
    grouped[d.label].push(vec);
  });
  
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

async function rebuildModel(settings) {
  rebuildMatrices();
  await rebuildCentroids(settings);
}


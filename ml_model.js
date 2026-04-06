// ml_model.js
// Dual-engine Model: TF-IDF vs Semantic Ollama Embeddings

var MAX_DATASET = 2000;
var trainingDataset = [];
var senderMemory = {};
var vocabulary = [];
var idf = {};
var centroids = {};
var debugLog = [];

function normalize(text){ return text?text.toLowerCase().replace(/[^a-z0-9 ]+/g," ").trim():""; }
function tokenize(text){ return normalize(text).split(" ").filter(Boolean); }

function cosineSimilarity(a, b) {
  let dot=0,na=0,nb=0;
  for(let i=0; i<a.length; i++){
    dot += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i];
  } 
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

// =======================
// OLLAMA API
// =======================
async function getOllamaEmbedding(text, url, model) {
  try {
    const res = await fetch(`${url}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: text })
    });
    if (!res.ok) throw new Error("Ollama fetching error");
    const data = await res.json();
    return data.embedding;
  } catch (err) {
    console.error("Local Ollama API Error:", err);
    return []; // Empty vector essentially forces a 0% match
  }
}

// =======================
// TF-IDF MATH
// =======================
function buildVocabulary(){
  const set = new Set();
  trainingDataset.forEach(d => tokenize(d.sender+" "+d.subject).forEach(t=>set.add(t)));
  vocabulary = Array.from(set);
}

function computeIDF(){
  idf = {};
  vocabulary.forEach(term => {
    let count = 0;
    trainingDataset.forEach(d => { if(tokenize(d.sender+" "+d.subject).includes(term)) count++; });
    idf[term] = Math.log(trainingDataset.length / (1+count));
  });
}

function tfIdfVectorize(text) {
  const tokens = tokenize(text);
  return vocabulary.map(t => tokens.includes(t)?idf[t]||0:0);
}

// =======================
// UNIFIED PIPELINE
// =======================

// Awaitable predict instead of sync
async function predictLabel(sender, subject, settings) {
  const text = sender + " " + subject;
  let vec = [];
  
  if (settings.ollamaEnabled && settings.ollamaUrl && settings.ollamaModel) {
    vec = await getOllamaEmbedding(text, settings.ollamaUrl, settings.ollamaModel);
  } else {
    vec = tfIdfVectorize(text);
  }

  const senderKey = normalize(sender);
  let best = { label: "AUTO", confidence: 0 };
  
  if (vec && vec.length > 0) {
    Object.entries(centroids).forEach(([label, centroid]) => {
      if (!centroid || centroid.length === 0 || centroid.length !== vec.length) return; // Mismatched vector architectures
      
      let score = cosineSimilarity(vec, centroid);
      if (settings.senderBoost && senderMemory[senderKey]?.[label]) score += 0.15;
      if (score > best.confidence) best = { label, confidence: Math.min(score, 1) };
    });
  }

  let isGraduated = false;
  if (senderMemory[senderKey]) {
    // If the user has manually corrected or approved this sender 3 or more times
    const totalApprovals = Object.values(senderMemory[senderKey]).reduce((sum, count) => sum + count, 0);
    if (totalApprovals >= 3) {
      isGraduated = true;
    }
    
    // As Architect's rule: if they strictly have a specific preferred label over 2 times, bypass TF-IDF totally to prevent regression
    const bestSenderOverride = Object.entries(senderMemory[senderKey]).sort((a,b)=>b[1]-a[1])[0];
    if (bestSenderOverride && bestSenderOverride[1] >= 2) {
       best = { label: bestSenderOverride[0], confidence: 1.0 };
    }
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
    const text = normalize(d.sender) + " " + normalize(d.subject) + " " + normalize(d.snippet || "");
    
    let vec = [];
    if (settings.ollamaEnabled) {
      // Re-use cached vector if it was already fetched to save API quotas and time
      if (!d.ollamaVector) {
        d.ollamaVector = await getOllamaEmbedding(text, settings.ollamaUrl, settings.ollamaModel);
      }
      vec = d.ollamaVector;
    } else {
      vec = tfIdfVectorize(text);
    }
    
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
  if (!settings.ollamaEnabled) {
    buildVocabulary();
    computeIDF();
  }
  await rebuildCentroids(settings);
}

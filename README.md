# Auto Email Labeler – Gmail Chrome Extension

The rapid growth in digital communication has led to a significant increase in the volume and heterogeneity of email messages received by users. Current email classification mechanisms predominantly rely on manual rule-based filtering or centralized, server-side machine learning models. These approaches suffer from limited adaptability, lack of user transparency, and substantial privacy concerns due to the external processing of sensitive email content.
Furthermore, existing systems provide minimal support for client-side, real-time email labeling that operates entirely within the user’s browser environment. The absence of such mechanisms results in increased cognitive load, inefficient inbox management, and reduced user control over data handling and classification logic.
The core problem addressed in this work is the absence of a privacy-preserving, client-side automated email labeling system that performs real-time classification without transmitting email data to external servers, while maintaining transparency, adaptability, and usability within web-based email interfaces.

A privacy-first Chrome extension that automatically classifies and labels Gmail
emails using client-side machine learning, sender memory, and Gmail DOM
integration, with no backend and no external services.

---

## Overview

Auto Email Labeler augments the Gmail inbox UI by predicting contextual labels for
emails in real time. The system operates entirely inside the browser, performing
feature extraction, inference, and learning locally.

This project focuses on:
- Gmail DOM reverse-engineering
- Lightweight ML inference in JavaScript
- Persistent sender-based learning
- Privacy-preserving browser extensions

---

## Features

- **Automatic Email Classification**
  - Predicts labels using subject text and sender metadata

- **Client-Side Machine Learning**
  - No server-side inference
  - Vocabulary-based vectorization
  - Centroid similarity scoring

- **Sender Memory**
  - Learns recurring sender → label mappings
  - Improves accuracy over time

- **Privacy-First Design**
  - No third-party network requests or telemetry
  - Integrates securely with the native **Gmail API** (via Google OAuth) to fetch message metadata
  - All learned data and AI models stay strictly local to your browser storage

- **Native Gmail UI Integration**
  - Injects label badges directly into inbox rows
  - Non-destructive DOM manipulation

---

## Architecture
```
┌──────────────┐
│ Gmail Inbox  │
│    (DOM)     │
└──────┬───────┘
       │
       ▼
┌─────────────────────┐       ┌──────────────────────┐
│  content_script.js  │       │     ml_model.js      │
│ - DOM parsing       │ ◄───► │ - Feature extraction │
│ - Prediction logic  │       │ - Vocabulary config  │
│ - UI badge injection│       │ - Centroid inference │
└──────┬──────────────┘       └──────────┬───────────┘
       │                                 │
       ▼                                 ▼
┌─────────────────────┐       ┌──────────────────────┐
│    background.js    │ ◄───► │  Gmail API (OAuth)   │
│ - Model rebuilding  │       │ - Background fetching│
│ - Sender memory     │       └──────────────────────┘
│ - Training updates  │
└──────┬──────────────┘
       │
       ▼
┌─────────────────────┐
│ Chrome Storage API  │
│ - Vocabulary        │
│ - Centroids         │
│ - Sender history    │
└─────────────────────┘
```
---

## Machine Learning Approach

### Feature Extraction
- Tokenization of:
  - Email subject
  - Sender name / domain
- Incremental vocabulary construction

### Model
- Centroid-based classifier per label
- Vector similarity (cosine distance)

### Learning
- User actions reinforce sender → label associations
- Model updates incrementally without retraining

> The design prioritizes interpretability, speed, and privacy over heavy models.

---

## Tech Stack

- **Language:** JavaScript (ES6+)
- **Platform:** Chrome Extensions (Manifest V3)
- **Storage:** Chrome `storage.local`
- **UI Layer:** Gmail DOM manipulation
- **ML:** Custom lightweight client-side logic

---

## Project Structure
```
auto-email-labeler/
├── ml_model.js         # Shared TF-IDF, vectorization, and inference logic
├── background.js       # Model rebuilding, persistence, and Gmail API Sync
├── content_script.js   # Gmail DOM observation logic & UI badge injection
├── manifest.json       # Extension configuration (Manifest V3)
├── popup.html          # Extension popup UI
├── popup.js            # Popup logic
├── styles.css          # Badge & popup UI styles
├── icons/              # Extension icons
└── LICENSE             # MIT License
```
---


## Steps to Implement locally

### 1. Clone the repository
```bash
git clone https://github.com/codeswa1/auto-email-labeler.git
cd auto-email-labeler
```
### 2. Load the extension in Chrome
- Open chrome://extensions
- Enable Developer mode
- Click Load unpacked
- Select the project directory

### 3. Open Gmail
The extension activates automatically on Gmail inbox pages.

## Security & Privacy
- No third-party dependencies outside of Google's native Gmail API
- No analytics or telemetry
- No email data is sent to external or third-party servers
- All learned data is stored locally

## Limitations
- Gmail DOM changes may require selector updates
- Model is intentionally lightweight
- Not designed for enterprise-scale automation

## Future Improvements
- Smarter feature weighting
- Decay for stale sender associations
- Export / import learned state
- Optional user-defined rules

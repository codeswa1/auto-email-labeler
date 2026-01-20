# Auto Email Labeler – Gmail Chrome Extension

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
  - No network requests
  - No external APIs
  - All data stays local to the browser

- **Native Gmail UI Integration**
  - Injects label badges directly into inbox rows
  - Non-destructive DOM manipulation

---

## Architecture

┌──────────────┐
│ Gmail Inbox │
│ (DOM) │
└──────┬───────┘
│
▼
┌─────────────────────┐
│ content_script.js │
│ - DOM parsing │
│ - Feature extraction│
│ - Prediction logic │
│ - UI badge injection│
└──────┬──────────────┘
│
▼
┌─────────────────────┐
│ background.js │
│ - Model persistence │
│ - Sender memory │
│ - Training updates │
└──────┬──────────────┘
│
▼
┌─────────────────────┐
│ Chrome Storage API │
│ - Vocabulary │
│ - Centroids │
│ - Sender history │
└─────────────────────┘

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

auto-email-labeler/
├── background.js # Model state & persistence
├── content_script.js # Gmail DOM logic & inference
├── manifest.json # Extension configuration
├── popup.html # Extension popup UI
├── popup.js # Popup logic
├── styles.css # Badge & UI styles
├── icons/ # Extension icons
└── LICENSE # MIT License

---

## Steps to Implement

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
  -No third-party dependencies
  -No analytics or telemetry
  -No email data leaves the browser
  -All learned data is stored locally

## Limitations
  -Gmail DOM changes may require selector updates
  -Model is intentionally lightweight
  -Not designed for enterprise-scale automation

## Future Improvements
  -Smarter feature weighting
  -Decay for stale sender associations
  -Export / import learned state
  -Optional user-defined rules

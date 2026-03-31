# SaferTab

A Chrome extension providing parental controls for child web safety. Free, no accounts, all data stays local on device.

## What It Does

- Track/search browsing history (encrypted with AES-GCM)
- Block websites via blocklist or enforce allowlist-only mode
- Filter adult content via keyword-based domain matching
- Daily browsing time limits with minute-level tracking
- Time-based schedules for site access
- Password-protected settings (SHA-256 + salt)
- Multiple child profiles with independent settings

## Tech Stack

- **Plain JavaScript (ES6+)** — no frameworks, no build tools, no package.json
- **Chrome Extension Manifest V3** — service worker, declarativeNetRequest, webNavigation
- **Web Crypto API** — SHA-256 hashing, AES-GCM encryption, PBKDF2 key derivation

## Project Structure

```
extension/              # The Chrome extension
  manifest.json         # V3 manifest — permissions, service worker config
  background.js         # Service worker — blocking, usage tracking, profile management
  popup.js              # Popup UI controller — dashboard, history, settings, forms
  popup.html / popup.css
  crypto.js             # Crypto utilities — hashing, encryption, key derivation
  pages/
    blocked.html/js     # Block page shown when a site is blocked
  icons/                # Extension icons (16, 48, 128px)

website/                # Marketing landing page (static HTML/CSS/JS)
```

## Development

No build step. Load the extension directly in Chrome:

1. Go to `chrome://extensions`
2. Enable Developer Mode
3. "Load unpacked" → select the `extension/` folder
4. Use Chrome DevTools to debug popup and background service worker

## Architecture

- **background.js** — service worker handling all core logic: navigation interception (`webNavigation.onBeforeNavigate`), declarativeNetRequest rule generation for adult/blocklist filtering, usage tracking via `chrome.alarms`, profile CRUD, safe search URL rewriting, data migration
- **popup.js** — UI controller managing lock screen, dashboard tabs (history, sites, schedules, settings), profile switching, form validation. Uses simple DOM helpers (`show()`, `hide()`, `escHtml()`)
- **crypto.js** — stateless utility module: `hashPassword`, `deriveEncryptionKey`, `encryptData`, `decryptData`, `pruneLog`
- **Communication**: popup ↔ background via `chrome.runtime.sendMessage` / `onMessage`
- **Storage**: `chrome.storage.local` — profiles, password hash/salt, active profile ID

## Code Conventions

- Section dividers: `// ─── SECTION NAME ───────────────`
- Async/await throughout (no raw Promise chains)
- camelCase for JS identifiers, kebab-case for DOM IDs and CSS classes
- XSS protection via `escHtml()` for all user-generated content in HTML
- No external dependencies — everything is vanilla JS

// ===================================================
// SaferTab - Background Service Worker
// ===================================================

const BLOCKED_URL = chrome.runtime.getURL('pages/blocked.html');
const MAX_LOG_ENTRIES = 2000;

// Adult content keywords/domains to block
const ADULT_URL_KEYWORDS = [
  'pornhub', 'xvideos', 'xhamster', 'xnxx', 'redtube', 'youporn',
  'brazzers', 'onlyfans', 'stripchat', 'chaturbate', 'livejasmin',
  'myfreecams', 'cam4', 'bongacams', 'spankbang', 'tnaflix',
  'motherless', 'eporner', 'porntrex', 'hclips', 'drtuber',
  'txxx', 'beeg', 'porndig', 'fuq', 'sexvid'
];

const ADULT_URL_PATTERNS = [
  'porn', 'xxx', 'hentai', 'nsfw', 'erotic', 'escort',
  'camgirl', 'sexchat', 'nudes', 'lewd'
];

// ─── Initialization ────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    const defaults = {
      visitLog: [],
      blocklist: [],
      settings: {
        dailyLimitMinutes: 120,
        limitEnabled: false,
        adultFilterEnabled: true,
        password: 'guardian123',
        passwordEnabled: true,
      },
      dailyUsage: { date: getTodayStr(), minutes: 0 },
      limitReachedToday: false,
    };
    await chrome.storage.local.set(defaults);
    console.log('[Guardian] Installed with defaults.');
  }

  await rebuildBlockingRules();

  // Tick every minute to track active usage
  chrome.alarms.create('usageTick', { periodInMinutes: 1 });
  console.log('[Guardian] Background worker ready.');
});

// Re-register alarm on service worker restart
chrome.runtime.onStartup.addListener(async () => {
  chrome.alarms.create('usageTick', { periodInMinutes: 1 });
  await rebuildBlockingRules();
});

// ─── Usage Tracking (1-minute ticks) ──────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'usageTick') return;

  // Only count if there's an active, non-chrome tab
  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!activeTab || !activeTab.url) return;
  if (activeTab.url.startsWith('chrome://') || activeTab.url.startsWith('chrome-extension://')) return;

  const today = getTodayStr();
  const { dailyUsage, settings, limitReachedToday } = await chrome.storage.local.get([
    'dailyUsage', 'settings', 'limitReachedToday'
  ]);

  // Reset if it's a new day
  const usage = dailyUsage.date === today
    ? dailyUsage
    : { date: today, minutes: 0 };

  usage.minutes += 1;
  await chrome.storage.local.set({ dailyUsage: usage, limitReachedToday: usage.date !== today ? false : limitReachedToday });

  // Enforce time limit
  if (settings.limitEnabled && usage.minutes >= settings.dailyLimitMinutes) {
    if (!limitReachedToday) {
      await chrome.storage.local.set({ limitReachedToday: true });
      await redirectAllTabsToBlocked('timelimit');
    }
  }
});

async function redirectAllTabsToBlocked(reason) {
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.url) continue;
    if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) continue;
    if (tab.url.includes('pages/blocked.html')) continue;
    chrome.tabs.update(tab.id, { url: `${BLOCKED_URL}?reason=${reason}` });
  }
}

// ─── Visit Logging ─────────────────────────────────

chrome.webNavigation.onCommitted.addListener(async (details) => {
  // Only log main frame navigations
  if (details.frameId !== 0) return;
  const url = details.url;
  if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return;
  if (url.includes('pages/blocked.html')) return;

  let hostname = '';
  try { hostname = new URL(url).hostname; } catch { return; }

  const timestamp = Date.now();
  const entry = { url, hostname, timestamp, title: hostname };

  const { visitLog = [] } = await chrome.storage.local.get('visitLog');
  visitLog.unshift(entry);
  if (visitLog.length > MAX_LOG_ENTRIES) visitLog.length = MAX_LOG_ENTRIES;
  await chrome.storage.local.set({ visitLog });

  // Enforce time limit on new navigation too
  const { dailyUsage, settings, limitReachedToday } = await chrome.storage.local.get([
    'dailyUsage', 'settings', 'limitReachedToday'
  ]);
  const today = getTodayStr();
  if (settings.limitEnabled && limitReachedToday && dailyUsage.date === today) {
    chrome.tabs.update(details.tabId, { url: `${BLOCKED_URL}?reason=timelimit` });
  }
}, { url: [{ schemes: ['http', 'https'] }] });

// Update log entry titles when page loads
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.title || !tab.url) return;
  if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) return;

  const { visitLog = [] } = await chrome.storage.local.get('visitLog');
  const entry = visitLog.find(e => e.url === tab.url && e.title === new URL(tab.url).hostname);
  if (entry) {
    entry.title = changeInfo.title;
    await chrome.storage.local.set({ visitLog });
  }
});

// ─── Blocking Rules (declarativeNetRequest) ────────

async function rebuildBlockingRules() {
  const { blocklist = [], settings = {} } = await chrome.storage.local.get(['blocklist', 'settings']);

  // Remove all existing dynamic rules
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeIds = existing.map(r => r.id);

  const newRules = [];
  let ruleId = 1;

  // --- Custom blocklist rules (from user's .txt list) ---
  for (const raw of blocklist) {
    const domain = raw.trim().toLowerCase()
      .replace(/^https?:\/\//, '')
      .replace(/^www\./, '')
      .replace(/\/.*$/, '');
    if (!domain || domain.length < 3) continue;

    newRules.push({
      id: ruleId++,
      priority: 10,
      action: {
        type: 'redirect',
        redirect: { extensionPath: '/pages/blocked.html?reason=blocklist' }
      },
      condition: {
        urlFilter: `||${domain}`,
        resourceTypes: ['main_frame']
      }
    });
  }

  // --- Adult content domain rules ---
  if (settings.adultFilterEnabled !== false) {
    for (const keyword of ADULT_URL_KEYWORDS) {
      newRules.push({
        id: ruleId++,
        priority: 20,
        action: {
          type: 'redirect',
          redirect: { extensionPath: '/pages/blocked.html?reason=adult' }
        },
        condition: {
          urlFilter: `||${keyword}.`,
          resourceTypes: ['main_frame']
        }
      });
    }

    // Pattern-based blocking (catches things like "mypornsite.com")
    for (const pattern of ADULT_URL_PATTERNS) {
      newRules.push({
        id: ruleId++,
        priority: 15,
        action: {
          type: 'redirect',
          redirect: { extensionPath: '/pages/blocked.html?reason=adult' }
        },
        condition: {
          urlFilter: pattern,
          resourceTypes: ['main_frame']
        }
      });
    }
  }

  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: removeIds,
    addRules: newRules
  });

  console.log(`[Guardian] Blocking rules rebuilt: ${newRules.length} rules active.`);
}

// ─── Message Listener (from popup) ─────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.action) {
      case 'rebuildRules':
        await rebuildBlockingRules();
        sendResponse({ ok: true });
        break;

      case 'clearLog':
        await chrome.storage.local.set({ visitLog: [] });
        sendResponse({ ok: true });
        break;

      case 'resetUsage':
        await chrome.storage.local.set({
          dailyUsage: { date: getTodayStr(), minutes: 0 },
          limitReachedToday: false
        });
        sendResponse({ ok: true });
        break;

      case 'getStatus':
        const { dailyUsage, settings, limitReachedToday, visitLog } = await chrome.storage.local.get([
          'dailyUsage', 'settings', 'limitReachedToday', 'visitLog'
        ]);
        const today = getTodayStr();
        const usage = dailyUsage.date === today ? dailyUsage.minutes : 0;
        sendResponse({ usage, settings, limitReachedToday, logCount: (visitLog || []).length });
        break;

      default:
        sendResponse({ ok: false, error: 'Unknown action' });
    }
  })();
  return true; // keep channel open for async
});

// ─── Helpers ───────────────────────────────────────

function getTodayStr() {
  return new Date().toISOString().split('T')[0];
}

// ===================================================
// SaferTab - Background Service Worker
// ===================================================

importScripts('crypto.js');

const BLOCKED_URL = chrome.runtime.getURL('pages/blocked.html');

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

// Safe search URL rewriting rules
const SAFE_SEARCH_RULES = [
  { pattern: /^https:\/\/(www\.)?google\.\w+\/search/, param: 'safe', value: 'active' },
  { pattern: /^https:\/\/(www\.)?bing\.com\/search/, param: 'adlt', value: 'strict' },
  { pattern: /^https:\/\/(www\.)?duckduckgo\.com\//, param: 'kp', value: '1' },
  { pattern: /^https:\/\/(www\.)?youtube\.com\/results/, param: 'sp', value: 'EgIQAQ%3D%3D' },
];

// ─── Profile Helpers ───────────────────────────────

async function getActiveProfile() {
  const { profiles, activeProfileId } = await chrome.storage.local.get(['profiles', 'activeProfileId']);
  if (!profiles || !activeProfileId || !profiles[activeProfileId]) return null;
  return { id: activeProfileId, ...profiles[activeProfileId] };
}

async function updateActiveProfile(updates) {
  const { profiles, activeProfileId } = await chrome.storage.local.get(['profiles', 'activeProfileId']);
  if (!profiles || !activeProfileId || !profiles[activeProfileId]) return;
  Object.assign(profiles[activeProfileId], updates);
  await chrome.storage.local.set({ profiles });
}

function generateProfileId() {
  return Math.random().toString(36).substring(2, 10);
}

function createDefaultProfile(name) {
  return {
    name,
    settings: {
      dailyLimitMinutes: 120,
      limitEnabled: false,
      adultFilterEnabled: true,
      safeSearchEnabled: false,
      mode: 'blocklist',
    },
    blocklist: [],
    allowlist: [],
    schedules: [],
    visitLogPending: [],
    encryptedVisitLog: null,
    dailyUsage: { date: getTodayStr(), minutes: 0 },
    limitReachedToday: false,
  };
}

// ─── Initialization ────────────────────────────────

chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    const passwordSalt = generateSalt();
    const cryptoSalt = generateSalt();
    const passwordHash = await hashPassword('guardian123', passwordSalt);
    const profileId = generateProfileId();

    const defaults = {
      profiles: { [profileId]: createDefaultProfile('Default') },
      activeProfileId: profileId,
      passwordHash,
      passwordSalt,
      passwordEnabled: true,
      cryptoSalt,
    };
    await chrome.storage.local.set(defaults);
    console.log('[SaferTab] Installed with defaults.');
  }

  if (details.reason === 'update') {
    await migrateToProfiles();
  }

  await rebuildBlockingRules();

  chrome.alarms.create('usageTick', { periodInMinutes: 1 });
  chrome.alarms.create('logCleanup', { periodInMinutes: 1440 });
  console.log('[SaferTab] Background worker ready.');
});

chrome.runtime.onStartup.addListener(async () => {
  chrome.alarms.create('usageTick', { periodInMinutes: 1 });
  chrome.alarms.create('logCleanup', { periodInMinutes: 1440 });
  await rebuildBlockingRules();
});

// ─── Migration ─────────────────────────────────────

async function migrateToProfiles() {
  const data = await chrome.storage.local.get(null);

  // Already migrated
  if (data.profiles) {
    // Still check for password migration within profiles
    await migratePasswordIfNeeded(data);
    return;
  }

  // Migrate from flat format to profiles
  const settings = data.settings || {};
  const profileId = generateProfileId();

  const profile = createDefaultProfile('Default');
  profile.settings.dailyLimitMinutes = settings.dailyLimitMinutes || 120;
  profile.settings.limitEnabled = !!settings.limitEnabled;
  profile.settings.adultFilterEnabled = settings.adultFilterEnabled !== false;
  profile.blocklist = data.blocklist || [];
  profile.visitLogPending = data.visitLogPending || data.visitLog || [];
  profile.encryptedVisitLog = data.encryptedVisitLog || null;
  profile.dailyUsage = data.dailyUsage || { date: getTodayStr(), minutes: 0 };
  profile.limitReachedToday = !!data.limitReachedToday;

  // Extract global auth fields
  let passwordHash = data.passwordHash || settings.passwordHash;
  let passwordSalt = data.passwordSalt || settings.passwordSalt;
  const passwordEnabled = data.passwordEnabled !== undefined ? data.passwordEnabled : !!settings.passwordEnabled;

  // Migrate plain-text password
  if (settings.password && !passwordHash) {
    passwordSalt = generateSalt();
    passwordHash = await hashPassword(settings.password, passwordSalt);
  }

  const cryptoSalt = data.cryptoSalt || generateSalt();

  // Write new format
  await chrome.storage.local.clear();
  await chrome.storage.local.set({
    profiles: { [profileId]: profile },
    activeProfileId: profileId,
    passwordHash,
    passwordSalt,
    passwordEnabled,
    cryptoSalt,
  });

  console.log('[SaferTab] Migrated to profile-based storage.');
}

async function migratePasswordIfNeeded(data) {
  // Check for old password format in any remaining flat settings
  if (data.settings && data.settings.password && !data.passwordHash) {
    const passwordSalt = generateSalt();
    const passwordHash = await hashPassword(data.settings.password, passwordSalt);
    await chrome.storage.local.set({ passwordHash, passwordSalt });
    await chrome.storage.local.remove('settings');
    console.log('[SaferTab] Migrated password to hashed format.');
  }

  if (!data.cryptoSalt) {
    await chrome.storage.local.set({ cryptoSalt: generateSalt() });
  }
}

// ─── Usage Tracking (1-minute ticks) ──────────────

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === 'logCleanup') {
    const profile = await getActiveProfile();
    if (!profile) return;
    await updateActiveProfile({ visitLogPending: pruneLog(profile.visitLogPending || []) });
    return;
  }

  if (alarm.name !== 'usageTick') return;

  const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!activeTab || !activeTab.url) return;
  if (activeTab.url.startsWith('chrome://') || activeTab.url.startsWith('chrome-extension://')) return;

  const profile = await getActiveProfile();
  if (!profile) return;

  const today = getTodayStr();
  const usage = profile.dailyUsage.date === today
    ? profile.dailyUsage
    : { date: today, minutes: 0 };

  usage.minutes += 1;

  const limitReachedToday = usage.date !== today ? false : profile.limitReachedToday;
  await updateActiveProfile({ dailyUsage: usage, limitReachedToday });

  if (profile.settings.limitEnabled && usage.minutes >= profile.settings.dailyLimitMinutes) {
    if (!limitReachedToday) {
      await updateActiveProfile({ limitReachedToday: true });
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

// ─── Navigation Blocking (onBeforeNavigate) ────────

chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const url = details.url;
  if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return;
  if (url.includes('pages/blocked.html')) return;

  let hostname = '';
  try { hostname = new URL(url).hostname; } catch { return; }

  const profile = await getActiveProfile();
  if (!profile) return;

  const today = getTodayStr();

  // 1. Time limit check
  if (profile.settings.limitEnabled && profile.limitReachedToday && profile.dailyUsage.date === today) {
    chrome.tabs.update(details.tabId, { url: `${BLOCKED_URL}?reason=timelimit` });
    return;
  }

  // 2. Safe search enforcement
  if (profile.settings.safeSearchEnabled) {
    const redirectUrl = enforceSafeSearch(url);
    if (redirectUrl) {
      chrome.tabs.update(details.tabId, { url: redirectUrl });
      return;
    }
  }

  // 3. Allow-list mode: block everything not on the list
  if (profile.settings.mode === 'allowlist') {
    const allowed = (profile.allowlist || []).some(d =>
      hostname === d || hostname.endsWith('.' + d)
    );
    if (!allowed) {
      chrome.tabs.update(details.tabId, { url: `${BLOCKED_URL}?reason=allowlist` });
      return;
    }
  }

  // 4. Schedule-based rules
  const scheduleResult = checkSchedules(hostname, profile.schedules || []);
  if (scheduleResult.blocked) {
    chrome.tabs.update(details.tabId, { url: `${BLOCKED_URL}?reason=schedule` });
    return;
  }
}, { url: [{ schemes: ['http', 'https'] }] });

// ─── Safe Search Enforcement ───────────────────────

function enforceSafeSearch(url) {
  for (const rule of SAFE_SEARCH_RULES) {
    if (rule.pattern.test(url)) {
      try {
        const u = new URL(url);
        if (u.searchParams.get(rule.param) === rule.value) return null;
        u.searchParams.set(rule.param, rule.value);
        return u.toString();
      } catch { return null; }
    }
  }
  return null;
}

// ─── Schedule Checking ─────────────────────────────

function checkSchedules(hostname, schedules) {
  if (!schedules || schedules.length === 0) return { blocked: false };

  const now = new Date();
  const currentDay = now.getDay(); // 0=Sun
  const currentTime = now.getHours() * 60 + now.getMinutes(); // minutes since midnight

  for (const rule of schedules) {
    // Check if hostname matches the rule target (with subdomain matching)
    if (hostname !== rule.target && !hostname.endsWith('.' + rule.target)) continue;

    // Check if today is in the rule's days
    if (!rule.days.includes(currentDay)) continue;

    const [startH, startM] = rule.startTime.split(':').map(Number);
    const [endH, endM] = rule.endTime.split(':').map(Number);
    const start = startH * 60 + startM;
    const end = endH * 60 + endM;
    const inWindow = currentTime >= start && currentTime < end;

    if (rule.action === 'allow') {
      // Site allowed ONLY during the time window — block outside
      if (!inWindow) return { blocked: true };
    } else {
      // Site blocked DURING the time window
      if (inWindow) return { blocked: true };
    }
  }

  return { blocked: false };
}

// ─── Visit Logging (onCommitted) ───────────────────

chrome.webNavigation.onCommitted.addListener(async (details) => {
  if (details.frameId !== 0) return;
  const url = details.url;
  if (!url || url.startsWith('chrome://') || url.startsWith('chrome-extension://')) return;
  if (url.includes('pages/blocked.html')) return;

  let hostname = '';
  try { hostname = new URL(url).hostname; } catch { return; }

  const timestamp = Date.now();
  const entry = { url, hostname, timestamp, title: hostname };

  const profile = await getActiveProfile();
  if (!profile) return;

  const pending = profile.visitLogPending || [];
  pending.unshift(entry);
  await updateActiveProfile({ visitLogPending: pruneLog(pending) });
}, { url: [{ schemes: ['http', 'https'] }] });

// Update log entry titles when page loads
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (!changeInfo.title || !tab.url) return;
  if (tab.url.startsWith('chrome://') || tab.url.startsWith('chrome-extension://')) return;

  const profile = await getActiveProfile();
  if (!profile) return;

  const pending = profile.visitLogPending || [];
  let updated = false;
  for (const entry of pending) {
    try {
      if (entry.url === tab.url && entry.title === new URL(tab.url).hostname) {
        entry.title = changeInfo.title;
        updated = true;
        break;
      }
    } catch { /* ignore */ }
  }
  if (updated) {
    await updateActiveProfile({ visitLogPending: pending });
  }
});

// ─── Blocking Rules (declarativeNetRequest) ────────

async function rebuildBlockingRules() {
  const profile = await getActiveProfile();
  const settings = profile ? profile.settings : {};
  const blocklist = profile ? profile.blocklist : [];

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeIds = existing.map(r => r.id);

  const newRules = [];
  let ruleId = 1;

  // Only build declarativeNetRequest rules in blocklist mode
  // In allowlist mode, blocking is handled dynamically via webNavigation
  if (settings.mode !== 'allowlist') {
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
  }

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

  console.log(`[SaferTab] Blocking rules rebuilt: ${newRules.length} rules active.`);
}

// ─── Message Listener (from popup) ─────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.action) {
      case 'rebuildRules':
        await rebuildBlockingRules();
        sendResponse({ ok: true });
        break;

      case 'clearLog': {
        await updateActiveProfile({ visitLogPending: [], encryptedVisitLog: null });
        sendResponse({ ok: true });
        break;
      }

      case 'resetUsage':
        await updateActiveProfile({
          dailyUsage: { date: getTodayStr(), minutes: 0 },
          limitReachedToday: false
        });
        sendResponse({ ok: true });
        break;

      case 'getStatus': {
        const profile = await getActiveProfile();
        if (!profile) { sendResponse({ usage: 0, settings: {}, limitReachedToday: false, logCount: 0 }); break; }
        const today = getTodayStr();
        const usage = profile.dailyUsage.date === today ? profile.dailyUsage.minutes : 0;
        sendResponse({
          usage,
          settings: profile.settings,
          limitReachedToday: profile.limitReachedToday,
          logCount: (profile.visitLogPending || []).length
        });
        break;
      }

      case 'getStorageSize': {
        const bytesInUse = await chrome.storage.local.getBytesInUse(null);
        sendResponse({ sizeBytes: bytesInUse, limitBytes: 10485760 });
        break;
      }

      case 'getProfiles': {
        const { profiles, activeProfileId } = await chrome.storage.local.get(['profiles', 'activeProfileId']);
        const list = Object.entries(profiles || {}).map(([id, p]) => ({ id, name: p.name }));
        sendResponse({ profiles: list, activeProfileId });
        break;
      }

      case 'switchProfile': {
        const { profiles: allProfiles } = await chrome.storage.local.get('profiles');
        if (allProfiles && allProfiles[msg.profileId]) {
          await chrome.storage.local.set({ activeProfileId: msg.profileId });
          await rebuildBlockingRules();
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: 'Profile not found' });
        }
        break;
      }

      case 'createProfile': {
        const { profiles: cp } = await chrome.storage.local.get('profiles');
        const newId = generateProfileId();
        cp[newId] = createDefaultProfile(msg.name || 'New Profile');
        await chrome.storage.local.set({ profiles: cp });
        sendResponse({ ok: true, profileId: newId });
        break;
      }

      case 'deleteProfile': {
        const { profiles: dp, activeProfileId: activeId } = await chrome.storage.local.get(['profiles', 'activeProfileId']);
        if (Object.keys(dp).length <= 1) { sendResponse({ ok: false, error: 'Cannot delete last profile' }); break; }
        if (msg.profileId === activeId) { sendResponse({ ok: false, error: 'Cannot delete active profile' }); break; }
        delete dp[msg.profileId];
        await chrome.storage.local.set({ profiles: dp });
        sendResponse({ ok: true });
        break;
      }

      case 'renameProfile': {
        const { profiles: rp } = await chrome.storage.local.get('profiles');
        if (rp[msg.profileId]) {
          rp[msg.profileId].name = msg.name;
          await chrome.storage.local.set({ profiles: rp });
          sendResponse({ ok: true });
        } else {
          sendResponse({ ok: false, error: 'Profile not found' });
        }
        break;
      }

      default:
        sendResponse({ ok: false, error: 'Unknown action' });
    }
  })();
  return true;
});

// ─── Helpers ───────────────────────────────────────

function getTodayStr() {
  return new Date().toISOString().split('T')[0];
}

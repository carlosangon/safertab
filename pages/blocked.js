const params = new URLSearchParams(location.search);
const reason = params.get('reason') || 'blocklist';
const blockedUrl = document.referrer || params.get('url') || '';

const configs = {
  blocklist: {
    emoji: '🚫',
    title: 'Website Blocked',
    message: 'This website is on the SaferTab block list.',
    badgeClass: 'reason-blocklist',
    badgeText: 'Block List',
  },
  adult: {
    emoji: '🔞',
    title: 'Adult Content Blocked',
    message: 'This website contains content that isn\'t suitable for kids.',
    badgeClass: 'reason-adult',
    badgeText: 'Adult Content',
  },
  timelimit: {
    emoji: '⏰',
    title: 'Daily Time Limit Reached',
    message: 'You\'ve used all of your allowed browsing time for today. Come back tomorrow!',
    badgeClass: 'reason-timelimit',
    badgeText: 'Time Limit',
  },
};

const cfg = configs[reason] || configs.blocklist;

document.getElementById('emoji').textContent = cfg.emoji;
document.getElementById('title').textContent = cfg.title;
document.getElementById('message').textContent = cfg.message;
document.getElementById('badge').textContent = cfg.badgeText;
document.getElementById('badge').className = `reason-badge ${cfg.badgeClass}`;

if (blockedUrl) {
  try {
    const u = new URL(blockedUrl);
    document.getElementById('blockedUrl').textContent = u.hostname;
  } catch {
    document.getElementById('blockedUrl').textContent = '';
  }
}

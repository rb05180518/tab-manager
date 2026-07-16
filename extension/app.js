/* ================================================================
   Tab Manager — Dashboard App (Pure Extension Edition)

   This file is the brain of the dashboard. Now that the dashboard
   IS the extension page (not inside an iframe), it can call
   chrome.tabs and chrome.storage directly — no postMessage bridge needed.

   What this file does:
   1. Reads open browser tabs directly via chrome.tabs.query()
   2. Groups tabs by domain with a landing pages category
   3. Renders domain cards, banners, and stats
   4. Handles all user actions (close tabs, save for later, focus tab)
   5. Stores "Saved for Later" tabs in chrome.storage.local (no server)
   ================================================================ */

"use strict";

/* ----------------------------------------------------------------
   CHROME TABS — Direct API Access

   Since this page IS the extension's new tab page, it has full
   access to chrome.tabs and chrome.storage. No middleman needed.
   ---------------------------------------------------------------- */

// All open tabs — populated by fetchOpenTabs()
let openTabs = [];

/* ----------------------------------------------------------------
   SYNC-CLOSE SETTING

   syncClose = true  → closing a tab in Tab Manager also closes the real
                        browser tab (the original behaviour).
   syncClose = false → closing only removes it from the dashboard; the
                        browser tab stays open. (DEFAULT)

   Persisted in chrome.storage.local under "syncClose".
   ---------------------------------------------------------------- */
let syncClose = false;

async function loadSyncCloseSetting() {
  const { syncClose: saved } = await chrome.storage.local.get("syncClose");
  syncClose = !!saved;
  const toggle = document.getElementById("syncCloseToggle");
  if (toggle) toggle.checked = syncClose;
}

async function setSyncClose(value) {
  syncClose = !!value;
  await chrome.storage.local.set({ syncClose });
}

/**
 * fetchOpenTabs()
 *
 * Reads all currently open browser tabs directly from Chrome.
 * Sets the extensionId flag so we can identify Tab Manager's own pages.
 */
async function fetchOpenTabs() {
  try {
    const extensionId = chrome.runtime.id;
    // The new URL for this page is now index.html (not newtab.html)
    const newtabUrl = `chrome-extension://${extensionId}/index.html`;

    const tabs = await chrome.tabs.query({});
    openTabs = tabs.map((t) => ({
      id: t.id,
      url: t.url,
      title: t.title,
      windowId: t.windowId,
      active: t.active,
      // Flag Tab Manager's own pages so we can detect duplicate new tabs
      isTabOut: t.url === newtabUrl || t.url === "chrome://newtab/",
    }));
  } catch {
    // chrome.tabs API unavailable (shouldn't happen in an extension page)
    openTabs = [];
  }
}

/* ----------------------------------------------------------------
   HIDDEN TABS — the "dashboard-only close" feature

   When syncClose is OFF, "closing" a tab in Tab Manager only hides it from
   the dashboard; the real browser tab stays open. We track hidden URLs
   here so they don't reappear on the next render.

   Hidden URLs are kept in memory only (not persisted) — they reset
   when the dashboard page is reloaded, which is the expected behaviour:
   "I hid it for now, but a fresh dashboard shows everything again."
   If the actual browser tab is closed later, we drop its URL here too.
   ---------------------------------------------------------------- */
const _hiddenTabUrls = new Set();

/** Returns true if a URL has been hidden via dashboard-only close. */
function isHiddenTab(url) {
  return _hiddenTabUrls.has(url);
}

/** Hide a single URL from the dashboard (does not touch the browser). */
function hideTabUrl(url) {
  if (url) _hiddenTabUrls.add(url);
}

/** Hide multiple URLs. */
function hideTabUrls(urls) {
  for (const u of urls) if (u) _hiddenTabUrls.add(u);
}

/**
 * closeOrHideTabs(urls)
 *
 * Unified close handler. When syncClose is ON, the browser tabs are
 * actually closed. When OFF, the URLs are only added to the hidden set
 * so they vanish from the dashboard but keep running in the browser.
 * Always re-fetches tab state afterwards.
 */
async function closeOrHideTabs(urls) {
  if (!urls || urls.length === 0) return;
  if (syncClose) {
    // Actually close the browser tabs (hostname match, like closeTabsByUrls)
    await closeTabsByUrls(urls);
  } else {
    // Dashboard-only: just hide them
    hideTabUrls(urls);
    await fetchOpenTabs();
  }
}

/**
 * closeOrHideExact(urls)
 *
 * Same as closeOrHideTabs but uses exact-URL matching (for landing pages
 * and custom-group tabs, where hostname matching would over-close).
 */
async function closeOrHideExact(urls) {
  if (!urls || urls.length === 0) return;
  if (syncClose) {
    await closeTabsExact(urls);
  } else {
    hideTabUrls(urls);
    await fetchOpenTabs();
  }
}

/**
 * closeTabsByUrls(urls)
 *
 * Closes all open tabs whose hostname matches any of the given URLs.
 * After closing, re-fetches the tab list to keep our state accurate.
 *
 * Special case: file:// URLs are matched exactly (they have no hostname).
 */
async function closeTabsByUrls(urls) {
  if (!urls || urls.length === 0) return;

  // Separate file:// URLs (exact match) from regular URLs (hostname match)
  const targetHostnames = [];
  const exactUrls = new Set();

  for (const u of urls) {
    if (u.startsWith("file://")) {
      exactUrls.add(u);
    } else {
      try {
        targetHostnames.push(new URL(u).hostname);
      } catch {
        /* skip unparseable */
      }
    }
  }

  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs
    .filter((tab) => {
      const tabUrl = tab.url || "";
      if (tabUrl.startsWith("file://") && exactUrls.has(tabUrl)) return true;
      try {
        const tabHostname = new URL(tabUrl).hostname;
        return tabHostname && targetHostnames.includes(tabHostname);
      } catch {
        return false;
      }
    })
    .map((tab) => tab.id);

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabsExact(urls)
 *
 * Closes tabs by exact URL match (not hostname). Used for landing pages
 * so closing "Gmail inbox" doesn't also close individual email threads.
 */
async function closeTabsExact(urls) {
  if (!urls || urls.length === 0) return;
  const urlSet = new Set(urls);
  const allTabs = await chrome.tabs.query({});
  const toClose = allTabs.filter((t) => urlSet.has(t.url)).map((t) => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * focusTab(url)
 *
 * Switches Chrome to the tab with the given URL (exact match first,
 * then hostname fallback). Also brings the window to the front.
 */
async function focusTab(url) {
  if (!url) return;
  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();

  // Try exact URL match first
  let matches = allTabs.filter((t) => t.url === url);

  // Fall back to hostname match
  if (matches.length === 0) {
    try {
      const targetHost = new URL(url).hostname;
      matches = allTabs.filter((t) => {
        try {
          return new URL(t.url).hostname === targetHost;
        } catch {
          return false;
        }
      });
    } catch {}
  }

  if (matches.length === 0) return;

  // Prefer a match in a different window so it actually switches windows
  const match =
    matches.find((t) => t.windowId !== currentWindow.id) || matches[0];
  await chrome.tabs.update(match.id, { active: true });
  await chrome.windows.update(match.windowId, { focused: true });
}

/**
 * closeDuplicateTabs(urls, keepOne)
 *
 * Closes duplicate tabs for the given list of URLs.
 * keepOne=true → keep one copy of each, close the rest.
 * keepOne=false → close all copies.
 */
async function closeDuplicateTabs(urls, keepOne = true) {
  const allTabs = await chrome.tabs.query({});
  const toClose = [];

  for (const url of urls) {
    const matching = allTabs.filter((t) => t.url === url);
    if (keepOne) {
      const keep = matching.find((t) => t.active) || matching[0];
      for (const tab of matching) {
        if (tab.id !== keep.id) toClose.push(tab.id);
      }
    } else {
      for (const tab of matching) toClose.push(tab.id);
    }
  }

  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/**
 * closeTabOutDupes()
 *
 * Closes all duplicate Tab Manager new-tab pages except the current one.
 */
async function closeTabOutDupes() {
  const extensionId = chrome.runtime.id;
  const newtabUrl = `chrome-extension://${extensionId}/index.html`;

  const allTabs = await chrome.tabs.query({});
  const currentWindow = await chrome.windows.getCurrent();
  const tabOutTabs = allTabs.filter(
    (t) => t.url === newtabUrl || t.url === "chrome://newtab/",
  );

  if (tabOutTabs.length <= 1) return;

  // Keep the active Tab Manager tab in the CURRENT window — that's the one the
  // user is looking at right now. Falls back to any active one, then the first.
  const keep =
    tabOutTabs.find((t) => t.active && t.windowId === currentWindow.id) ||
    tabOutTabs.find((t) => t.active) ||
    tabOutTabs[0];
  const toClose = tabOutTabs.filter((t) => t.id !== keep.id).map((t) => t.id);
  if (toClose.length > 0) await chrome.tabs.remove(toClose);
  await fetchOpenTabs();
}

/* ----------------------------------------------------------------
   SAVED FOR LATER — chrome.storage.local

   Replaces the old server-side SQLite + REST API with Chrome's
   built-in key-value storage. Data persists across browser sessions
   and doesn't require a running server.

   Data shape stored under the "deferred" key:
   [
     {
       id: "1712345678901",          // timestamp-based unique ID
       url: "https://example.com",
       title: "Example Page",
       savedAt: "2026-04-04T10:00:00.000Z",  // ISO date string
       completed: false,             // true = checked off (archived)
       dismissed: false              // true = dismissed without reading
     },
     ...
   ]
   ---------------------------------------------------------------- */

/**
 * saveTabForLater(tab)
 *
 * Saves a single tab to the "Saved for Later" list in chrome.storage.local.
 * @param {{ url: string, title: string }} tab
 */
async function saveTabForLater(tab) {
  const { deferred = [] } = await chrome.storage.local.get("deferred");
  deferred.push({
    id: Date.now().toString(),
    url: tab.url,
    title: tab.title,
    savedAt: new Date().toISOString(),
    completed: false,
    dismissed: false,
  });
  await chrome.storage.local.set({ deferred });
}

/**
 * getSavedTabs()
 *
 * Returns all saved tabs from chrome.storage.local.
 * Filters out dismissed items (those are gone for good).
 * Splits into active (not completed) and archived (completed).
 */
async function getSavedTabs() {
  const { deferred = [] } = await chrome.storage.local.get("deferred");
  const visible = deferred.filter((t) => !t.dismissed);
  return {
    active: visible.filter((t) => !t.completed),
    archived: visible.filter((t) => t.completed),
  };
}

/**
 * checkOffSavedTab(id)
 *
 * Marks a saved tab as completed (checked off). It moves to the archive.
 */
async function checkOffSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get("deferred");
  const tab = deferred.find((t) => t.id === id);
  if (tab) {
    tab.completed = true;
    tab.completedAt = new Date().toISOString();
    await chrome.storage.local.set({ deferred });
  }
}

/**
 * dismissSavedTab(id)
 *
 * Marks a saved tab as dismissed (removed from all lists).
 */
async function dismissSavedTab(id) {
  const { deferred = [] } = await chrome.storage.local.get("deferred");
  const tab = deferred.find((t) => t.id === id);
  if (tab) {
    tab.dismissed = true;
    await chrome.storage.local.set({ deferred });
  }
}

/* ----------------------------------------------------------------
   UI HELPERS
   ---------------------------------------------------------------- */

/**
 * playCloseSound()
 *
 * Plays a clean "swoosh" sound when tabs are closed.
 * Built entirely with the Web Audio API — no sound files needed.
 * A filtered noise sweep that descends in pitch, like air moving.
 */
function playCloseSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const t = ctx.currentTime;

    // Swoosh: shaped white noise through a sweeping bandpass filter
    const duration = 0.25;
    const buffer = ctx.createBuffer(
      1,
      ctx.sampleRate * duration,
      ctx.sampleRate,
    );
    const data = buffer.getChannelData(0);

    // Generate noise with a natural envelope (quick attack, smooth decay)
    for (let i = 0; i < data.length; i++) {
      const pos = i / data.length;
      // Envelope: ramps up fast in first 10%, then fades out smoothly
      const env = pos < 0.1 ? pos / 0.1 : Math.pow(1 - (pos - 0.1) / 0.9, 1.5);
      data[i] = (Math.random() * 2 - 1) * env;
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;

    // Bandpass filter sweeps from high to low — creates the "swoosh" character
    const filter = ctx.createBiquadFilter();
    filter.type = "bandpass";
    filter.Q.value = 2.0;
    filter.frequency.setValueAtTime(4000, t);
    filter.frequency.exponentialRampToValueAtTime(400, t + duration);

    // Volume
    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.15, t);
    gain.gain.exponentialRampToValueAtTime(0.001, t + duration);

    source.connect(filter).connect(gain).connect(ctx.destination);
    source.start(t);

    setTimeout(() => ctx.close(), 500);
  } catch {
    // Audio not supported — fail silently
  }
}

/**
 * shootConfetti(x, y)
 *
 * Shoots a burst of colorful confetti particles from the given screen
 * coordinates (typically the center of a card being closed).
 * Pure CSS + JS, no libraries.
 */
function shootConfetti(x, y) {
  const colors = [
    "#c8713a", // amber
    "#e8a070", // amber light
    "#5a7a62", // sage
    "#8aaa92", // sage light
    "#5a6b7a", // slate
    "#8a9baa", // slate light
    "#d4b896", // warm paper
    "#b35a5a", // rose
  ];

  const particleCount = 17;

  for (let i = 0; i < particleCount; i++) {
    const el = document.createElement("div");

    const isCircle = Math.random() > 0.5;
    const size = 5 + Math.random() * 6; // 5–11px
    const color = colors[Math.floor(Math.random() * colors.length)];

    el.style.cssText = `
      position: fixed;
      left: ${x}px;
      top: ${y}px;
      width: ${size}px;
      height: ${size}px;
      background: ${color};
      border-radius: ${isCircle ? "50%" : "2px"};
      pointer-events: none;
      z-index: 9999;
      transform: translate(-50%, -50%);
      opacity: 1;
    `;
    document.body.appendChild(el);

    // Physics: random angle and speed for the outward burst
    const angle = Math.random() * Math.PI * 2;
    const speed = 60 + Math.random() * 120;
    const vx = Math.cos(angle) * speed;
    const vy = Math.sin(angle) * speed - 80; // bias upward
    const gravity = 200;

    const startTime = performance.now();
    const duration = 700 + Math.random() * 200; // 700–900ms

    function frame(now) {
      const elapsed = (now - startTime) / 1000;
      const progress = elapsed / (duration / 1000);

      if (progress >= 1) {
        el.remove();
        return;
      }

      const px = vx * elapsed;
      const py = vy * elapsed + 0.5 * gravity * elapsed * elapsed;
      const opacity = progress < 0.5 ? 1 : 1 - (progress - 0.5) * 2;
      const rotate = elapsed * 200 * (isCircle ? 0 : 1);

      el.style.transform = `translate(calc(-50% + ${px}px), calc(-50% + ${py}px)) rotate(${rotate}deg)`;
      el.style.opacity = opacity;

      requestAnimationFrame(frame);
    }

    requestAnimationFrame(frame);
  }
}

/**
 * animateCardOut(card)
 *
 * Smoothly removes a mission card: fade + scale down, then confetti.
 * After the animation, checks if the grid is now empty.
 */
function animateCardOut(card) {
  if (!card) return;

  const rect = card.getBoundingClientRect();
  shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);

  card.classList.add("closing");
  setTimeout(() => {
    card.remove();
    checkAndShowEmptyState();
  }, 300);
}

/**
 * showToast(message)
 *
 * Brief pop-up notification at the bottom of the screen.
 */
function showToast(message) {
  const toast = document.getElementById("toast");
  document.getElementById("toastText").textContent = message;
  toast.classList.add("visible");
  setTimeout(() => toast.classList.remove("visible"), 2500);
}

/* ----------------------------------------------------------------
   CONFIRM DIALOG — second confirmation for destructive actions

   confirmAction(message) returns a Promise<boolean>.
   Resolves true when the user clicks 确认, false on 取消 / Esc / overlay click.
   ---------------------------------------------------------------- */

let _confirmResolve = null;

/**
 * closeConfirm(result)
 *
 * Hides the confirm dialog and resolves the pending promise.
 */
function closeConfirm(result) {
  const overlay = document.getElementById("confirmOverlay");
  if (overlay) overlay.style.display = "none";
  if (_confirmResolve) {
    const resolve = _confirmResolve;
    _confirmResolve = null;
    resolve(result);
  }
}

/**
 * confirmAction(message)
 *
 * Shows a confirmation dialog and waits for the user's choice.
 * @param {string} message
 * @returns {Promise<boolean>}
 */
function confirmAction(message) {
  return new Promise((resolve) => {
    // If another confirmation is somehow pending, resolve it as false first
    if (_confirmResolve) closeConfirm(false);

    _confirmResolve = resolve;
    document.getElementById("confirmMessage").textContent = message;
    document.getElementById("confirmOverlay").style.display = "flex";
    // Focus the confirm button so Enter works immediately
    setTimeout(() => document.getElementById("confirmOk")?.focus(), 50);
  });
}

// Wire up the confirm dialog buttons + keyboard + overlay-click
document.addEventListener("click", (e) => {
  if (e.target.id === "confirmOverlay") {
    closeConfirm(false);
    return;
  }
  if (e.target.id === "confirmOk") {
    closeConfirm(true);
    return;
  }
  if (e.target.id === "confirmCancel") {
    closeConfirm(false);
    return;
  }
});

document.addEventListener("keydown", (e) => {
  const overlay = document.getElementById("confirmOverlay");
  if (!overlay || overlay.style.display === "none") return;
  if (e.key === "Enter") {
    e.preventDefault();
    closeConfirm(true);
  } else if (e.key === "Escape") {
    e.preventDefault();
    closeConfirm(false);
  }
});

/**
 * checkAndShowEmptyState()
 *
 * Shows a cheerful "Inbox zero" message when all domain cards are gone.
 */
function checkAndShowEmptyState() {
  const missionsEl = document.getElementById("openTabsMissions");
  if (!missionsEl) return;

  const remaining = missionsEl.querySelectorAll(
    ".mission-card:not(.closing)",
  ).length;
  if (remaining > 0) return;

  missionsEl.innerHTML = `
    <div class="missions-empty-state">
      <div class="empty-checkmark">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.5" stroke="currentColor">
          <path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" />
        </svg>
      </div>
      <div class="empty-title">标签页清零了。</div>
      <div class="empty-subtitle">你自由了。</div>
    </div>
  `;

  const countEl = document.getElementById("openTabsSectionCount");
  if (countEl) countEl.textContent = "0 个域名";
}

/**
 * timeAgo(dateStr)
 *
 * Converts an ISO date string into a human-friendly relative time.
 * "2026-04-04T10:00:00Z" → "2 hrs ago" or "yesterday"
 */
function timeAgo(dateStr) {
  if (!dateStr) return "";
  const then = new Date(dateStr);
  const now = new Date();
  const diffMins = Math.floor((now - then) / 60000);
  const diffHours = Math.floor((now - then) / 3600000);
  const diffDays = Math.floor((now - then) / 86400000);

  if (diffMins < 1) return "刚刚";
  if (diffMins < 60) return diffMins + " 分钟前";
  if (diffHours < 24) return diffHours + " 小时前";
  if (diffDays === 1) return "昨天";
  return diffDays + " 天前";
}

/**
 * getGreeting() — "Good morning / afternoon / evening"
 */
function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "早上好";
  if (hour < 17) return "下午好";
  return "晚上好";
}

/**
 * getDateDisplay() — "Friday, April 4, 2026"
 */
function getDateDisplay() {
  return new Date().toLocaleDateString("zh-CN", {
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

/* ----------------------------------------------------------------
   DOMAIN & TITLE CLEANUP HELPERS
   ---------------------------------------------------------------- */

// Map of known hostnames → friendly display names.
const FRIENDLY_DOMAINS = {
  "github.com": "GitHub",
  "www.github.com": "GitHub",
  "gist.github.com": "GitHub Gist",
  "youtube.com": "YouTube",
  "www.youtube.com": "YouTube",
  "music.youtube.com": "YouTube Music",
  "x.com": "X",
  "www.x.com": "X",
  "twitter.com": "X",
  "www.twitter.com": "X",
  "reddit.com": "Reddit",
  "www.reddit.com": "Reddit",
  "old.reddit.com": "Reddit",
  "substack.com": "Substack",
  "www.substack.com": "Substack",
  "medium.com": "Medium",
  "www.medium.com": "Medium",
  "linkedin.com": "LinkedIn",
  "www.linkedin.com": "LinkedIn",
  "stackoverflow.com": "Stack Overflow",
  "www.stackoverflow.com": "Stack Overflow",
  "news.ycombinator.com": "Hacker News",
  "google.com": "Google",
  "www.google.com": "Google",
  "mail.google.com": "Gmail",
  "docs.google.com": "Google Docs",
  "drive.google.com": "Google Drive",
  "calendar.google.com": "Google Calendar",
  "meet.google.com": "Google Meet",
  "gemini.google.com": "Gemini",
  "chatgpt.com": "ChatGPT",
  "www.chatgpt.com": "ChatGPT",
  "chat.openai.com": "ChatGPT",
  "claude.ai": "Claude",
  "www.claude.ai": "Claude",
  "code.claude.com": "Claude Code",
  "notion.so": "Notion",
  "www.notion.so": "Notion",
  "figma.com": "Figma",
  "www.figma.com": "Figma",
  "slack.com": "Slack",
  "app.slack.com": "Slack",
  "discord.com": "Discord",
  "www.discord.com": "Discord",
  "wikipedia.org": "Wikipedia",
  "en.wikipedia.org": "Wikipedia",
  "amazon.com": "Amazon",
  "www.amazon.com": "Amazon",
  "netflix.com": "Netflix",
  "www.netflix.com": "Netflix",
  "spotify.com": "Spotify",
  "open.spotify.com": "Spotify",
  "vercel.com": "Vercel",
  "www.vercel.com": "Vercel",
  "npmjs.com": "npm",
  "www.npmjs.com": "npm",
  "developer.mozilla.org": "MDN",
  "arxiv.org": "arXiv",
  "www.arxiv.org": "arXiv",
  "huggingface.co": "Hugging Face",
  "www.huggingface.co": "Hugging Face",
  "producthunt.com": "Product Hunt",
  "www.producthunt.com": "Product Hunt",
  "xiaohongshu.com": "RedNote",
  "www.xiaohongshu.com": "RedNote",
  "local-files": "本地文件",
};

function friendlyDomain(hostname) {
  if (!hostname) return "";
  if (FRIENDLY_DOMAINS[hostname]) return FRIENDLY_DOMAINS[hostname];

  if (hostname.endsWith(".substack.com") && hostname !== "substack.com") {
    return capitalize(hostname.replace(".substack.com", "")) + " 的 Substack";
  }
  if (hostname.endsWith(".github.io")) {
    return capitalize(hostname.replace(".github.io", "")) + "(GitHub Pages)";
  }

  let clean = hostname
    .replace(/^www\./, "")
    .replace(
      /\.(com|org|net|io|co|ai|dev|app|so|me|xyz|info|us|uk|co\.uk|co\.jp)$/,
      "",
    );

  return clean
    .split(".")
    .map((part) => capitalize(part))
    .join(" ");
}

function capitalize(str) {
  if (!str) return "";
  return str.charAt(0).toUpperCase() + str.slice(1);
}

function stripTitleNoise(title) {
  if (!title) return "";
  // Strip leading notification count: "(2) Title"
  title = title.replace(/^\(\d+\+?\)\s*/, "");
  // Strip inline counts like "Inbox (16,359)"
  title = title.replace(/\s*\([\d,]+\+?\)\s*/g, " ");
  // Strip email addresses (privacy + cleaner display)
  title = title.replace(
    /\s*[\-\u2010-\u2015]\s*[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
    "",
  );
  title = title.replace(
    /[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g,
    "",
  );
  // Clean X/Twitter format
  title = title.replace(/\s+on X:\s*/, ": ");
  title = title.replace(/\s*\/\s*X\s*$/, "");
  return title.trim();
}

function cleanTitle(title, hostname) {
  if (!title || !hostname) return title || "";

  const friendly = friendlyDomain(hostname);
  const domain = hostname.replace(/^www\./, "");
  const seps = [" - ", " | ", " — ", " · ", " – "];

  for (const sep of seps) {
    const idx = title.lastIndexOf(sep);
    if (idx === -1) continue;
    const suffix = title.slice(idx + sep.length).trim();
    const suffixLow = suffix.toLowerCase();
    if (
      suffixLow === domain.toLowerCase() ||
      suffixLow === friendly.toLowerCase() ||
      suffixLow === domain.replace(/\.\w+$/, "").toLowerCase() ||
      domain.toLowerCase().includes(suffixLow) ||
      friendly.toLowerCase().includes(suffixLow)
    ) {
      const cleaned = title.slice(0, idx).trim();
      if (cleaned.length >= 5) return cleaned;
    }
  }
  return title;
}

function smartTitle(title, url) {
  if (!url) return title || "";
  let pathname = "",
    hostname = "";
  try {
    const u = new URL(url);
    pathname = u.pathname;
    hostname = u.hostname;
  } catch {
    return title || "";
  }

  const titleIsUrl =
    !title ||
    title === url ||
    title.startsWith(hostname) ||
    title.startsWith("http");

  if (
    (hostname === "x.com" ||
      hostname === "twitter.com" ||
      hostname === "www.x.com") &&
    pathname.includes("/status/")
  ) {
    const username = pathname.split("/")[1];
    if (username) return titleIsUrl ? `@${username} 的帖子` : title;
  }

  if (hostname === "github.com" || hostname === "www.github.com") {
    const parts = pathname.split("/").filter(Boolean);
    if (parts.length >= 2) {
      const [owner, repo, ...rest] = parts;
      if (rest[0] === "issues" && rest[1])
        return `${owner}/${repo} 议题 #${rest[1]}`;
      if (rest[0] === "pull" && rest[1])
        return `${owner}/${repo} PR #${rest[1]}`;
      if (rest[0] === "blob" || rest[0] === "tree")
        return `${owner}/${repo} — ${rest.slice(2).join("/")}`;
      if (titleIsUrl) return `${owner}/${repo}`;
    }
  }

  if (
    (hostname === "www.youtube.com" || hostname === "youtube.com") &&
    pathname === "/watch"
  ) {
    if (titleIsUrl) return "YouTube 视频";
  }

  if (
    (hostname === "www.reddit.com" ||
      hostname === "reddit.com" ||
      hostname === "old.reddit.com") &&
    pathname.includes("/comments/")
  ) {
    const parts = pathname.split("/").filter(Boolean);
    const subIdx = parts.indexOf("r");
    if (subIdx !== -1 && parts[subIdx + 1]) {
      if (titleIsUrl) return `r/${parts[subIdx + 1]} 帖子`;
    }
  }

  return title || url;
}

/* ----------------------------------------------------------------
   SVG ICON STRINGS
   ---------------------------------------------------------------- */
const ICONS = {
  tabs: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M3 8.25V18a2.25 2.25 0 0 0 2.25 2.25h13.5A2.25 2.25 0 0 0 21 18V8.25m-18 0V6a2.25 2.25 0 0 1 2.25-2.25h13.5A2.25 2.25 0 0 1 21 6v2.25m-18 0h18" /></svg>`,
  close: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>`,
  archive: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M20.25 7.5l-.625 10.632a2.25 2.25 0 0 1-2.247 2.118H6.622a2.25 2.25 0 0 1-2.247-2.118L3.75 7.5m6 4.125l2.25 2.25m0 0l2.25 2.25M12 13.875l2.25-2.25M12 13.875l-2.25 2.25M3.375 7.5h17.25c.621 0 1.125-.504 1.125-1.125v-1.5c0-.621-.504-1.125-1.125-1.125H3.375c-.621 0-1.125.504-1.125 1.125v1.5c0 .621.504 1.125 1.125 1.125Z" /></svg>`,
  focus: `<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 19.5 15-15m0 0H8.25m11.25 0v11.25" /></svg>`,
};

/* ----------------------------------------------------------------
   IN-MEMORY STORE FOR OPEN-TAB GROUPS
   ---------------------------------------------------------------- */
let domainGroups = [];

/* ----------------------------------------------------------------
   HELPER: filter out browser-internal pages
   ---------------------------------------------------------------- */

/**
 * getRealTabs()
 *
 * Returns tabs that are real web pages — no chrome://, extension
 * pages, about:blank, etc.
 */
function getRealTabs() {
  // Drop hidden URLs that are no longer open (browser tab was closed) so
  // the hidden set doesn't grow unbounded with stale entries.
  const openUrls = new Set(openTabs.map((t) => t.url));
  for (const u of [..._hiddenTabUrls]) {
    if (!openUrls.has(u)) _hiddenTabUrls.delete(u);
  }

  return openTabs.filter((t) => {
    const url = t.url || "";
    if (isHiddenTab(url)) return false; // dashboard-only hidden tab
    return (
      !url.startsWith("chrome://") &&
      !url.startsWith("chrome-extension://") &&
      !url.startsWith("about:") &&
      !url.startsWith("edge://") &&
      !url.startsWith("brave://")
    );
  });
}

/**
 * checkTabOutDupes()
 *
 * Counts how many Tab Manager pages are open. If more than 1,
 * shows a banner offering to close the extras.
 */
function checkTabOutDupes() {
  const tabOutTabs = openTabs.filter((t) => t.isTabOut);
  const banner = document.getElementById("tabOutDupeBanner");
  const countEl = document.getElementById("tabOutDupeCount");
  if (!banner) return;

  if (tabOutTabs.length > 1) {
    if (countEl) countEl.textContent = tabOutTabs.length;
    banner.style.display = "flex";
  } else {
    banner.style.display = "none";
  }
}

/* ----------------------------------------------------------------
   OVERFLOW CHIPS ("+N more" expand button in domain cards)
   ---------------------------------------------------------------- */

function buildOverflowChips(hiddenTabs, urlCounts = {}) {
  const hiddenChips = hiddenTabs
    .map((tab) => {
      const label = cleanTitle(
        smartTitle(stripTitleNoise(tab.title || ""), tab.url),
        "",
      );
      const count = urlCounts[tab.url] || 1;
      const dupeTag =
        count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : "";
      const chipClass = count > 1 ? " chip-has-dupes" : "";
      const safeUrl = (tab.url || "").replace(/"/g, "&quot;");
      const safeTitle = label.replace(/"/g, "&quot;");
      let domain = "";
      try {
        domain = new URL(tab.url).hostname;
      } catch {}
      const faviconUrl = domain
        ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16`
        : "";
      return `<div class="page-chip clickable${chipClass}" draggable="true" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      <span class="chip-select" data-action="toggle-select" data-tab-url="${safeUrl}" title="选择"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="3" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg></span>
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ""}
      <span class="chip-text">${label}</span>${dupeTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="稍后查看">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="关闭此标签页">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
    })
    .join("");

  return `
    <div class="page-chips-overflow" style="display:none">${hiddenChips}</div>
    <div class="page-chip page-chip-overflow clickable" data-action="expand-chips">
      <span class="chip-text">还有 ${hiddenTabs.length} 个</span>
    </div>`;
}

/* ----------------------------------------------------------------
   DOMAIN CARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderDomainCard(group, groupIndex)
 *
 * Builds the HTML for one domain group card.
 * group = { domain: string, tabs: [{ url, title, id, windowId, active }] }
 */
function renderDomainCard(group) {
  const tabs = group.tabs || [];
  const tabCount = tabs.length;
  const isLanding = group.domain === "__landing-pages__";
  const stableId = "domain-" + group.domain.replace(/[^a-z0-9]/g, "-");

  // Count duplicates (exact URL match)
  const urlCounts = {};
  for (const tab of tabs) urlCounts[tab.url] = (urlCounts[tab.url] || 0) + 1;
  const dupeUrls = Object.entries(urlCounts).filter(([, c]) => c > 1);
  const hasDupes = dupeUrls.length > 0;
  const totalExtras = dupeUrls.reduce((s, [, c]) => s + c - 1, 0);

  const tabBadge = `<span class="open-tabs-badge">
    ${ICONS.tabs}
    ${tabCount} 个标签页打开中
  </span>`;

  const dupeBadge = hasDupes
    ? `<span class="open-tabs-badge" style="color:var(--accent-amber);background:rgba(200,113,58,0.08);">
        ${totalExtras} 个重复
      </span>`
    : "";

  // Deduplicate for display: show each URL once, with (Nx) badge if duped
  const seen = new Set();
  const uniqueTabs = [];
  for (const tab of tabs) {
    if (!seen.has(tab.url)) {
      seen.add(tab.url);
      uniqueTabs.push(tab);
    }
  }

  const visibleTabs = uniqueTabs.slice(0, 8);
  const extraCount = uniqueTabs.length - visibleTabs.length;

  const pageChips =
    visibleTabs
      .map((tab) => {
        let label = cleanTitle(
          smartTitle(stripTitleNoise(tab.title || ""), tab.url),
          group.domain,
        );
        // For localhost tabs, prepend port number so you can tell projects apart
        try {
          const parsed = new URL(tab.url);
          if (parsed.hostname === "localhost" && parsed.port)
            label = `${parsed.port} ${label}`;
        } catch {}
        const count = urlCounts[tab.url];
        const dupeTag =
          count > 1 ? ` <span class="chip-dupe-badge">(${count}x)</span>` : "";
        const chipClass = count > 1 ? " chip-has-dupes" : "";
        const safeUrl = (tab.url || "").replace(/"/g, "&quot;");
        const safeTitle = label.replace(/"/g, "&quot;");
        let domain = "";
        try {
          domain = new URL(tab.url).hostname;
        } catch {}
        const faviconUrl = domain
          ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16`
          : "";
        const groupId = urlToGroupId(tab.url);
        const groupTag = groupId
          ? ` <span class="chip-grouped-badge">已分组</span>`
          : "";
        return `<div class="page-chip clickable${chipClass}" draggable="true" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
      <span class="chip-select" data-action="toggle-select" data-tab-url="${safeUrl}" title="选择"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="3" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg></span>
      ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ""}
      <span class="chip-text">${label}</span>${dupeTag}${groupTag}
      <div class="chip-actions">
        <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="稍后查看">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
        </button>
        <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="关闭此标签页">
          <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
        </button>
      </div>
    </div>`;
      })
      .join("") +
    (extraCount > 0 ? buildOverflowChips(uniqueTabs.slice(8), urlCounts) : "");

  let actionsHtml = `
    <button class="action-btn close-tabs" data-action="close-domain-tabs" data-domain-id="${stableId}">
      ${ICONS.close}
      关闭全部 ${tabCount} 个标签页
    </button>`;

  if (hasDupes) {
    const dupeUrlsEncoded = dupeUrls
      .map(([url]) => encodeURIComponent(url))
      .join(",");
    actionsHtml += `
      <button class="action-btn" data-action="dedup-keep-one" data-dupe-urls="${dupeUrlsEncoded}">
        关闭 ${totalExtras} 个重复
      </button>`;
  }

  return `
    <div class="mission-card domain-card ${hasDupes ? "has-amber-bar" : "has-neutral-bar"}" data-domain-id="${stableId}">
      <div class="status-bar"></div>
      <div class="mission-content">
        <div class="mission-top">
          <span class="mission-name">${isLanding ? "主页" : group.label || friendlyDomain(group.domain)}</span>
          ${tabBadge}
          ${dupeBadge}
        </div>
        <div class="mission-pages">${pageChips}</div>
        <div class="actions">${actionsHtml}</div>
      </div>
      <div class="mission-meta">
        <div class="mission-page-count">${tabCount}</div>
        <div class="mission-page-label">个标签页</div>
      </div>
    </div>`;
}

/* ----------------------------------------------------------------
   SAVED FOR LATER — Render Checklist Column
   ---------------------------------------------------------------- */

/**
 * renderDeferredColumn()
 *
 * Reads saved tabs from chrome.storage.local and renders the right-side
 * "Saved for Later" checklist column. Shows active items as a checklist
 * and completed items in a collapsible archive.
 */
async function renderDeferredColumn() {
  const column = document.getElementById("deferredColumn");
  const list = document.getElementById("deferredList");
  const empty = document.getElementById("deferredEmpty");
  const countEl = document.getElementById("deferredCount");
  const archiveEl = document.getElementById("deferredArchive");
  const archiveCountEl = document.getElementById("archiveCount");
  const archiveList = document.getElementById("archiveList");

  if (!column) return;

  try {
    const { active, archived } = await getSavedTabs();

    // Hide the entire column if there's nothing to show
    if (active.length === 0 && archived.length === 0) {
      column.style.display = "none";
      return;
    }

    column.style.display = "block";

    // Render active checklist items
    if (active.length > 0) {
      countEl.textContent = `${active.length} 项`;
      list.innerHTML = active.map((item) => renderDeferredItem(item)).join("");
      list.style.display = "block";
      empty.style.display = "none";
    } else {
      list.style.display = "none";
      countEl.textContent = "";
      empty.style.display = "block";
    }

    // Render archive section
    if (archived.length > 0) {
      archiveCountEl.textContent = `(${archived.length})`;
      archiveList.innerHTML = archived
        .map((item) => renderArchiveItem(item))
        .join("");
      archiveEl.style.display = "block";
    } else {
      archiveEl.style.display = "none";
    }
  } catch (err) {
    console.warn("[tab-manager] Could not load saved tabs:", err);
    column.style.display = "none";
  }
}

/**
 * renderDeferredItem(item)
 *
 * Builds HTML for one active checklist item: checkbox, title link,
 * domain, time ago, dismiss button.
 */
function renderDeferredItem(item) {
  let domain = "";
  try {
    domain = new URL(item.url).hostname.replace(/^www\./, "");
  } catch {}
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=16`;
  const ago = timeAgo(item.savedAt);

  return `
    <div class="deferred-item" data-deferred-id="${item.id}">
      <input type="checkbox" class="deferred-checkbox" data-action="check-deferred" data-deferred-id="${item.id}">
      <div class="deferred-info">
        <a href="${item.url}" target="_blank" rel="noopener" class="deferred-title" title="${(item.title || "").replace(/"/g, "&quot;")}">
          <img src="${faviconUrl}" alt="" style="width:14px;height:14px;vertical-align:-2px;margin-right:4px" onerror="this.style.display='none'">${item.title || item.url}
        </a>
        <div class="deferred-meta">
          <span>${domain}</span>
          <span>${ago}</span>
        </div>
      </div>
      <button class="deferred-dismiss" data-action="dismiss-deferred" data-deferred-id="${item.id}" title="忽略">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
    </div>`;
}

/**
 * renderArchiveItem(item)
 *
 * Builds HTML for one completed/archived item (simpler: just title + date).
 */
function renderArchiveItem(item) {
  const ago = item.completedAt
    ? timeAgo(item.completedAt)
    : timeAgo(item.savedAt);
  return `
    <div class="archive-item">
      <a href="${item.url}" target="_blank" rel="noopener" class="archive-item-title" title="${(item.title || "").replace(/"/g, "&quot;")}">
        ${item.title || item.url}
      </a>
      <span class="archive-item-date">${ago}</span>
    </div>`;
}

/* ----------------------------------------------------------------
   MAIN DASHBOARD RENDERER
   ---------------------------------------------------------------- */

/**
 * renderStaticDashboard()
 *
 * The main render function:
 * 1. Paints greeting + date
 * 2. Fetches open tabs via chrome.tabs.query()
 * 3. Groups tabs by domain (with landing pages pulled out to their own group)
 * 4. Renders domain cards
 * 5. Updates footer stats
 * 6. Renders the "Saved for Later" checklist
 */
async function renderStaticDashboard() {
  // --- Header ---
  const greetingEl = document.getElementById("greeting");
  const dateEl = document.getElementById("dateDisplay");
  if (greetingEl) greetingEl.textContent = getGreeting();
  if (dateEl) dateEl.textContent = getDateDisplay();

  // --- Fetch tabs ---
  await fetchOpenTabs();
  const realTabs = getRealTabs();

  // --- Group tabs by domain ---
  // Landing pages (Gmail inbox, Twitter home, etc.) get their own special group
  // so they can be closed together without affecting content tabs on the same domain.
  const LANDING_PAGE_PATTERNS = [
    {
      hostname: "mail.google.com",
      test: (p, h) =>
        !h.includes("#inbox/") &&
        !h.includes("#sent/") &&
        !h.includes("#search/"),
    },
    { hostname: "x.com", pathExact: ["/home"] },
    { hostname: "www.linkedin.com", pathExact: ["/"] },
    { hostname: "github.com", pathExact: ["/"] },
    { hostname: "www.youtube.com", pathExact: ["/"] },
    // Merge personal patterns from config.local.js (if it exists)
    ...(typeof LOCAL_LANDING_PAGE_PATTERNS !== "undefined"
      ? LOCAL_LANDING_PAGE_PATTERNS
      : []),
  ];

  function isLandingPage(url) {
    try {
      const parsed = new URL(url);
      return LANDING_PAGE_PATTERNS.some((p) => {
        // Support both exact hostname and suffix matching (for wildcard subdomains)
        const hostnameMatch = p.hostname
          ? parsed.hostname === p.hostname
          : p.hostnameEndsWith
            ? parsed.hostname.endsWith(p.hostnameEndsWith)
            : false;
        if (!hostnameMatch) return false;
        if (p.test) return p.test(parsed.pathname, url);
        if (p.pathPrefix) return parsed.pathname.startsWith(p.pathPrefix);
        if (p.pathExact) return p.pathExact.includes(parsed.pathname);
        return parsed.pathname === "/";
      });
    } catch {
      return false;
    }
  }

  domainGroups = [];
  const groupMap = {};
  const landingTabs = [];

  // Custom group rules from config.local.js (if any)
  const customGroups =
    typeof LOCAL_CUSTOM_GROUPS !== "undefined" ? LOCAL_CUSTOM_GROUPS : [];

  // Check if a URL matches a custom group rule; returns the rule or null
  function matchCustomGroup(url) {
    try {
      const parsed = new URL(url);
      return (
        customGroups.find((r) => {
          const hostMatch = r.hostname
            ? parsed.hostname === r.hostname
            : r.hostnameEndsWith
              ? parsed.hostname.endsWith(r.hostnameEndsWith)
              : false;
          if (!hostMatch) return false;
          if (r.pathPrefix) return parsed.pathname.startsWith(r.pathPrefix);
          return true; // hostname matched, no path filter
        }) || null
      );
    } catch {
      return null;
    }
  }

  for (const tab of realTabs) {
    try {
      if (isLandingPage(tab.url)) {
        landingTabs.push(tab);
        continue;
      }

      // Check custom group rules first (e.g. merge subdomains, split by path)
      const customRule = matchCustomGroup(tab.url);
      if (customRule) {
        const key = customRule.groupKey;
        if (!groupMap[key])
          groupMap[key] = {
            domain: key,
            label: customRule.groupLabel,
            tabs: [],
          };
        groupMap[key].tabs.push(tab);
        continue;
      }

      let hostname;
      if (tab.url && tab.url.startsWith("file://")) {
        hostname = "local-files";
      } else {
        hostname = new URL(tab.url).hostname;
      }
      if (!hostname) continue;

      if (!groupMap[hostname])
        groupMap[hostname] = { domain: hostname, tabs: [] };
      groupMap[hostname].tabs.push(tab);
    } catch {
      // Skip malformed URLs
    }
  }

  if (landingTabs.length > 0) {
    groupMap["__landing-pages__"] = {
      domain: "__landing-pages__",
      tabs: landingTabs,
    };
  }

  // Sort: landing pages first, then domains from landing page sites, then by tab count
  // Collect exact hostnames and suffix patterns for priority sorting
  const landingHostnames = new Set(
    LANDING_PAGE_PATTERNS.map((p) => p.hostname).filter(Boolean),
  );
  const landingSuffixes = LANDING_PAGE_PATTERNS.map(
    (p) => p.hostnameEndsWith,
  ).filter(Boolean);
  function isLandingDomain(domain) {
    if (landingHostnames.has(domain)) return true;
    return landingSuffixes.some((s) => domain.endsWith(s));
  }
  domainGroups = Object.values(groupMap).sort((a, b) => {
    const aIsLanding = a.domain === "__landing-pages__";
    const bIsLanding = b.domain === "__landing-pages__";
    if (aIsLanding !== bIsLanding) return aIsLanding ? -1 : 1;

    const aIsPriority = isLandingDomain(a.domain);
    const bIsPriority = isLandingDomain(b.domain);
    if (aIsPriority !== bIsPriority) return aIsPriority ? -1 : 1;

    return b.tabs.length - a.tabs.length;
  });

  // --- Render domain cards ---
  const openTabsSection = document.getElementById("openTabsSection");
  const openTabsMissionsEl = document.getElementById("openTabsMissions");
  const openTabsSectionCount = document.getElementById("openTabsSectionCount");
  const openTabsSectionTitle = document.getElementById("openTabsSectionTitle");

  if (domainGroups.length > 0 && openTabsSection) {
    if (openTabsSectionTitle) openTabsSectionTitle.textContent = "打开的标签页";
    openTabsSectionCount.innerHTML = `${domainGroups.length} 个域名 &nbsp;&middot;&nbsp; <button class="action-btn close-tabs" data-action="close-all-open-tabs" style="font-size:11px;padding:3px 10px;">${ICONS.close} 关闭全部 ${realTabs.length} 个标签页</button>`;
    openTabsMissionsEl.innerHTML = domainGroups
      .map((g) => renderDomainCard(g))
      .join("");
    openTabsSection.style.display = "block";
  } else if (openTabsSection) {
    openTabsSection.style.display = "none";
  }

  // --- Footer stats ---
  const statTabs = document.getElementById("statTabs");
  if (statTabs) statTabs.textContent = openTabs.length;

  // --- Check for duplicate Tab Manager tabs ---
  checkTabOutDupes();

  // --- Render custom groups (drag-to-group cards) ---
  customTabGroups = await getTabGroups();
  renderCustomGroups();

  // --- Render "Saved for Later" column ---
  await renderDeferredColumn();
}

async function renderDashboard() {
  await renderStaticDashboard();
}

/* ----------------------------------------------------------------
   SEARCH — flat cross-domain search across open tabs

   While the user types, the grouped domain view is hidden and a flat
   list of matching tabs is shown instead. Clearing the query restores
   the normal grouped view.
   ---------------------------------------------------------------- */

let _searchDebounce = null;

/**
 * renderSearchResults(query)
 *
 * Filters all real open tabs by title/url, dedupes by URL, and renders
 * a flat list of clickable results with favicon + domain + actions.
 */
function renderSearchResults(query) {
  const resultsEl = document.getElementById("searchResults");
  if (!resultsEl) return;

  const q = query.trim().toLowerCase();
  const tabs = getRealTabs();

  // Dedupe by URL so duplicate tabs show once
  const seen = new Set();
  const matches = [];
  for (const tab of tabs) {
    if (seen.has(tab.url)) continue;
    const title = (tab.title || "").toLowerCase();
    const url = (tab.url || "").toLowerCase();
    if (title.includes(q) || url.includes(q)) {
      seen.add(tab.url);
      matches.push(tab);
    }
  }

  const searchClear = document.getElementById("searchClear");

  if (matches.length === 0) {
    resultsEl.innerHTML =
      '<div class="search-empty">没有找到匹配的标签页</div>';
  } else {
    resultsEl.innerHTML = matches
      .map((tab) => {
        const label = cleanTitle(
          smartTitle(stripTitleNoise(tab.title || ""), tab.url),
          "",
        );
        let domain = "";
        try {
          domain = new URL(tab.url).hostname.replace(/^www\./, "");
        } catch {}
        const faviconUrl = domain
          ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16`
          : "";
        const safeUrl = (tab.url || "").replace(/"/g, "&quot;");
        const safeTitle = label.replace(/"/g, "&quot;");
        return `<div class="search-result-item clickable" data-action="focus-tab" data-tab-url="${safeUrl}" title="${safeTitle}">
        ${faviconUrl ? `<img src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ""}
        <span class="search-result-title">${label}</span>
        <span class="search-result-domain">${domain}</span>
        <div class="chip-actions">
          <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="稍后查看">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
          </button>
          <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="关闭此标签页">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
          </button>
        </div>
      </div>`;
      })
      .join("");
  }

  resultsEl.style.display = "block";
  if (searchClear) searchClear.style.display = q ? "inline-flex" : "none";
}

/**
 * clearSearch()
 *
 * Clears the search input and restores the normal grouped view.
 */
function clearSearch() {
  const input = document.getElementById("tabSearch");
  const resultsEl = document.getElementById("searchResults");
  const openTabsSection = document.getElementById("openTabsSection");
  const searchClear = document.getElementById("searchClear");

  if (input) input.value = "";
  if (resultsEl) {
    resultsEl.style.display = "none";
    resultsEl.innerHTML = "";
  }
  if (searchClear) searchClear.style.display = "none";
  if (openTabsSection) {
    openTabsSection.style.display = "block";
    // Restore the elements hidden during search
    const missionsEl = document.getElementById("openTabsMissions");
    const headerEl = openTabsSection.querySelector(".section-header");
    const customEl = document.getElementById("customGroups");
    if (missionsEl) missionsEl.style.display = "";
    if (headerEl) headerEl.style.display = "";
    if (customEl) customEl.style.display = "";
  }
}

// ---- Search input — debounced filter ----
document.addEventListener("input", (e) => {
  if (e.target.id !== "tabSearch") return;
  clearTimeout(_searchDebounce);
  _searchDebounce = setTimeout(() => {
    const q = e.target.value.trim();
    const openTabsSection = document.getElementById("openTabsSection");
    const resultsEl = document.getElementById("searchResults");

    if (q.length === 0) {
      clearSearch();
      return;
    }

    // Hide the grouped view, show flat results
    if (openTabsSection) {
      // Keep the section visible (so the search results show in-flow),
      // but hide the missions grid. Actually: we hide the whole open-tabs
      // section and show results independently above it.
      const missionsEl = document.getElementById("openTabsMissions");
      const headerEl = openTabsSection.querySelector(".section-header");
      const customEl = document.getElementById("customGroups");
      if (missionsEl) missionsEl.style.display = "none";
      if (headerEl) headerEl.style.display = "none";
      if (customEl) customEl.style.display = "none";
    }
    renderSearchResults(q);
  }, 120);
});

// ---- Search keyboard — Esc clears ----
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && e.target.id === "tabSearch") {
    clearSearch();
    e.target.blur();
  }
});

// ---- Search clear button ----
document.addEventListener("click", (e) => {
  if (e.target.closest("#searchClear")) {
    clearSearch();
    document.getElementById("tabSearch")?.focus();
  }
});

/* ----------------------------------------------------------------
   CUSTOM GROUPS — dashboard-only tab groups with drag & drop

   Groups live in chrome.storage.local under the "tabGroups" key:
     [{ id, name, color, tabUrls: [url, ...] }, ...]
   Dragging a tab chip onto a group card adds its URL to that group.
   Groups are purely visual — they don't touch the browser tab strip.
   ---------------------------------------------------------------- */

const GROUP_COLORS = ["amber", "sage", "slate", "rose"];

// In-memory cache of custom groups (refreshed from storage each render)
let customTabGroups = [];

/**
 * getTabGroups() / saveTabGroups(groups)
 *
 * Read/write custom groups to chrome.storage.local.
 */
async function getTabGroups() {
  const { tabGroups = [] } = await chrome.storage.local.get("tabGroups");
  return tabGroups;
}

async function saveTabGroups(groups) {
  customTabGroups = groups;
  await chrome.storage.local.set({ tabGroups: groups });
}

/**
 * urlToGroupId(url)
 *
 * Returns the group id a URL belongs to, or null if ungrouped.
 */
function urlToGroupId(url) {
  for (const g of customTabGroups) {
    if (g.tabUrls.includes(url)) return g.id;
  }
  return null;
}

/**
 * renderCustomGroups()
 *
 * Renders all custom group cards into #customGroups. Each card shows
 * its tabs (matching URLs currently open) and acts as a drop target.
 */
function renderCustomGroups() {
  const container = document.getElementById("customGroups");
  if (!container) return;

  if (customTabGroups.length === 0) {
    container.style.display = "none";
    container.innerHTML = "";
    return;
  }

  container.style.display = "flex";
  const realTabs = getRealTabs();

  container.innerHTML = customTabGroups
    .map((group) => {
      // Resolve which of the group's URLs are actually open right now
      const openUrls = new Set(realTabs.map((t) => t.url));
      const tabs = group.tabUrls
        .filter((url) => openUrls.has(url))
        .map((url) => {
          const tab = realTabs.find((t) => t.url === url);
          return tab || { url };
        });

      const colorClass = `color-${group.color || "amber"}`;
      const safeName = (group.name || "未命名分组").replace(/"/g, "&quot;");

      const chipsHtml =
        tabs.length > 0
          ? tabs.map((tab) => buildGroupTabChip(tab, group.id)).join("")
          : '<div class="group-empty">拖动标签页到这里加入分组</div>';

      return `
      <div class="custom-group-card ${colorClass}" data-group-id="${group.id}">
        <div class="group-card-header">
          <span class="group-name" contenteditable="true" spellcheck="false" data-group-id="${group.id}">${safeName}</span>
          <span class="group-count">${tabs.length}</span>
          <button class="group-delete-btn" data-action="delete-group" data-group-id="${group.id}" title="删除分组">
            <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m14.74 9-.346 9m-4.788 0L9.26 9m9.968-3.21c.342.052.682.107 1.022.166m-1.022-.165L18.16 19.673a2.25 2.25 0 0 1-2.244 2.077H8.084a2.25 2.25 0 0 1-2.244-2.077L4.772 5.79m14.456 0a48.108 48.108 0 0 0-3.478-.397m-12 .562c.34-.059.68-.114 1.022-.165m0 0a48.11 48.11 0 0 1 3.478-.397m7.5 0v-.916c0-1.18-.91-2.164-2.09-2.201a51.964 51.964 0 0 0-3.32 0c-1.18.037-2.09 1.022-2.09 2.201v.916m7.5 0a48.667 48.667 0 0 0-7.5 0" /></svg>
          </button>
        </div>
        <div class="group-tab-list" data-group-id="${group.id}">${chipsHtml}</div>
        ${
          tabs.length > 0
            ? `
        <div class="group-actions">
          <button class="action-btn close-tabs" data-action="close-group-tabs" data-group-id="${group.id}">
            ${ICONS.close}
            关闭全部 ${tabs.length} 个标签页
          </button>
        </div>`
            : ""
        }
      </div>`;
    })
    .join("");
}

/**
 * buildGroupTabChip(tab, groupId)
 *
 * Builds one draggable tab chip inside a custom group.
 */
function buildGroupTabChip(tab, groupId) {
  const label = cleanTitle(
    smartTitle(stripTitleNoise(tab.title || ""), tab.url),
    "",
  );
  let domain = "";
  try {
    domain = new URL(tab.url).hostname.replace(/^www\./, "");
  } catch {}
  const faviconUrl = domain
    ? `https://www.google.com/s2/favicons?domain=${domain}&sz=16`
    : "";
  const safeUrl = (tab.url || "").replace(/"/g, "&quot;");
  const safeTitle = label.replace(/"/g, "&quot;");
  return `<div class="page-chip clickable" draggable="true" data-action="focus-tab" data-tab-url="${safeUrl}" data-group-id="${groupId}" title="${safeTitle}">
    <span class="chip-select" data-action="toggle-select" data-tab-url="${safeUrl}" title="选择"><svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="3" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="m4.5 12.75 6 6 9-13.5" /></svg></span>
    ${faviconUrl ? `<img class="chip-favicon" src="${faviconUrl}" alt="" onerror="this.style.display='none'">` : ""}
    <span class="chip-text">${label}</span>
    <div class="chip-actions">
      <button class="chip-action chip-save" data-action="defer-single-tab" data-tab-url="${safeUrl}" data-tab-title="${safeTitle}" title="稍后查看">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M17.593 3.322c1.1.128 1.907 1.077 1.907 2.185V21L12 17.25 4.5 21V5.507c0-1.108.806-2.057 1.907-2.185a48.507 48.507 0 0 1 11.186 0Z" /></svg>
      </button>
      <button class="chip-action chip-close" data-action="close-single-tab" data-tab-url="${safeUrl}" title="关闭此标签页">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2.5" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M6 18 18 6M6 6l12 12" /></svg>
      </button>
      <button class="chip-action chip-remove" data-action="remove-from-group" data-tab-url="${safeUrl}" data-group-id="${groupId}" title="移出分组">
        <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor"><path stroke-linecap="round" stroke-linejoin="round" d="M9 15 3 9m0 0 6-6M3 9h12a6 6 0 0 1 0 12h-3" /></svg>
      </button>
    </div>
  </div>`;
}

/**
 * addTabToGroup(groupId, url) / removeTabFromGroup(groupId, url)
 *
 * Mutate the stored groups. A tab can only be in one group, so adding
 * to a group first removes it from any other group.
 */
async function addTabToGroup(groupId, url) {
  const groups = await getTabGroups();
  for (const g of groups) {
    g.tabUrls = g.tabUrls.filter((u) => u !== url); // remove from others
    if (g.id === groupId && !g.tabUrls.includes(url)) g.tabUrls.push(url);
  }
  await saveTabGroups(groups);
}

async function removeTabFromGroup(groupId, url) {
  const groups = await getTabGroups();
  const g = groups.find((x) => x.id === groupId);
  if (g) g.tabUrls = g.tabUrls.filter((u) => u !== url);
  await saveTabGroups(groups);
}

/**
 * removeUrlFromAllGroups(url)
 *
 * Strips a URL from every group (used when the tab is closed/saved).
 */
async function removeUrlFromAllGroups(url) {
  const groups = await getTabGroups();
  let changed = false;
  for (const g of groups) {
    if (g.tabUrls.includes(url)) {
      g.tabUrls = g.tabUrls.filter((u) => u !== url);
      changed = true;
    }
  }
  if (changed) await saveTabGroups(groups);
}

/**
 * createGroup(name)
 *
 * Creates a new group with the given name and a cycled color.
 */
async function createGroup(name) {
  const groups = await getTabGroups();
  const id =
    "group-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const color = GROUP_COLORS[groups.length % GROUP_COLORS.length];
  groups.push({ id, name: name || "未命名分组", color, tabUrls: [] });
  await saveTabGroups(groups);
  return id;
}

/* ---- Drag & drop wiring ----
   We attach listeners to document (delegation) so dynamically rendered
   chips and group cards all work without rebinding. */

let _draggedUrls = []; // URLs being dragged (one, or many if multi-selected)

// Multi-select state
const _selectedTabUrls = new Set();

/**
 * updateMultiselectBar()
 *
 * Shows/hides the floating "N selected" bar and toggles the
 * has-selection styling on the groups container.
 */
function updateMultiselectBar() {
  let bar = document.getElementById("multiselectBar");
  const n = _selectedTabUrls.size;

  if (n > 0) {
    if (!bar) {
      bar = document.createElement("div");
      bar.className = "multiselect-bar";
      bar.id = "multiselectBar";
      bar.innerHTML = `
        <span class="multiselect-count" id="multiselectCount"></span>
        <span class="multiselect-hint">拖到分组可一起加入</span>
        <button class="multiselect-clear" id="multiselectClear">取消选择</button>`;
      document.body.appendChild(bar);
    }
    bar.querySelector("#multiselectCount").textContent = `已选择 ${n} 个标签页`;
    // force reflow so the transition runs
    void bar.offsetWidth;
    bar.classList.add("visible");

    const groups = document.getElementById("customGroups");
    if (groups) groups.classList.add("has-selection");
  } else if (bar) {
    bar.classList.remove("visible");
    const groups = document.getElementById("customGroups");
    if (groups) groups.classList.remove("has-selection");
  }
}

/**
 * toggleSelection(url)
 *
 * Adds/removes a URL from the multi-select set, updates the chip's
 * visual state, and refreshes the floating bar.
 */
function toggleSelection(url, forceState) {
  if (!url) return;
  const selected =
    forceState !== undefined ? forceState : !_selectedTabUrls.has(url);
  if (selected) _selectedTabUrls.add(url);
  else _selectedTabUrls.delete(url);

  // Update all chips with this URL
  document
    .querySelectorAll(`.page-chip[data-tab-url="${url.replace(/"/g, '\\"')}"]`)
    .forEach((chip) => {
      chip.classList.toggle("selected", selected);
    });
  updateMultiselectBar();
}

function clearSelection() {
  _selectedTabUrls.clear();
  document
    .querySelectorAll(".page-chip.selected")
    .forEach((chip) => chip.classList.remove("selected"));
  updateMultiselectBar();
}

document.addEventListener("dragstart", (e) => {
  const chip =
    e.target.closest && e.target.closest('.page-chip[draggable="true"]');
  if (!chip) return;
  const url = chip.dataset.tabUrl;
  chip.classList.add("dragging");

  // If the dragged chip is selected, drag ALL selected tabs; else just this one.
  if (_selectedTabUrls.has(url) && _selectedTabUrls.size > 1) {
    _draggedUrls = [..._selectedTabUrls];
  } else {
    _draggedUrls = [url];
  }

  if (e.dataTransfer) {
    e.dataTransfer.effectAllowed = "move";
    try {
      e.dataTransfer.setData("text/plain", _draggedUrls.join("\n"));
    } catch {}
  }
});

document.addEventListener("dragend", (e) => {
  const chip = e.target.closest && e.target.closest(".page-chip");
  if (chip) chip.classList.remove("dragging");
  _draggedUrls = [];
  // Clean up any lingering drag-over highlights
  document
    .querySelectorAll(".custom-group-card.drag-over")
    .forEach((c) => c.classList.remove("drag-over"));
});

document.addEventListener("dragover", (e) => {
  const groupCard = e.target.closest && e.target.closest(".custom-group-card");
  if (!groupCard) return;
  e.preventDefault(); // allow drop
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  groupCard.classList.add("drag-over");
});

document.addEventListener("dragleave", (e) => {
  // Only remove highlight when leaving the card itself (not its children)
  const groupCard = e.target.closest && e.target.closest(".custom-group-card");
  if (groupCard && !groupCard.contains(e.relatedTarget)) {
    groupCard.classList.remove("drag-over");
  }
});

document.addEventListener("drop", async (e) => {
  const groupCard = e.target.closest && e.target.closest(".custom-group-card");
  if (!groupCard) return;
  e.preventDefault();
  groupCard.classList.remove("drag-over");

  const groupId = groupCard.dataset.groupId;
  const urls = _draggedUrls.filter(Boolean);
  if (!groupId || urls.length === 0) return;

  // Add every dragged URL to the target group
  for (const url of urls) {
    await addTabToGroup(groupId, url);
  }
  clearSelection();
  renderCustomGroups();
  showToast(
    urls.length > 1 ? `已把 ${urls.length} 个标签页加入分组` : "已加入分组",
  );
});

// ---- Multi-select click handlers ----
document.addEventListener("click", (e) => {
  // Toggle a chip's selection (the select box)
  const selectBox =
    e.target.closest && e.target.closest('[data-action="toggle-select"]');
  if (selectBox) {
    e.stopPropagation();
    e.preventDefault();
    toggleSelection(selectBox.dataset.tabUrl);
    return;
  }
  // Clear-selection button in the floating bar
  const clearBtn = e.target.closest && e.target.closest("#multiselectClear");
  if (clearBtn) {
    clearSelection();
    return;
  }
  // Clicking empty space (not on a chip/action) clears the selection
  const chip = e.target.closest && e.target.closest(".page-chip");
  const dialog = e.target.closest && e.target.closest(".confirm-overlay");
  if (!chip && !dialog && _selectedTabUrls.size > 0) {
    // Don't clear if the click was on a control that does something else
    if (
      !e.target.closest("button") &&
      !e.target.closest("input") &&
      !e.target.closest("a")
    ) {
      clearSelection();
    }
  }
});

/* ---- Group actions (delete, rename, close-group-tabs, remove-from-group, new-group) ---- */

document.addEventListener("click", async (e) => {
  // New group button — show inline name input
  const newGroupBtn = e.target.closest && e.target.closest("#newGroupBtn");
  if (newGroupBtn) {
    const header = newGroupBtn.parentElement;
    // Don't add a second input if one exists
    if (header.querySelector(".new-group-input")) return;
    const input = document.createElement("input");
    input.type = "text";
    input.className = "new-group-input";
    input.placeholder = "分组名称…";
    const hint = document.createElement("div");
    hint.className = "new-group-hint";
    hint.textContent = "Enter 确认 · Esc 取消";
    header.appendChild(input);
    header.appendChild(hint);
    input.focus();

    let done = false;
    const finish = async (commit) => {
      if (done) return; // guard against double-fire (Enter then blur)
      done = true;
      if (commit && input.value.trim()) {
        await createGroup(input.value.trim());
      }
      input.remove();
      hint.remove();
      if (commit) renderCustomGroups();
    };
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter") {
        ev.preventDefault();
        finish(true);
      } else if (ev.key === "Escape") {
        ev.preventDefault();
        finish(false);
      }
    });
    input.addEventListener("blur", () => finish(true));
    return;
  }

  // Delete a group
  const deleteBtn =
    e.target.closest && e.target.closest('[data-action="delete-group"]');
  if (deleteBtn) {
    const groupId = deleteBtn.dataset.groupId;
    const group = customTabGroups.find((g) => g.id === groupId);
    const name = group ? group.name : "该分组";
    if (!(await confirmAction(`删除分组「${name}」?(不会关闭里面的标签页)`)))
      return;
    const groups = (await getTabGroups()).filter((g) => g.id !== groupId);
    await saveTabGroups(groups);
    renderCustomGroups();
    showToast("分组已删除");
    return;
  }

  // Remove a tab from a group (move back to ungrouped)
  const removeBtn =
    e.target.closest && e.target.closest('[data-action="remove-from-group"]');
  if (removeBtn) {
    const groupId = removeBtn.dataset.groupId;
    const url = removeBtn.dataset.tabUrl;
    await removeTabFromGroup(groupId, url);
    renderCustomGroups();
    showToast("已移出分组");
    return;
  }

  // Close all tabs in a group
  const closeGroupBtn =
    e.target.closest && e.target.closest('[data-action="close-group-tabs"]');
  if (closeGroupBtn) {
    const groupId = closeGroupBtn.dataset.groupId;
    const group = customTabGroups.find((g) => g.id === groupId);
    if (!group) return;
    const realTabs = getRealTabs();
    const openUrls = new Set(realTabs.map((t) => t.url));
    const urls = group.tabUrls.filter((u) => openUrls.has(u));
    if (urls.length === 0) return;

    const name = group.name || "该分组";
    const verb = syncClose ? "关闭" : "从面板移除";
    const tail = syncClose ? "?" : "?(浏览器标签页保留)";
    if (
      !(await confirmAction(
        `${verb}分组「${name}」下的全部 ${urls.length} 个标签页${tail}`,
      ))
    )
      return;

    // Custom-group tabs use exact-URL matching (hostname match would over-close).
    await closeOrHideExact(urls);

    // Remove the now-closed URLs from the group
    const allGroups = await getTabGroups();
    const g = allGroups.find((x) => x.id === groupId);
    if (g) g.tabUrls = g.tabUrls.filter((u) => !urls.includes(u));
    await saveTabGroups(allGroups);

    playCloseSound();
    clearSelection();
    const card = closeGroupBtn.closest(".custom-group-card");
    if (card) animateCardOut(card);
    showToast(`已关闭 ${name} 下的 ${urls.length} 个标签页`);
    const statTabs = document.getElementById("statTabs");
    if (statTabs) statTabs.textContent = openTabs.length;
    return;
  }
});

// ---- Group rename — save on blur / Enter ----
document.addEventListener(
  "blur",
  async (e) => {
    const nameEl = e.target.closest && e.target.closest(".group-name");
    if (!nameEl) return;
    const groupId = nameEl.dataset.groupId;
    const newName = nameEl.textContent.trim();
    const groups = await getTabGroups();
    const g = groups.find((x) => x.id === groupId);
    if (g) {
      g.name = newName || "未命名分组";
      await saveTabGroups(groups);
    }
  },
  true,
); // capture so blur fires on contenteditable

document.addEventListener("keydown", (e) => {
  const nameEl = e.target.closest && e.target.closest(".group-name");
  if (nameEl && e.key === "Enter") {
    e.preventDefault();
    nameEl.blur(); // triggers the blur handler above to save
  }
});

/* ----------------------------------------------------------------
   EVENT HANDLERS — using event delegation

   One listener on document handles ALL button clicks.
   Think of it as one security guard watching the whole building
   instead of one per door.
   ---------------------------------------------------------------- */

document.addEventListener("click", async (e) => {
  // Walk up the DOM to find the nearest element with data-action
  const actionEl = e.target.closest("[data-action]");
  if (!actionEl) return;

  const action = actionEl.dataset.action;

  // ---- Close duplicate Tab Manager tabs ----
  if (action === "close-tabout-dupes") {
    if (!(await confirmAction("关闭多余的 Tab Manager 标签页?"))) return;
    await closeTabOutDupes();
    playCloseSound();
    const banner = document.getElementById("tabOutDupeBanner");
    if (banner) {
      banner.style.transition = "opacity 0.4s";
      banner.style.opacity = "0";
      setTimeout(() => {
        banner.style.display = "none";
        banner.style.opacity = "1";
      }, 400);
    }
    showToast("已关闭多余的 Tab Manager 标签页");
    return;
  }

  const card = actionEl.closest(".mission-card");

  // ---- Expand overflow chips ("+N more") ----
  if (action === "expand-chips") {
    const overflowContainer = actionEl.parentElement.querySelector(
      ".page-chips-overflow",
    );
    if (overflowContainer) {
      overflowContainer.style.display = "contents";
      actionEl.remove();
    }
    return;
  }

  // ---- Focus a specific tab ----
  if (action === "focus-tab") {
    const tabUrl = actionEl.dataset.tabUrl;
    if (tabUrl) await focusTab(tabUrl);
    return;
  }

  // ---- Close a single tab ----
  if (action === "close-single-tab") {
    e.stopPropagation(); // don't trigger parent chip's focus-tab
    const tabUrl = actionEl.dataset.tabUrl;
    if (!tabUrl) return;

    if (
      !(await confirmAction(
        syncClose
          ? "关闭这个标签页?"
          : "从面板移除这个标签页?(浏览器标签页保留)",
      ))
    )
      return;

    // Close (or hide, depending on syncClose) the tab
    await closeOrHideExact([tabUrl]);
    await removeUrlFromAllGroups(tabUrl);
    toggleSelection(tabUrl, false);
    renderCustomGroups();

    playCloseSound();

    // Animate the chip row out
    const chip = actionEl.closest(".page-chip");
    if (chip) {
      const rect = chip.getBoundingClientRect();
      shootConfetti(rect.left + rect.width / 2, rect.top + rect.height / 2);
      chip.style.transition = "opacity 0.2s, transform 0.2s";
      chip.style.opacity = "0";
      chip.style.transform = "scale(0.8)";
      setTimeout(() => {
        chip.remove();
        // If the card now has no tabs, remove it too
        const parentCard = document.querySelector(
          ".mission-card:has(.mission-pages:empty)",
        );
        if (parentCard) animateCardOut(parentCard);
        document.querySelectorAll(".mission-card").forEach((c) => {
          if (
            c.querySelectorAll('.page-chip[data-action="focus-tab"]').length ===
            0
          ) {
            animateCardOut(c);
          }
        });
      }, 200);
    }

    // Update footer
    const statTabs = document.getElementById("statTabs");
    if (statTabs) statTabs.textContent = openTabs.length;

    showToast("标签页已关闭");
    return;
  }

  // ---- Save a single tab for later (then close it) ----
  if (action === "defer-single-tab") {
    e.stopPropagation();
    const tabUrl = actionEl.dataset.tabUrl;
    const tabTitle = actionEl.dataset.tabTitle || tabUrl;
    if (!tabUrl) return;

    if (
      !(await confirmAction(
        syncClose
          ? "保存并关闭这个标签页?"
          : "保存并从面板移除这个标签页?(浏览器标签页保留)",
      ))
    )
      return;

    // Save to chrome.storage.local
    try {
      await saveTabForLater({ url: tabUrl, title: tabTitle });
    } catch (err) {
      console.error("[tab-manager] Failed to save tab:", err);
      showToast("保存标签页失败");
      return;
    }

    // Close (or hide) the tab in the browser/dashboard
    await closeOrHideExact([tabUrl]);
    await removeUrlFromAllGroups(tabUrl);
    renderCustomGroups();

    // Animate chip out
    const chip = actionEl.closest(".page-chip");
    if (chip) {
      chip.style.transition = "opacity 0.2s, transform 0.2s";
      chip.style.opacity = "0";
      chip.style.transform = "scale(0.8)";
      setTimeout(() => chip.remove(), 200);
    }

    showToast("已保存到稍后查看");
    await renderDeferredColumn();
    return;
  }

  // ---- Check off a saved tab (moves it to archive) ----
  if (action === "check-deferred") {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    await checkOffSavedTab(id);

    // Animate: strikethrough first, then slide out
    const item = actionEl.closest(".deferred-item");
    if (item) {
      item.classList.add("checked");
      setTimeout(() => {
        item.classList.add("removing");
        setTimeout(() => {
          item.remove();
          renderDeferredColumn(); // refresh counts and archive
        }, 300);
      }, 800);
    }
    return;
  }

  // ---- Dismiss a saved tab (removes it entirely) ----
  if (action === "dismiss-deferred") {
    const id = actionEl.dataset.deferredId;
    if (!id) return;

    if (!(await confirmAction("忽略这个已保存的标签页?"))) return;

    await dismissSavedTab(id);

    const item = actionEl.closest(".deferred-item");
    if (item) {
      item.classList.add("removing");
      setTimeout(() => {
        item.remove();
        renderDeferredColumn();
      }, 300);
    }
    return;
  }

  // ---- Close all tabs in a domain group ----
  if (action === "close-domain-tabs") {
    const domainId = actionEl.dataset.domainId;
    const group = domainGroups.find((g) => {
      return "domain-" + g.domain.replace(/[^a-z0-9]/g, "-") === domainId;
    });
    if (!group) return;

    const groupLabel =
      group.domain === "__landing-pages__"
        ? "主页"
        : group.label || friendlyDomain(group.domain);
    const urls = group.tabs.map((t) => t.url);

    const verb = syncClose ? "关闭" : "从面板移除";
    const tail = syncClose ? "" : "?(浏览器标签页保留)";
    if (
      !(await confirmAction(
        `${verb}「${groupLabel}」下的全部 ${urls.length} 个标签页${tail || "?"}`,
      ))
    )
      return;
    // Landing pages and custom groups (whose domain key isn't a real hostname)
    // must use exact URL matching to avoid closing unrelated tabs
    const useExact = group.domain === "__landing-pages__" || !!group.label;

    if (useExact) {
      await closeOrHideExact(urls);
    } else {
      await closeOrHideTabs(urls);
    }

    // Clean any closed URLs out of custom groups
    await Promise.all(urls.map((u) => removeUrlFromAllGroups(u)));
    renderCustomGroups();
    clearSelection();

    if (card) {
      playCloseSound();
      animateCardOut(card);
    }

    // Remove from in-memory groups
    const idx = domainGroups.indexOf(group);
    if (idx !== -1) domainGroups.splice(idx, 1);

    showToast(`已关闭 ${groupLabel} 下的 ${urls.length} 个标签页`);

    const statTabs = document.getElementById("statTabs");
    if (statTabs) statTabs.textContent = openTabs.length;
    return;
  }

  // ---- Close duplicates, keep one copy ----
  if (action === "dedup-keep-one") {
    const urlsEncoded = actionEl.dataset.dupeUrls || "";
    const urls = urlsEncoded
      .split(",")
      .map((u) => decodeURIComponent(u))
      .filter(Boolean);
    if (urls.length === 0) return;

    if (
      !(await confirmAction(`关闭 ${urls.length} 个重复标签页(每个保留一份)?`))
    )
      return;

    // Dedup always closes the real extra browser tabs — that's the whole
    // point of "remove duplicates". (One copy is always kept.)
    await closeDuplicateTabs(urls, true);
    playCloseSound();

    // Hide the dedup button
    actionEl.style.transition = "opacity 0.2s";
    actionEl.style.opacity = "0";
    setTimeout(() => actionEl.remove(), 200);

    // Remove dupe badges from the card
    if (card) {
      card.querySelectorAll(".chip-dupe-badge").forEach((b) => {
        b.style.transition = "opacity 0.2s";
        b.style.opacity = "0";
        setTimeout(() => b.remove(), 200);
      });
      card.querySelectorAll(".open-tabs-badge").forEach((badge) => {
        if (badge.textContent.includes("重复")) {
          badge.style.transition = "opacity 0.2s";
          badge.style.opacity = "0";
          setTimeout(() => badge.remove(), 200);
        }
      });
      card.classList.remove("has-amber-bar");
      card.classList.add("has-neutral-bar");
    }

    showToast("已关闭重复标签页,每个保留一份");
    return;
  }

  // ---- Close ALL open tabs ----
  if (action === "close-all-open-tabs") {
    const allUrls = getRealTabs().map((t) => t.url);

    const verb = syncClose ? "关闭所有" : "从面板移除所有";
    const tail = syncClose ? "?" : "?(浏览器标签页保留)";
    if (
      !(await confirmAction(`${verb} ${allUrls.length} 个打开的标签页${tail}`))
    )
      return;

    await closeOrHideTabs(allUrls);
    // Clear all custom groups (every grouped tab is now closed)
    await saveTabGroups(customTabGroups.map((g) => ({ ...g, tabUrls: [] })));
    renderCustomGroups();
    clearSelection();
    playCloseSound();

    document
      .querySelectorAll("#openTabsMissions .mission-card")
      .forEach((c) => {
        shootConfetti(
          c.getBoundingClientRect().left + c.offsetWidth / 2,
          c.getBoundingClientRect().top + c.offsetHeight / 2,
        );
        animateCardOut(c);
      });

    showToast("全部标签页已关闭。焕然一新。");
    return;
  }
});

// ---- Archive toggle — expand/collapse the archive section ----
document.addEventListener("click", (e) => {
  const toggle = e.target.closest("#archiveToggle");
  if (!toggle) return;

  toggle.classList.toggle("open");
  const body = document.getElementById("archiveBody");
  if (body) {
    body.style.display = body.style.display === "none" ? "block" : "none";
  }
});

// ---- Archive search — filter archived items as user types ----
document.addEventListener("input", async (e) => {
  if (e.target.id !== "archiveSearch") return;

  const q = e.target.value.trim().toLowerCase();
  const archiveList = document.getElementById("archiveList");
  if (!archiveList) return;

  try {
    const { archived } = await getSavedTabs();

    if (q.length < 2) {
      // Show all archived items
      archiveList.innerHTML = archived
        .map((item) => renderArchiveItem(item))
        .join("");
      return;
    }

    // Filter by title or URL containing the query string
    const results = archived.filter(
      (item) =>
        (item.title || "").toLowerCase().includes(q) ||
        (item.url || "").toLowerCase().includes(q),
    );

    archiveList.innerHTML =
      results.map((item) => renderArchiveItem(item)).join("") ||
      '<div style="font-size:12px;color:var(--muted);padding:8px 0">没有结果</div>';
  } catch (err) {
    console.warn("[tab-manager] Archive search failed:", err);
  }
});

/* ----------------------------------------------------------------
   LIVE REFRESH — keep the dashboard in sync with tab changes

   The dashboard is now a long-lived page (opened via the toolbar icon,
   not reloaded on every new tab). So it must react to tabs being
   opened, closed, or navigated. We listen to chrome.tabs events with a
   debounce, plus refresh once when the user returns to this tab
   (visibilitychange) — so the count and cards are always fresh.

   Refreshes are skipped while the user is mid-interaction: confirming
   a destructive action, dragging a tab, editing a group name, or
   actively searching.
   ---------------------------------------------------------------- */

let _refreshDebounce = null;

/**
 * isDashboardBusy()
 *
 * Returns true when a background refresh would interrupt or confuse the
 * user. We hold off until the interaction settles.
 */
function isDashboardBusy() {
  // A confirm dialog is open — never yank the DOM out from under it
  const overlay = document.getElementById("confirmOverlay");
  if (overlay && overlay.style.display !== "none") return true;

  // A drag is in progress
  if (_draggedTabUrl) return true;

  // A group is being renamed (contenteditable focused) or a new-group
  // name input is open
  if (document.activeElement) {
    const el = document.activeElement;
    if (
      el.classList &&
      (el.classList.contains("group-name") ||
        el.classList.contains("new-group-input"))
    )
      return true;
  }

  return false;
}

/**
 * isSearching()
 *
 * True when the search box has a query and the flat results list is shown.
 */
function isSearching() {
  const input = document.getElementById("tabSearch");
  return !!(input && input.value && input.value.trim().length > 0);
}

/**
 * refreshDashboard()
 *
 * Re-renders the dashboard, unless it's busy. While the user is actively
 * searching, we only refresh the results list (not the hidden grouped
 * view) so their query and scroll position stay intact. Safe to call
 * repeatedly.
 */
function refreshDashboard() {
  if (isDashboardBusy()) return;

  // If searching, just refresh the flat results against the new tab set
  // rather than rebuilding the whole page (which would hide results).
  if (isSearching()) {
    const input = document.getElementById("tabSearch");
    if (input) {
      // Refresh open tabs first, then re-filter
      fetchOpenTabs().then(() => renderSearchResults(input.value));
    }
    return;
  }

  renderDashboard();
}

/**
 * scheduleRefresh()
 *
 * Debounced refresh trigger. Coalesces bursts of tab events into one
 * render. If busy, we retry shortly after — so a refresh that was
 * skipped isn't lost forever.
 */
function scheduleRefresh() {
  clearTimeout(_refreshDebounce);
  _refreshDebounce = setTimeout(() => {
    if (isDashboardBusy()) {
      // Try again in a bit, once the interaction likely settled
      _refreshDebounce = setTimeout(scheduleRefresh, 800);
      return;
    }
    refreshDashboard();
  }, 350);
}

// ---- React to tab changes while this page is open ----
chrome.tabs.onCreated.addListener(() => scheduleRefresh());
chrome.tabs.onRemoved.addListener(() => scheduleRefresh());
chrome.tabs.onUpdated.addListener((_id, info) => {
  // Only re-render on meaningful changes (title/url/loading done),
  // not on every tiny status update.
  if (info.title || info.url || info.status === "complete") {
    scheduleRefresh();
  }
});
chrome.tabs.onAttached.addListener(() => scheduleRefresh());
chrome.tabs.onDetached.addListener(() => scheduleRefresh());
chrome.windows.onCreated.addListener(() => scheduleRefresh());
chrome.windows.onRemoved.addListener(() => scheduleRefresh());

// ---- Refresh when the user switches back to this tab ----
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) scheduleRefresh();
});

/* ----------------------------------------------------------------
   INITIALIZE
   ---------------------------------------------------------------- */

// ---- Sync-close toggle: wire up change handler ----
document.addEventListener("change", (e) => {
  if (e.target.id === "syncCloseToggle") {
    setSyncClose(e.target.checked);
    showToast(
      e.target.checked
        ? "已开启:关闭时同步关闭浏览器标签页"
        : "已关闭:仅从面板移除,浏览器标签页保留",
    );
  }
});

// ---- Boot ----
(async () => {
  await loadSyncCloseSetting();
  renderDashboard();
})();

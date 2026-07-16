# Tab Out

**Keep tabs on your tabs.**

Tab Out is a Chrome extension that gives you a dashboard of everything you have open. Click the toolbar icon to open it — your new tab page stays untouched. Tabs are grouped by domain, with homepages (Gmail, X, LinkedIn, etc.) pulled into their own group. Search across all open tabs, drag tabs into custom groups, and close them with a satisfying swoosh + confetti.

No server. No account. No external API calls. Just a Chrome extension.

---

## Install with a coding agent

Send your coding agent (Claude Code, Codex, etc.) this repo and say **"install this"**:

```
https://github.com/zarazhangrui/tab-out
```

The agent will walk you through it. Takes about 1 minute.

---

## Features

- **See all your tabs at a glance** on a clean grid, grouped by domain
- **Opens on click** — click the toolbar icon to open the dashboard; your new tab page stays Chrome's default
- **Search open tabs** — a top search box filters all your tabs into a flat list so you can find any page instantly
- **Custom groups** — create named groups and drag tabs into them to organize your dashboard your way
- **Homepages group** pulls Gmail inbox, X home, YouTube, LinkedIn, GitHub homepages into one card
- **Close tabs with style** with swoosh sound + confetti burst
- **Duplicate detection** flags when you have the same page open twice, with one-click cleanup
- **Safe by default** every close/delete action asks for confirmation
- **Click any tab to jump to it** across windows, no new tab opened
- **Save for later** bookmark tabs to a checklist before closing them
- **Localhost grouping** shows port numbers next to each tab so you can tell your vibe coding projects apart
- **Expandable groups** show the first 8 tabs with a clickable "+N more"
- **100% local** your data never leaves your machine
- **Pure Chrome extension** no server, no Node.js, no npm, no setup beyond loading the extension

---

## Manual Setup

**1. Clone the repo**

```bash
git clone https://github.com/zarazhangrui/tab-out.git
```

**2. Load the Chrome extension**

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Navigate to the `extension/` folder inside the cloned repo and select it

**3. Pin & open it**

1. Click the **puzzle piece** in Chrome's toolbar and pin **Tab Out** for easy access.
2. Click the **Tab Out** icon to open the dashboard. (Your normal new tab page is unchanged.)

---

## How it works

```
You click the Tab Out toolbar icon
  -> Tab Out shows your open tabs grouped by domain
  -> Search box at the top filters all tabs into a flat list
  -> Create custom groups and drag tabs into them
  -> Homepages (Gmail, X, etc.) get their own group at the top
  -> Click any tab title to jump to it
  -> Close groups you're done with (swoosh + confetti) — confirmed first
  -> Save tabs for later before closing them
```

Everything runs inside the Chrome extension. No external server, no API calls, no data sent anywhere. Saved tabs and custom groups are stored in `chrome.storage.local`.

---

## Tech stack

| What | How |
|------|-----|
| Extension | Chrome Manifest V3 |
| Storage | chrome.storage.local |
| Sound | Web Audio API (synthesized, no files) |
| Animations | CSS transitions + JS confetti particles |

---

## License

MIT

---

Built by [Zara](https://x.com/zarazhangrui)

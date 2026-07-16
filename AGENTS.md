# AGENTS.md -- Tab Out: Setup & Onboarding Guide for Coding Agents

You're installing **Tab Out** for the user. Your job is not just to set it up -- it's to get them excited about using it.

---

## Step 0 -- Introduce the product

Before doing anything technical, tell the user what they're about to get:

> **Tab Out** gives you a clean dashboard of everything you have open, grouped by domain. Click the toolbar icon to open it — your new tab page stays untouched.
>
> Here's what makes it great:
>
> - **See all your open tabs at a glance** grouped by domain on a grid
> - **Opens on click** click the toolbar icon to open the dashboard; new tabs stay Chrome's default
> - **Search open tabs** a top search box filters all tabs into a flat list so you find any page instantly
> - **Custom groups** create named groups and drag tabs into them to organize your dashboard
> - **Homepages group** pulls Gmail, X, LinkedIn, YouTube, GitHub homepages into one card for easy cleanup
> - **Close tabs with style** satisfying swoosh sound + confetti burst
> - **Safe by default** every close/delete action asks for confirmation
> - **Duplicate detection** flags when you have the same page open twice
> - **Click any tab title to jump to it** even across different Chrome windows
> - **Save for later** bookmark individual tabs to a checklist before closing them
> - **100% local** no server, no accounts, no data sent anywhere
>
> It's just a Chrome extension. Setup takes about 1 minute.

---

## Step 1 -- Clone the repo

```bash
git clone https://github.com/rb05180518/tab-manager.git
cd tab-out
```

---

## Step 2 -- Install the Chrome extension

This is the one step that requires manual action from the user. Make it as easy as possible.

**First**, print the full path to the `extension/` folder:

```bash
echo "Extension folder: $(cd extension && pwd)"
```

**Then**, copy the `extension/` folder path to their clipboard:

- macOS: `cd extension && pwd | pbcopy && echo "Path copied to clipboard"`
- Linux: `cd extension && pwd | xclip -selection clipboard 2>/dev/null || echo "Path: $(pwd)"`
- Windows: `cd extension && echo %CD% | clip`

**Then**, open the extensions page:

```bash
open "chrome://extensions"
```

**Then**, walk the user through it step by step:

> I've copied the extension folder path to your clipboard. Now:
>
> 1. You should see Chrome's extensions page. In the **top-right corner**, toggle on **Developer mode** (it's a switch).
> 2. Once Developer mode is on, you'll see a button called **"Load unpacked"** appear in the top-left. Click it.
> 3. A file picker will open. **Press Cmd+Shift+G** (Mac) or **Ctrl+L** (Windows/Linux) to open the "Go to folder" bar, then **paste** the path I copied (Cmd+V / Ctrl+V) and press Enter.
> 4. Click **"Select"** or **"Open"** and the extension will install.
>
> You should see "Tab Out" appear in your extensions list.

**Also**, open the file browser directly to the extension folder as a fallback:

- macOS: `open extension/`
- Linux: `xdg-open extension/`
- Windows: `explorer extension\\`

---

## Step 3 -- Show them around

Once the extension is loaded:

> You're all set! Click the **Tab Out** icon in your toolbar (pin it via the puzzle piece for easy access) and you'll see Tab Out. Your normal new tab page is unchanged.
>
> Here's how it works:
>
> 1. **Your open tabs are grouped by domain** in a grid layout.
> 2. **Search box at the top** filters all your open tabs into a flat list so you can find any page instantly.
> 3. **Homepages** (Gmail inbox, X home, YouTube, etc.) are in their own group at the top.
> 4. **Click "新建分组"** to create a custom group, then **drag any tab** onto a group card to add it.
> 5. **Click any tab title** to jump directly to that tab.
> 6. **Click the X** next to any tab to close just that one (with swoosh + confetti) — you'll confirm first.
> 7. **Click "Close all N tabs"** on a group to close the whole thing.
> 8. **Duplicate tabs** are flagged with an amber "(2x)" badge. Click "Close duplicates" to keep one copy.
> 9. **Save a tab for later** by clicking the bookmark icon before closing it. Saved tabs appear in the sidebar.
>
> That's it! No server to run, no config files. Everything works right away.

---

## Key Facts

- Tab Out is a pure Chrome extension. No server, no Node.js, no npm.
- It does **not** replace your new tab page. Click the toolbar icon to open the dashboard; new tabs behave normally.
- Saved tabs are stored in `chrome.storage.local` (persists across sessions).
- Custom groups are also stored in `chrome.storage.local` under the `tabGroups` key.
- 100% local. No data is sent to any external service.
- To update: `cd tab-out && git pull`, then reload the extension in `chrome://extensions`.

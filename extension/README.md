# Open Verse Ai: Chrome extension

Ask Open Verse Ai about the page you're on: **Summarize**, **Explain simply**, **Study guide**, or your own question. Answers are saved to your chats ("Continue in chat").

## Install (once, no Web Store needed)
1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and choose this `extension` folder.
3. Pin it: puzzle-piece icon → pin **Open Verse Ai**. Shortcut: **⌘⇧O** (Mac) / **Ctrl+Shift+O**.
4. Click it, paste your **owner key** once, choose an 8-digit PIN.

## How it handles your data
- **Key:** encrypted with your PIN (PBKDF2-SHA256, 600,000 rounds → AES-GCM) in the extension's own storage. While unlocked, the key is kept in memory-only session storage for 15 minutes and is gone when Chrome closes. 5 wrong PINs → growing wait.
- **Page access:** `activeTab` + `scripting` only. The extension reads a page **only when you click Ask**, and only that tab. If you highlighted text, only the highlight is sent. It can't read `chrome://` pages or the Web Store.
- **What's sent:** your question plus the page text (first 15,000 characters) as an attachment. The API treats it as data and ignores instructions written inside it. Page text is not saved to memory.
- **Network:** only `https://open-verse-ai.boukeilehm.workers.dev`.

## Update
After pulling new code: `chrome://extensions` → **Open Verse Ai** → reload ↻.

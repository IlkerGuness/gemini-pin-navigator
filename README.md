<p align="center">
  <img src="Gemini_Pin_Navigator_Logo.png" alt="Gemini Pin Navigator Logo" width="250">
</p>

# 📍 Gemini Pin Navigator

A powerful Tampermonkey userscript that adds a much-needed pinning system to Google Gemini. Never lose track of important messages in long conversations again!

### 💡 The Story Behind It
As an Electrical Engineering (EE) student, I spend a lot of time doing deep research and reading long technical threads on Gemini. I desperately needed a way to bookmark specific messages and navigate through them easily, but I couldn't find any extension that did this. So, I decided to build it myself! 

This project was developed with the coding assistance of **Claude** and **Gemini**, proving how AI can help us build the tools we need but cannot find.

## ✨ Features
* **Pin Current Viewport:** Bookmark exactly what you are looking at.
* **Spatial Sorting:** Pins are automatically sorted by their physical order in the chat.
* **Deep Sync & Rescue:** A robust sync button that climbs the chat history to recover and re-link older pins after a page refresh.
* **Home Button:** Instantly jump to the bottom of the conversation.
* **Bypasses Trusted Types:** Securely built to bypass Gemini's strict DOM injection rules.

## 🚀 How to Install
1. Install the [Tampermonkey](https://www.tampermonkey.net/) extension for your browser.
2. **[CLICK HERE TO INSTALL THE SCRIPT](https://github.com/IlkerGuness/gemini-pin-navigator/raw/refs/heads/main/gemini-pin-navigator.user.js)**
3. Open or refresh Google Gemini, and enjoy the new pin sidebar!

---

## 🛠️ How to Use


https://github.com/user-attachments/assets/d75b1de1-5845-4b12-93bc-c6d185a41519


1. **Locate your target:** Scroll to the Gemini response you want to bookmark.
2. **Drop the Pin:** Click the **"📍 PIN"** button next to the Gemini logo (top-left).
3. **Customize:** Pick a color and give it a label (up to 10 characters).
4. **Teleport:** Click any pin in the right sidebar to jump back to that message!
5. **Jump to Bottom:** Use the **"▼ BOTTOM"** button to return to the current chat.

### ⟳ The "Sync Pins" Feature (After Page Refresh)
Gemini deletes old messages from memory when you refresh. If your pins stop working:
* Click **"⟳ SYNC PINS"** in the sidebar.
* The script will "climb" your history to find and re-activate your saved pins.

> **⚠️ Developer Note (Sync is in BETA):**
> This feature is actively being improved. In very long chats, it might occasionally miss a pin due to Gemini's loading speed. More updates coming soon!

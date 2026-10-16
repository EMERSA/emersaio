---
title: Security and privacy
description: "What this site stores about you (nothing, today), what is planned for memory, and how the beings are secured."
section: trust
order: 1
updated: 2026-10-16
---

## What this site stores today

Nothing. The site you are reading is a set of static pages served from the edge. It sets no cookies, runs no analytics script and never records your IP address. The only things kept are in your own browser, where you can see and delete them: your theme choice (`em-theme`), how far you got in the tour (`em-tour`) and, for the length of the browser session, the three-letter code of the Cloudflare data centre that served you (`em-colo`), shown in the readout next to the guide. Clearing site data removes all three.

When you email us, your message goes to our own mailbox and we use it only to answer you.

If your browser reports a Content Security Policy violation, we count the directive and the blocked hostname so we can fix the page. No address and no page content travel with it.

## Who processes what

Cloudflare serves the pages and runs the small edge program behind Talk to Emily; Convai Technologies handles the conversation itself, as the privacy policy sets out. Questions about personal data go to 4d@emersa.io.

## Memory, with consent

Talk to Emily lets you talk to the guide out loud or by typing. It changes what is stored, so the rules are written down here and in the privacy policy before it is switched on:

- Nothing is stored before you tap "Start talking" and read what it means.
- Memory is tied to this browser through a signed, random identifier set only after consent, not to your name or your address.
- What is remembered: each turn of the conversation, a few distilled facts you chose to share, your tour progress and your theme. It is held in a database in the European Union.
- A "What Emily remembers" panel shows everything, and "Forget me" erases it in one request, including anything held by the voice provider.
- Memory not used for twelve months is purged on its own.
- Typing is the default; the microphone is used only while a press is held, on the microphone button or on Emily herself, and closes when it ends.
- You can add one file at a time (a PDF, .txt or .md file up to 2 MB) for Emily to read. Only the text is kept, at most 20,000 characters, and Forget me deletes it with the rest. The file itself is never stored or passed on.
- The processors are Cloudflare (the site, the person check and the database) and Convai Technologies in the United States (speech to text, Emily's replies and her voice). Microsoft joins only if we move speech to Azure, and this page will say so first.
- Emily is an AI and may make mistakes.

Until the Talk button appears on the home page, none of this is live; the privacy policy changes on the day it is.

## How the beings are secured

The posture is the same for this site and for the enterprise beings: every part gets only the access it needs, data is encrypted by default, and the rules a deployment runs under are written down as code and reviewed like code. Emily Wilson deploys on-premises, in a sovereign cloud or with no connection to the internet at all, and humans stay in the loop for sensitive actions, with reversible steps and audit trails.

The site itself ships with a strict Content Security Policy that allows no inline scripts and no inline styles, HTTP Strict Transport Security, and headers that forbid framing and content sniffing. Every secret lives at the edge, never in the page.

## Reporting a vulnerability

Found a vulnerability? Write to 4d@emersa.io. A machine-readable `security.txt` lives at `/.well-known/security.txt`. We prefer a quiet report and a fix over a surprise.

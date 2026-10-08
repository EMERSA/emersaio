---
title: Security and privacy
description: "What this site stores about you (nothing, today), what is planned for memory, and how the beings are secured."
section: trust
order: 1
updated: 2026-10-07
---

## What this site stores today

Nothing. The site you are reading is a set of static pages served from the edge. It sets no cookies, runs no analytics script and never records your IP address. The only things kept are in your own browser, where you can see and delete them: your theme choice (`em-theme`), how far you got in the tour (`em-tour`) and, for the length of the browser session, the three-letter code of the Cloudflare data centre that served you (`em-colo`), shown in the readout next to the guide. Clearing site data removes all three.

When you send the contact form, your name, email address, company, topic and message are delivered to our inbox by Postmark, an email service, and we use them only to answer you. The form is protected by a hidden field, a timing check and a daily cap rather than by tracking.

If your browser reports a Content Security Policy violation, we count the directive and the blocked hostname so we can fix the page. No address and no page content travel with it.

## Who processes what

Cloudflare serves the pages and runs the small edge program that answers the contact form. Postmark delivers the email. There is no other processor in this phase. Questions about personal data go to privacy@emersa.io.

## Planned: memory, with consent

The next phase of the site lets you talk to the guide out loud. That changes what is stored, and we are writing the rules down before it ships. The plan is this:

- Nothing is stored before you tap "Start talking" and read what it means.
- Memory is tied to this browser through a signed, random identifier set only after consent, not to your name or your address.
- What is remembered: each turn of the conversation, a few distilled facts you chose to share, your tour progress and your theme. It is held in a database in the European Union.
- A "What you remember about me" panel shows everything, and "Forget me" erases it in one request, including anything held by the voice provider.
- Memory not used for twelve months is purged on its own.
- A text-only path exists for anyone who does not want to use a microphone.

Treat all of this as planned, not live. The privacy policy will change on the day it does.

## How the beings are secured

The posture is the same for this site and for the enterprise beings: every part gets only the access it needs, data is encrypted by default, and the rules a deployment runs under are written down as code and reviewed like code. Emily Wilson deploys on-premises, in a sovereign cloud or with no connection to the internet at all, and humans stay in the loop for sensitive actions, with reversible steps and audit trails.

The site itself ships with a strict Content Security Policy that allows no inline scripts and no inline styles, HTTP Strict Transport Security, and headers that forbid framing and content sniffing. Every secret lives at the edge, never in the page.

## Reporting a vulnerability

Found a vulnerability? Write to 4d@emersa.io. A machine-readable `security.txt` lives at `/.well-known/security.txt`. We prefer a quiet report and a fix over a surprise.

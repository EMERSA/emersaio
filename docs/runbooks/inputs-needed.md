# Inputs needed from Emersa

Plan section 8. None of these block Phase 0 or milestone M1 (the site launches with placeholders); all are
due by Phase 1 week 2. Tick them off here and note where the input went.

## Company and legal

- [ ] Registered office address. Confirm company number 15179283 and whether 566 Cable Street, London E1W 3HB
      is the registered office at Companies House. Goes in `apps/web/src/data/legal.ts` (`registeredOffice`).
- [ ] VAT number, or the wording "Not VAT registered". `legal.ts` (`vat`).
- [ ] Who owns the Cloudflare account and the DNS for emersa.io, and that multi-factor authentication is on.
- [ ] Who receives `privacy@emersa.io` and `4d@emersa.io` (privacy requests and vulnerability reports).

## Brand

- [ ] The logo as SVG, exported from `C:\Martin\logo\Emersa\Emersa Logo-BDS1-002A.ai` (mark and "EMERSA"
      wordmark). Until then `apps/web/src/assets/logo/emersa-mark.svg`, the mark converted from the PDF master
      (see the README beside it), fills the slot.
- [ ] Confirmation that the wordmark reads "Emersa" (not the older "em3rsa").

## Content

- [ ] Emily Wilson: product copy and hologram hardware facts (what the hardware is, who makes it, what it
      needs on site). The docs page `emily-wilson-overview` carries `[TBC]` until then.
- [ ] The Emily Wilson video source (MP4, 1080p, with captions) or the YouTube ids `OFMqitAaKv0` /
      `yCaP1oKKDxE` as candidates. Self-hosted behind the poster facade; no YouTube embed under the CSP.
- [ ] The 2023 games: title, year, platform, status, links, one image each. `apps/web/src/content/games/`.

## Partners

- [ ] Written logo permissions from NVIDIA, SUSE, TechPassport and Secarma (`partner-permissions.md`).
- [ ] Confirmation of the two unconfirmed sentences (TechPassport, Secarma) in `site.ts`.

## Kinect (optional; nothing waits on it)

- [ ] Whether a live-sensor demo is wanted at all. The site draws the point-cloud body from the being's own
      depth; a Kinect only replaces that depth in the dev harness today (`kinectron.md`).
- [ ] If so: an Azure Kinect (Kinectron 1.x) or a Kinect 2 for Windows (the 0.x line), a Windows 10/11 machine
      with USB 3.0 to run the Kinectron server, and who looks after it.
- [ ] Without a sensor: a grey depth recording (white near, black far) to drive `VideoDepthSource` for demos.

## Phase 2

- [ ] A Convai account on the Professional plan, the Emily Wilson character id (`CONVAI_CHARACTER_ID`) and the
      API key (`secrets.md`).
- [ ] What NVIDIA Inception grants: an AI Enterprise trial, credits, or neither. Decides whether the production
      brain is a self-hosted Nemotron NIM.
- [ ] An Azure subscription for Speech S0 in `uksouth`, if live TTS on the NIM path is wanted.
- [ ] A Turnstile widget for emersa.io (site key and secret).
- [ ] A decision on the Workers Paid plan ($5 a month) before Phase 2 starts.

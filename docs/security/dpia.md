# Data protection impact assessment: emersa.io

Controller: Emersa Ltd (trading as Emersa Labs), London, company no. 15179283. Contact: privacy@emersa.io.
Version 1, 2026-10-07, covering Phase 1 as built and Phase 2 as planned. Review before Phase 2 goes live and
whenever a processor, a purpose or a retention period changes.

## 1. Why an assessment

Phase 2 adds a voice conversation with an AI character that records the visitor's microphone, sends speech to a
third-party provider outside the UK, and remembers visitors across visits. That is a new technology processing
biometric-adjacent data (voice) with profiling-like memory, which meets the UK GDPR threshold for a DPIA even
though the scale is small and no decision with legal effect is made.

## 2. What the site processes

### Phase 1 (live)

| Processing | Data | Purpose | Lawful basis | Processor | Retention |
| --- | --- | --- | --- | --- | --- |
| Serving pages | IP address, user agent, requested URL (in transit only) | Delivering the site, security | Legitimate interests | Cloudflare (edge, EU and global) | Not stored: Worker invocation logs are off; no analytics script |
| Contact form | Name, email, company, topic, message | Answering the enquiry | Steps before a contract / consent by sending | Postmark (US), Cloudflare | Mail in the sales inbox under Google Workspace; the Worker stores nothing |
| Rate limiting and counters | Per-connection counters at the edge; a daily send count | Abuse prevention | Legitimate interests | Cloudflare | Counters expire within minutes; the daily count holds no personal data |
| CSP violation reports | Directive, blocked host, disposition | Security | Legitimate interests | Cloudflare Analytics Engine | Counts only, 90 days |
| Theme, tour progress and the edge readout | `em-theme` and `em-tour` in the visitor's local storage; `em-colo`, the three-letter code of the Cloudflare data centre that served the page, in session storage | Remembering a preference; the HUD readout next to the guide | Strictly necessary for the chosen feature | None (never sent) | Until the visitor clears storage; `em-colo` ends with the browser session |

Phase 1 sets no cookies. No visitor IP is ever written anywhere. The privacy policy names Cloudflare and
Postmark as processors and has a cookies section.

### Phase 2 (planned)

| Processing | Data | Purpose | Lawful basis | Processor | Retention |
| --- | --- | --- | --- | --- | --- |
| Talk session | Microphone audio, transcripts, the character's replies, 60 fps face data | The conversation the visitor asked for | Consent, given by "Start talking" after the notice | Convai Technologies (US), Cloudflare; Microsoft Azure `uksouth` and Workers AI on the NIM path; Google only when the visitor opts into Web Speech | Audio is streamed, not stored by Emersa; transcripts mirrored to D1 (EU) |
| Memory | Turns (role, text, time), distilled facts, name and pronouns if given, tour progress, theme | Continuity across visits ("remembers you") | Consent | Cloudflare D1 (`weur`), Convai memory keyed by an opaque id | 12 idle months, or instantly on "Forget me" |
| Visitor cookie `em_vid` | 128-bit random id, HMAC-signed | Linking a browser to its memory | Consent (set only after "Start talking") | Cloudflare | 13 months |
| Turnstile | Cloudflare's challenge signals | Protecting the paid session quota | Legitimate interests | Cloudflare | Per Cloudflare's Turnstile terms |
| Daily quotas | Per-visitor turn, session and ASR-second counts | Abuse and cost control | Legitimate interests | Cloudflare D1 | 1 day |

## 3. Necessity and proportionality

- Nothing is stored before the visitor presses "Start talking"; the scripted tour (Phase 1) needs no data.
- The notice before consent says what is recorded, who processes it, that memory can be shown and erased,
  that a text-only alternative exists, and that Emily is an AI that may make mistakes.
- Memory is minimal by design: turns and distilled facts, no audio, no IP, no device fingerprint. The Convai
  `endUserId` is derived from the signed id, so Convai never sees the cookie value or any direct identifier.
- "What you remember about me" (`GET /api/memory`) and "Forget me" (`DELETE /api/memory`) give access and
  erasure in one tap; erasure clears D1, the cookie and Convai's memories in one request.
- Consent is re-asked when `consent_version` changes.

## 4. Risks and measures

| Risk | Likelihood | Severity | Measures |
| --- | --- | --- | --- |
| Microphone used without the visitor knowing | Low | High | `Permissions-Policy: microphone=()` everywhere except `/` from Phase 2; `getUserMedia` only inside the tap; the listening state is shown on screen |
| Transfer of voice data to the US (Convai) | Certain in Phase 2 | Medium | Named in the notice; Convai's data processing terms and the UK IDTA/addendum on file before launch; the NIM path keeps speech in the UK (Azure `uksouth`, Workers AI) |
| Memory linked to the wrong person (shared device) | Medium | Medium | Memory is per browser, said so in the notice; "Forget me" is one tap; no cross-device linking in Phase 2 |
| Prompt injection or abusive output | Medium | Medium | Guardrails middleware with an action whitelist and a length cap; page context is build-time only; the character cannot act outside the whitelisted page actions |
| Provider keys leaking to the browser | Low | High | Only the one-hour Convai token reaches the browser; keys are Worker secrets; preflight scans the build; a HAR review is part of the Phase 2 exit |
| Over-retention | Low | Medium | Daily cron purges visitors idle for 12 months and expired quotas; back-dated rows are tested |
| Children | Low | High | The site is a business site; no age-targeted content; the notice is plain English |

## 5. Rights and contact

Access and erasure are self-service on the site; any other request goes to privacy@emersa.io and is answered
within one month. Processor list and retention periods are repeated on `/privacy`. Security reports go to
4d@emersa.io (`/.well-known/security.txt`).

## 6. Sign-off

| Role | Name | Date |
| --- | --- | --- |
| Controller's decision | | |
| Technical review | | |
| Next review | before Phase 2 launch | |

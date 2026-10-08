# Partner logo permissions

The partner marquee ships the files that are already live on krupiq.com (`apps/web/src/assets/partners/`) with
the wording in `apps/web/src/data/site.ts`. Each partner's written permission is logged here before launch. If
a partner objects, set `logo` to undefined for that partner in `site.ts` and the marquee shows the name in Syne
instead; nothing else changes.

NVIDIA requires written authorisation for logo use and provides the Inception badge for members; SUSE
trademark use needs approval through the partner programme; TechPassport and Secarma publish no brand kit.

| Partner | Asset | Source | Wording on the site | Permission | Date | Contact |
| --- | --- | --- | --- | --- | --- | --- |
| NVIDIA | `nvidia.png`, `nvidia-dark.png` (1052 x 200, keyed) | krupiq `apps/web/src/assets/partners`; the Inception badge is the legitimate asset once downloaded from the Inception portal | "Emersa was accepted into the NVIDIA Inception Program in February 2026." | pending | | Inception programme portal, brand guidelines request |
| SUSE | `suse.png`, `suse-dark.png`; official `SUSE_Logo-hor_L_Green-pos_sRGB.svg` at `C:\Martin\WEB\logos` | SUSE partner programme (Innovate Sapphire certificate, 2026) | "Emersa Ltd is an approved SUSE partner at Innovate Sapphire tier, 2026." | pending | | SUSE partner manager |
| TechPassport | `techpassport.png`, `techpassport-dark.png`; `tp-logo.svg` at `C:\Martin\WEB\logos` | supplied for krupiq.com | "TechPassport certification is supplier onboarding for banks, not a security accreditation." (marked unconfirmed in `site.ts`) | pending | | TechPassport account contact |
| Secarma | `secarma.svg`, `secarma-dark.svg` (vector, stripped of Adobe metadata) | secarma.com, supplied for krupiq.com | "Secarma provides independent security testing." (marked unconfirmed in `site.ts`) | pending | | Secarma engagement lead |

## What to ask each partner

1. May Emersa show your logo on emersa.io in a partners band, in the two colour variants attached?
2. Is this sentence correct, word for word? (quote the sentence from the table)
3. Who is the contact for brand questions?

Keep the reply (email or PDF) outside the repository, note its date here and flip `unconfirmed` off in
`site.ts` for that partner. Until a reply exists the sentence stays as it is and the logo stays as it is.

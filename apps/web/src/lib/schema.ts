/**
 * schema.org JSON-LD for the pages this app renders. Base.astro prints whatever object a page passes as `schema`,
 * so every helper here returns plain data and graph() wraps the pieces in one document with the context.
 */
import { legal } from '../data/legal.ts';
import { site } from '../data/site.ts';

export type Thing = Record<string, unknown>;

const absolute = (path: string): string => new URL(path, site.url).href;

const organizationId = absolute('/#organization');

/** Emersa Labs as the Organization search engines attach to the home page. */
export const organization = (): Thing => {
  const nvidia = site.partners.items.find((partner) => partner.name === 'NVIDIA');
  return {
    '@type': 'Organization',
    '@id': organizationId,
    name: site.name,
    legalName: legal.company,
    url: site.url,
    // The social card stands in for the logo until the brand SVG export lands (docs/runbooks/inputs-needed.md).
    logo: absolute('/og.png'),
    description: site.description,
    foundingDate: String(legal.since),
    address: { '@type': 'PostalAddress', addressLocality: legal.city, addressCountry: 'GB' },
    email: legal.contactEmail,
    sameAs: [legal.linkedin],
    memberOf: {
      '@type': 'ProgramMembership',
      programName: 'NVIDIA Inception Program',
      hostingOrganization: { '@type': 'Organization', name: 'NVIDIA', url: nvidia?.href },
    },
  };
};

/** A page node; `type` lets a page say it is a ContactPage or similar without a helper per type. */
export const webPage = (path: string, name: string, description: string, type = 'WebPage'): Thing => ({
  '@type': type,
  '@id': absolute(path),
  url: absolute(path),
  name,
  description,
  inLanguage: 'en',
  publisher: { '@id': organizationId },
});

/** Wraps the things in one @graph document so a page can pass several nodes as one object. */
export const graph = (...things: Thing[]): Thing => ({ '@context': 'https://schema.org', '@graph': things });

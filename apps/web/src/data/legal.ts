/**
 * Legal particulars shown in the footer and on the legal pages. This is the only file legal review has to read.
 * UK law (Companies (Trading Disclosures) Regulations 2015, reg. 25) requires the registered name, number, part of
 * the UK of registration and the registered office address on the website. VAT wording is optional.
 */
export const legal = {
  tradingName: 'Emersa Labs',
  company: 'Emersa Ltd',
  /** Confirm at Companies House before launch. */
  companyNo: '15179283',
  registeredIn: 'England and Wales',
  registeredOffice: 'Registered office: Unit 213, 566 Cable Street, London E1W 3HB, United Kingdom',
  vat: 'VAT No. GB 485873727',
  since: 2023,
  city: 'London',
  securityEmail: '4d@emersa.io',
  contactEmail: 'sales@emersa.io',
  privacyEmail: 'privacy@emersa.io',
  linkedin: 'https://www.linkedin.com/company/emersalabs',
} as const;

/** The footer sentence, built once so every page prints the same words. */
export const legalLine = (year: number): string =>
  `© ${year} ${legal.tradingName} is a trading name of ${legal.company}. Company No. ${legal.companyNo}. ` +
  `Registered in ${legal.registeredIn}. ${legal.registeredOffice}. ${legal.vat}.`;

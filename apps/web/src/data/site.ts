/**
 * Every word on the site lives here (or in src/content for docs, games and the tour). Components render it;
 * they never carry copy of their own. Plain language, no jargon, no claims we cannot back.
 */
import type { DocSection, GameStatus } from '../content.config.ts';

export interface NavItem {
  label: string;
  href: string;
}

export interface Partner {
  name: string;
  /** What the partnership is, in the exact words agreed with the partner. */
  sentence: string;
  /** True until the partner has confirmed the wording in writing (docs/runbooks/partner-permissions.md). */
  unconfirmed?: boolean;
  logo?: string;
  logoDark?: string;
  logoStacked?: boolean;
  href: string;
}

const siteUrl = (import.meta.env.PUBLIC_SITE_URL || 'https://emersa.io').replace(/\/$/, '');

export const site = {
  name: 'Emersa Labs',
  shortName: 'Emersa',
  url: siteUrl,
  tagline: 'We make synthetic beings.',
  description:
    'Emersa Labs makes synthetic beings: intelligent characters that see, remember and act. Emily Wilson for the enterprise, Krupiq for security. London, since 2023.',
  locale: 'en_GB',

  nav: [
    { label: 'Story', href: '/#story' },
    { label: 'Products', href: '/#products' },
    { label: 'Technology', href: '/#technology' },
    { label: 'Docs', href: '/docs' },
    { label: 'Games', href: '/games' },
    { label: 'Contact', href: '/contact' },
  ] satisfies NavItem[],

  hero: {
    eyebrow: 'Emersa Labs · London · since 2023',
    title: 'We make synthetic beings.',
    lead: 'Beings that see, remember and act. They were born in our games as intelligent characters. Now they guide people through work, learning and whole worlds.',
    primary: { label: 'Start the tour', href: '#tour' },
    talk: { label: 'Talk to Emily', href: '#talk', close: 'Close' },
    secondary: { label: 'Meet Emily Wilson', href: '/#products' },
    guideLabel: 'Emily Wilson, rendered as the structure beneath the skin',
    voiceLabel: 'AI-generated voice',
  },

  /** The Talk sheet (Phase 2): consent first, then the conversation. Every line a visitor reads before the mic. */
  talk: {
    headerLink: 'Talk to Emily',
    title: 'Talk to Emily',
    intro: 'Before you start, here is what happens when you talk to Emily.',
    consent: [
      {
        term: 'Your microphone',
        text: 'Your browser asks for the microphone when you tap Start talking. It is used only while the conversation is open and stops when you tap End.',
      },
      {
        term: 'Who handles it',
        text: 'Cloudflare runs this site and checks that you are a person. Convai Technologies in the United States turns your voice into words and gives Emily her voice and her replies. Microsoft handles speech only if we switch to its Azure speech service, and this list will say so first.',
      },
      {
        term: 'What Emily remembers',
        text: 'What you say, what she replies, a few facts you mention (such as your name, your company or what you are interested in) and any file you add. She keeps this so she can pick up where you left off. At most 200 turns and 10 files a day.',
      },
      {
        term: 'How long',
        text: 'We delete everything 12 months after your last visit, or straight away when you tap Forget me.',
      },
      {
        term: 'Rather type?',
        text: 'You can type instead of speaking. The microphone is never needed.',
      },
    ],
    aiNotice: 'Emily is an AI and may make mistakes.',
    privacyLink: { label: 'Read the privacy policy', href: '/privacy#voice' },
    start: 'Start talking',
    starting: 'Connecting',
    close: 'Close',
    end: 'End',
    micOn: 'Mute microphone',
    micOff: 'Use microphone',
    listening: 'Listening',
    muted: 'Microphone off',
    upload: 'Add a file',
    uploadHint: 'PDF, .txt or .md, up to 2 MB.',
    uploaded: 'Emily has read',
    typeLabel: 'Type to Emily',
    typePlaceholder: 'Type a message',
    send: 'Send',
    you: 'You',
    emily: 'Emily',
    memoryOpen: 'What you remember',
    memoryTitle: 'What Emily remembers about you',
    memoryFacts: 'Facts',
    memoryTurns: 'Recent conversation',
    memoryFiles: 'Files',
    memoryEmpty: 'Nothing yet.',
    forget: 'Forget me',
    forgotten: 'Done. Emily has forgotten everything about you.',
    notices: {
      unavailable: 'Voice is not connected yet. Please try again later.',
      check: 'The person check did not load. Please reload the page and try again.',
      checkPending: 'One moment: checking you are a person.',
      busy: 'Emily is talking with a lot of people right now. Please try again in a few minutes.',
      limit: 'That is all the talking for today. Please come back tomorrow.',
      micDenied: 'The microphone is off, so you can type to Emily instead.',
      timeUp: 'This conversation reached its 20 minute limit. Start again whenever you like.',
      failed: 'Something went wrong. Please try again.',
      fileTooBig: 'That file is over 2 MB.',
      fileType: 'Please choose a PDF, .txt or .md file.',
      fileFailed: 'Emily could not read that file.',
      reconnecting: 'Reconnecting',
    },
  },

  partners: {
    label: 'Partners',
    /** The control that holds the moving logos still. */
    pause: 'Pause',
    /** Shown next to a sentence the partner has not yet confirmed, so launch review cannot miss it. */
    unconfirmedFlag: '[wording to be confirmed]',
    items: [
      {
        name: 'NVIDIA',
        sentence: 'Emersa was accepted into the NVIDIA Inception Program in February 2026.',
        logo: 'nvidia.png',
        logoDark: 'nvidia-dark.png',
        href: 'https://www.nvidia.com/en-us/startups/',
      },
      {
        name: 'SUSE',
        sentence: 'Emersa Ltd is an approved SUSE partner at Innovate Sapphire tier, 2026.',
        logo: 'suse.png',
        logoDark: 'suse-dark.png',
        href: 'https://www.suse.com/',
      },
      {
        name: 'TechPassport',
        sentence: 'TechPassport certification is supplier onboarding for banks, not a security accreditation.',
        unconfirmed: true,
        logo: 'techpassport.png',
        logoDark: 'techpassport-dark.png',
        href: 'https://www.techpassport.io/',
      },
      {
        name: 'Secarma',
        sentence: 'Secarma provides independent security testing.',
        unconfirmed: true,
        logo: 'secarma.svg',
        logoDark: 'secarma-dark.svg',
        logoStacked: true,
        href: 'https://secarma.com/',
      },
    ] satisfies Partner[],
  },

  story: {
    eyebrow: 'Story',
    title: 'From non-player characters to synthetic beings.',
    steps: [
      {
        year: '2023',
        title: 'A games studio in London',
        text: 'Emersa started as a gaming company. We were unhappy with how characters behaved: scripted, forgetful, lifeless. We set out to fix that.',
      },
      {
        year: '2024',
        title: 'Intelligent characters',
        text: 'We gave our characters memory, perception and intent. They remembered the player, read the room and acted on their own. People stopped calling them NPCs.',
      },
      {
        year: '2025',
        title: 'Synthetic beings',
        text: 'The characters outgrew the games. A being that can see, remember and act is useful wherever people need guidance. We gave the idea a name.',
      },
      {
        year: 'Now',
        title: 'Beings at work',
        text: 'Emily Wilson guides enterprises. Krupiq guards their networks. This site is guided by one of them.',
      },
    ],
  },

  products: {
    eyebrow: 'Products',
    title: 'Two beings, one lineage.',
    emily: {
      name: 'Emily Wilson',
      kicker: 'Enterprise hologram assistant',
      lead: 'An ambient, agentic assistant that sees your dashboards, remembers your procedures and walks your people through them, step by step.',
      points: [
        'Digital-twin aware: she can see processes and data flows, then navigate and act with you.',
        'Deploys on-premises, in a sovereign cloud or fully air-gapped, with full observability.',
        'Humans stay in the loop for sensitive actions, with reversible steps and immutable audit trails.',
        'Fine-tuned on your own corpus, with evaluation gates before every version ships.',
      ],
      video: {
        title: 'Emily Wilson at work',
        placeholder: 'Footage coming soon. Book a demo to see Emily live.',
      },
      cta: { label: 'Book a 20-minute demo', href: '/contact?topic=emily' },
    },
    krupiq: {
      name: 'Krupiq',
      kicker: 'A network that exists only for intruders',
      lead: 'Krupiq lays a living decoy over your network. An intruder sees a network that looks like yours and changes shape before they can map it. Your data stays where it is.',
      cta: { label: 'Visit krupiq.com', href: 'https://krupiq.com' },
    },
  },

  technology: {
    eyebrow: 'Technology',
    title: 'Triangles are data.',
    lead: 'A being is a mesh driven by what it hears, reads and thinks. On this page you are looking at the structure, not the skin.',
    cards: [
      {
        title: 'The structure',
        text: 'When Emily speaks, the triangles of her face move with every sound. When she thinks, the mesh sparkles at the rate of her thoughts. When you talk, a ring of points listens.',
      },
      {
        title: 'The brain',
        text: 'Small, fast language models run close to your data on NVIDIA hardware, in your building or ours. What a being remembers is yours to see and yours to erase.',
      },
      {
        title: 'The posture',
        text: 'Every part gets only the access it needs, data is encrypted by default, and the whole system can run with no connection to the internet.',
      },
    ],
  },

  docs: {
    eyebrow: 'Docs',
    title: 'How beings work.',
    lead: 'Plain documentation: what a synthetic being is, how Emily deploys, and what this site remembers about you.',
    cta: { label: 'Read the docs', href: '/docs' },
    sections: { beings: 'Beings', products: 'Products', trust: 'Trust' } satisfies Record<DocSection, string>,
    chrome: {
      contents: 'On this page',
      updated: 'Updated',
      pager: 'Previous and next',
      previous: 'Previous',
      next: 'Next',
    },
  },

  games: {
    eyebrow: 'Games',
    title: 'Where it started.',
    lead: 'Our first beings lived in games. New titles will be listed here as we announce them.',
    cta: { label: 'See the games', href: '/games' },
    statuses: { 'coming-soon': 'Coming soon', released: 'Released' } satisfies Record<GameStatus, string>,
  },

  contact: {
    eyebrow: 'Get in touch',
    title: 'Tell us what you would build.',
    lead: 'Book a 20-minute demo of Emily Wilson, ask about Krupiq, or tell us what you would build. We reply from a human inbox.',
    topics: [
      { value: 'emily', label: 'Emily Wilson demo' },
      { value: 'krupiq', label: 'Krupiq' },
      { value: 'partnership', label: 'Partnership' },
      { value: 'other', label: 'Something else' },
    ],
    submit: 'Send',
    sent: { title: 'Thank you.', text: 'Your message is on its way. We reply within two working days.' },
    error: { title: 'That did not send.', text: 'Please email sales@emersa.io and we will pick it up from there.' },
    privacyNote: 'We use your details only to answer you. See the privacy policy.',
    /** The words in privacyNote that become the link to the policy. */
    privacyLink: 'privacy policy',
    fields: {
      name: 'Name',
      email: 'Email',
      company: 'Company',
      optional: 'optional',
      topic: 'Topic',
      topicPlaceholder: 'Choose a topic',
      message: 'Message',
    },
  },

  footer: {
    tagline: 'Synthetic beings, made in London since 2023.',
    columns: [
      {
        title: 'Products',
        links: [
          { label: 'Emily Wilson', href: '/#products' },
          { label: 'Krupiq', href: 'https://krupiq.com' },
        ],
      },
      {
        title: 'Company',
        links: [
          { label: 'Story', href: '/#story' },
          { label: 'Docs', href: '/docs' },
          { label: 'Games', href: '/games' },
          { label: 'Contact', href: '/contact' },
        ],
      },
    ],
    legalLinks: [
      { label: 'Privacy', href: '/privacy' },
      { label: 'Terms', href: '/terms' },
      { label: 'Security', href: '/security' },
    ],
    linkedin: 'LinkedIn',
    vulnerability: 'Found a vulnerability?',
  },

  tour: {
    start: 'Start the tour',
    next: 'Next',
    back: 'Back',
    replay: 'Replay',
    mute: 'Mute',
    end: 'End tour',
    resumeHere: 'Take the tour from here',
    /** The voice failed to arrive, or took too long. */
    captionsOnly: 'Captions only: voice clips are not available on this connection.',
    /** No 3D guide on this visit (reduced motion, no WebGL2), and the voice plays only with the guide. */
    captionsOnlyStill: 'Captions only: the voice plays with the 3D guide, which is off on this device.',
    transcriptEyebrow: 'Transcript',
    transcriptTitle: 'What Emily says on the tour',
    transcriptHint: 'Open to read all nine stops',
  },

  notFound: {
    title: 'Page not found',
    description: 'There is nothing at this address.',
    eyebrow: '404',
    heading: 'This page is not here.',
    speaker: 'Emily',
    lead: 'I looked everywhere and nothing by that name lives on this site. Let me walk you back.',
    actionsLabel: 'Where to go next',
    actions: [
      { label: 'Back to the start', href: '/' },
      { label: 'Read the docs', href: '/docs' },
      { label: 'Write to us', href: '/contact' },
    ],
  },

  /** Names for controls and landmarks that carry no visible copy of their own. */
  a11y: {
    skip: 'Skip to content',
    primaryNav: 'Primary',
    menu: 'Menu',
    darkMode: 'Dark mode',
    tourControls: 'Tour controls',
    footerNav: 'Footer',
  },
} as const;

export type Site = typeof site;

/**
 * Every word on the site lives here (or in src/content for docs and the tour). Components render it; they never
 * carry copy of their own. Plain language, no jargon, no claims we cannot back.
 */
import type { DocSection } from '../content.config.ts';
import { legal } from './legal.ts';

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

/** The one address for everything: demos, privacy requests and vulnerability reports. */
export const CONTACT_MAILTO = 'mailto:4d@emersa.io?subject=Emily%20Wilson';

/** Report an incident: the same inbox as vulnerability reports, with a short template in the body. */
const REPORT_BODY = [
  'What happened:',
  'When (date, time and time zone):',
  'What you saw (addresses, sender, screenshots attached):',
  'Does it involve an Emersa product? (Emily, Krupiq, this site, no):',
  'How to reach you:',
].join('\n\n');
export const REPORT_MAILTO = `mailto:${legal.securityEmail}?subject=${encodeURIComponent('Report to Emersa')}&body=${encodeURIComponent(REPORT_BODY)}`;

export const site = {
  name: 'Emersa Labs',
  shortName: 'Emersa',
  url: siteUrl,
  tagline: 'We make synthetic beings.',
  description:
    'Emersa Labs builds synthetic beings for compliance, machine learning, cybersecurity and resilience: ambient, agentic systems that see, remember and act on your behalf. Emily Wilson for the enterprise, Krupiq for the network. London, since 2023.',
  locale: 'en_GB',

  nav: [
    { label: 'About', href: '/#about' },
    { label: 'Products', href: '/#products' },
    { label: 'Stay safe', href: '/#stay-safe' },
    { label: 'Technology', href: '/#technology' },
    { label: 'Docs', href: '/docs' },
  ] satisfies NavItem[],

  hero: {
    eyebrow: 'Emersa Labs · London · since 2023',
    title: 'We make synthetic beings.',
    lead: 'Ambient, agentic beings for compliance, machine learning, cybersecurity and resilience: they see your systems, remember your procedures and act.',
    primary: { label: 'Start the tour', href: '#tour' },
    /** The href is the no-JavaScript fallback; with scripts the link opens the Talk monitor instead. */
    talk: { label: 'Talk to Emily', href: CONTACT_MAILTO, close: 'Close' },
    guideLabel: 'Emily Wilson, rendered as the structure beneath the skin',
    voiceLabel: 'AI-generated voice',
  },

  /** The Talk monitor: consent first, then the conversation. Every line a visitor reads before they start. */
  talk: {
    headerLink: 'Talk to Emily',
    /** The header link on the narrowest phones, where the full label would crowd the mark. */
    headerLinkShort: 'Talk',
    title: 'Talk to Emily',
    monitorLabel: 'Emily · live',
    monitorSpeaking: 'Emily · speaking',
    monitorConsentLabel: 'Before you start',
    tourLabel: 'Tour',
    intro: 'Before you start, here is what happens when you talk to Emily.',
    /** The red notice at the top of the consent view: the essentials, before Start talking is pressed. */
    alert: {
      title: 'Please read before you press Start talking',
      items: [
        'Emily is free for up to 5 minutes a conversation: three conversations on your first day, then one a day.',
        'What you type or say goes to third parties: Convai Technologies in the United States runs Emily, and Cloudflare runs this site. We keep your conversation for 12 months so Emily remembers you.',
        'Do not share passwords, bank, health or other sensitive details, or anyone else’s personal data.',
      ],
      agreeBefore: 'By pressing Start talking you agree to our',
      terms: { label: 'Terms', href: '/terms' },
      and: 'and',
      privacy: { label: 'Privacy policy', href: '/privacy#voice' },
      paidSoon: 'Need more time? A paid option is coming soon, by popular demand.',
      paidOn: 'Need more time? You can buy 60 minutes for £5.',
      /** What is left today, filled in when Talk opens ({left}, {of}, {minutes}). */
      left: 'Free today: {left} of {of} left.',
      credit: 'You also have {minutes} bought minutes.',
    },
    consent: [
      {
        term: 'Who handles it',
        text: 'Cloudflare runs this site. Convai Technologies in the United States reads what you type or say, writes Emily’s replies and gives her her voice. Microsoft handles speech only if we switch to its Azure speech service, and this list will say so first.',
      },
      {
        term: 'Your microphone',
        text: 'Used only while you hold the microphone button or hold Emily herself, and never otherwise. Typing needs no microphone at all.',
      },
      {
        term: 'What Emily remembers',
        text: 'What you say, what she replies, a few facts you mention (such as your name, your company or what you are interested in) and any file you add (its first 6,000 characters go to Emily). She keeps this so she can pick up where you left off.',
      },
      {
        term: 'How long',
        text: 'We delete everything 12 months after your last visit, or straight away when you tap Forget me.',
      },
    ],
    freeMinutes: 'More for your organisation: email 4d@emersa.io.',
    aiNotice: 'Emily is an AI and may make mistakes.',
    privacyLink: { label: 'Read the privacy policy', href: '/privacy#voice' },
    start: 'Start talking',
    starting: 'Connecting',
    close: 'Close',
    end: 'End',
    speak: 'Hold to speak',
    retry: 'Retry',
    speakHold: 'Hold to speak',
    /** The guide line: shown once when the conversation opens, for ten seconds (scripts/talk-guide.ts). */
    howTo: 'Type your message and press Send, or hold the microphone button or Emily herself and speak.',
    listening: 'Listening. Release to send.',
    upload: 'Add a file',
    /** Shown when the paperclip is pressed, before the file picker opens. */
    fileNote:
      'Emily reads plain text (.txt) files up to 2 MB and takes in the first 6,000 characters. The text is kept with what she remembers about you, for 12 months after your last visit, and Forget me deletes it. Please add nothing confidential and no one else’s personal data.',
    fileChoose: 'Choose a .txt file',
    /** Shown as a conversation starts: which free one it is ({used} of {of}). */
    allowanceFirstDay:
      'Conversation {used} of {of} today, on us, up to five minutes each. From tomorrow it is one a day.',
    allowanceDaily: 'Your free conversation for today, up to five minutes.',
    allowancePaid: 'A paid conversation of up to {max} minutes. {left} minutes left after it.',
    /** Offered when the free conversations are used. */
    buyNote:
      '60 minutes with Emily for £5, paid securely through Stripe; we never see your card. The minutes are yours at once, on this browser.',
    buy: 'Buy 60 minutes · £5',
    fileCancel: 'Cancel',
    uploaded: 'Emily has read',
    typeLabel: 'Type to Emily',
    typePlaceholder: 'Type your message here',
    send: 'Send',
    you: 'You',
    emily: 'Emily',
    memoryOpen: 'What Emily remembers',
    memoryTitle: 'What Emily remembers about you',
    memoryFacts: 'Facts',
    memoryTurns: 'Recent conversation',
    memoryFiles: 'Files',
    memoryEmpty: 'Nothing yet.',
    forget: 'Forget me',
    /** The disclosure in the conversation's head row that holds What Emily remembers and End. */
    more: 'More',
    forgotten: 'Done. Emily has forgotten everything about you.',
    notices: {
      unavailable: 'Voice is not connected yet. Please try again later.',
      check: 'The person check did not load. Please reload the page and try again.',
      checkPending: 'One moment: checking you are a person.',
      busy: 'Emily is talking with a lot of people right now. Please try again in a few minutes.',
      limit: 'That is all the talking for today. Please come back tomorrow.',
      minutesUp:
        'That is your five free minutes for today. Come back tomorrow, or email 4d@emersa.io for Emily in your organisation.',
      micDenied:
        'Emily cannot hear you: the microphone is blocked for this site. On iPhone tap aA, then Website Settings, Microphone, Allow, and reload. You can keep typing.',
      micMissing: 'No microphone was found. You can keep typing.',
      micBusy: 'Another app is using the microphone. Close it and hold the microphone again, or keep typing.',
      micFailed: 'This browser could not open the microphone. You can keep typing.',
      audioBlocked: 'Your browser is holding Emily’s sound back. Tap anywhere on the page to hear her.',
      timeUp: 'This conversation reached its time limit. Start again whenever you like.',
      failed: 'Something went wrong. Please try again.',
      offline: 'The site could not be reached. Check your connection and try again.',
      voiceBlocked:
        'Emily’s voice could not connect from this browser. A content blocker or a strict network may be stopping it.',
      policyBlocked: 'This page’s security policy blocked the voice service. Please reload the page and try again.',
      fileTooBig: 'That file is over 2 MB.',
      fileType:
        'Emily reads .txt files only. Save your document as plain text first (in Word: File, Save As, Plain Text; from a PDF, copy the text into Notepad and save it), then add it again.',
      fileFailed: 'Emily could not read that file.',
      reconnecting: 'Reconnecting',
      payThanks: 'Thank you. You have {minutes} minutes with Emily: press Start talking.',
      payPending:
        'Thank you. Your payment is being confirmed and your minutes will be there in a moment: press Start talking.',
      payCancelled: 'No payment was taken.',
      payFailed: 'The payment page could not be opened. Please try again in a minute.',
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

  about: {
    eyebrow: 'About',
    title: 'From intelligent characters to beings that keep enterprises safe.',
    steps: [
      {
        year: '2021',
        title: 'Inception',
        text: 'The idea of a character that remembers and acts on its own. First research and prototypes.',
      },
      {
        year: '2023',
        title: 'A games studio in London',
        text: 'Emersa started as a games studio. We were unhappy with how characters behaved: scripted, forgetful, lifeless. We set out to fix that, and the fix turned out to matter far beyond games.',
      },
      {
        year: '2024',
        title: 'Intelligent characters',
        text: 'We gave our characters memory, perception and intent. They remembered the player, read the room and acted on their own. People stopped calling them NPCs.',
      },
      {
        year: '2025',
        title: 'Synthetic beings',
        text: 'The characters outgrew the games. A being that can see, remember and act is useful wherever people need guidance. We gave the idea a name. Emily Wilson took her first enterprise work.',
      },
      {
        year: '2026',
        title: 'The Krupiq platform',
        text: 'The beings turned to defence: Krupiq, a living decoy network, and Emily’s swarm for compliance work. Emersa was accepted into NVIDIA Inception and the SUSE partner programme.',
      },
    ],
  },

  products: {
    eyebrow: 'Products',
    title: 'Two beings, one job: keeping you secure and compliant.',
    emily: {
      name: 'Emily Wilson',
      kicker: 'Enterprise agentic platform',
      lead: 'An ambient, agentic platform: a swarm of up to 100 agents, running on SUSE Linux Enterprise on your own machines, that sees your systems, remembers your procedures and carries them out with your people, step by step.',
      points: [
        'Digital-twin aware: she can see processes and data flows, then navigate and act with you.',
        'Runs as a swarm: up to 100 agents, each with one job, on SUSE Linux Enterprise, on-premises, in a sovereign cloud or air-gapped.',
        'Humans stay in the loop for sensitive actions, with reversible steps and immutable audit trails.',
        'Built for compliance work: every action is logged, reversible and attributable, so audits are read, not reconstructed.',
        'Fine-tuned on your own corpus, with evaluation gates before every version ships.',
      ],
      video: {
        title: 'Emily Wilson at work',
        placeholder: 'Footage coming soon. Talk to Emily to see her live.',
      },
      /** Opens the Talk monitor; the href is the fallback without scripts. */
      cta: { label: 'Talk to Emily', href: CONTACT_MAILTO },
    },
    krupiq: {
      name: 'Krupiq',
      kicker: 'Cybersecurity and compliance',
      lead: 'A compliance tool that takes care of cybersecurity. Krupiq lays a living decoy over your network: an intruder sees a network that looks like yours and changes shape every five minutes, while your data stays where it is.',
      points: [
        { term: 'Observe', text: 'Every packet the intruder sends is seen, from the first one.' },
        { term: 'Morph', text: 'Every five minutes the decoy takes a new shape; nothing real is inside it.' },
        { term: 'Prove', text: 'A signed proof for every change, checkable offline.' },
        {
          term: 'Comply',
          text: 'GDPR, NIS2, DORA and SEC duties are met by how it is built. A full audit in minutes, as an immutable PDF.',
        },
      ],
      deployment: 'Windows, Linux and macOS, on your own machines. Nothing leaves your network.',
      cta: { label: 'Visit krupiq.com', href: 'https://krupiq.com' },
    },
  },

  /** Free advice for people and small teams: the checks that stop most attacks, and where to report one. */
  staySafe: {
    eyebrow: 'Free advice',
    title: 'Eight checks that stop most attacks.',
    lead: 'None of these needs a product; they take an afternoon and protect you for years.',
    items: [
      {
        title: 'Long, unique passwords in a manager',
        text: 'One long password for each account, kept in a password manager so you never have to remember or reuse one.',
      },
      {
        title: 'Two-factor sign-in everywhere it is offered',
        text: 'A code or a key on top of the password. A stolen password alone then opens nothing.',
      },
      {
        title: 'Updates on the day they arrive',
        text: 'Most break-ins use a hole that was fixed weeks before. Turn automatic updates on and let them run.',
      },
      {
        title: 'A pause before any link or attachment you did not expect',
        text: 'If a message pushes you to act now, stop. Check the sender through a channel you already trust.',
      },
      {
        title: 'Backups kept offline and tested',
        text: 'A copy that no attacker on your network can reach, and a restore you have actually tried.',
      },
      {
        title: 'Least privilege at work',
        text: 'Nobody needs admin for email. Give each account only what its job needs, and the damage of one mistake stays small.',
      },
      {
        title: 'A second channel before paying an invoice or changing bank details',
        text: 'Call the number you already have, not the one in the message. Confirm with a person, then pay.',
      },
      {
        title: 'Report it early',
        text: 'An early report stops the next victim. Tell your bank, your IT team or the police as soon as you suspect something.',
      },
    ],
    closing:
      'Do these eight and most attacks pass you by. The full guide explains each one and what to do if something already happened.',
    guide: { label: 'Read the full guide', href: '/docs/stay-safe' },
  },

  /** The report button: one email, one template, the same inbox as vulnerability reports. */
  report: {
    label: 'Report cyberattack',
    /** The header's label on a mid-width screen. */
    short: 'Report attack',
    long: 'Report a cyberattack',
    hint: 'Opens an email to 4d@emersa.io with a short template.',
    href: REPORT_MAILTO,
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
        text: 'Every part gets only the access it needs, data is encrypted by default, and the whole system can run with no connection to the internet. Every action lands in a signed audit trail that can be checked offline. When a link or a service fails, a being degrades to captions and checklists, never to silence.',
      },
      {
        title: 'The learning',
        text: 'Models are fine-tuned on your own corpus and evaluated before every release. Every prediction a being acts on is logged with what it saw, so a decision can be audited, not guessed at.',
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

  footer: {
    tagline: 'Synthetic beings for compliance, machine learning, cybersecurity and resilience. London, since 2023.',
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
          { label: 'About', href: '/#about' },
          { label: 'Docs', href: '/docs' },
          { label: 'Email us', href: 'mailto:4d@emersa.io' },
          { label: 'Report an incident', href: REPORT_MAILTO },
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
    transcriptHint: 'Open to read all eight stops',
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
      { label: 'Email us', href: 'mailto:4d@emersa.io' },
    ],
  },

  /** Names for controls and landmarks that carry no visible copy of their own. */
  /** The zero-knowledge QR code generator. Everything runs in the visitor's browser. */
  tools: {
    eyebrow: 'On your device',
    title: 'A QR code generator that keeps your data where it is.',
    lead: 'Everything happens in your browser: no server, no counter, no copy of what you type. Close the tab and it is gone.',
    qr: {
      title: 'Zero-knowledge QR code generator',
      lead: 'Static, permanent QR codes built on your device. Nothing you type is uploaded, stored or logged. There is no server in the loop.',
      modes: {
        link: 'Link',
        text: 'Text',
        wifi: 'Wi-Fi',
        contact: 'Contact',
        email: 'Email',
      },
      modesLabel: 'What the code holds',
      fields: {
        url: 'Website or link',
        urlPlaceholder: 'emersa.io',
        text: 'Plain text',
        textPlaceholder: 'Any text you want in the code',
        ssid: 'Network name (SSID)',
        password: 'Password',
        security: 'Security',
        securityWpa: 'WPA, WPA2 or WPA3',
        securityWep: 'WEP',
        securityNone: 'None (open)',
        hiddenNetwork: 'Hidden network',
        firstName: 'First name',
        lastName: 'Last name',
        organisation: 'Organisation',
        phone: 'Phone',
        email: 'Email',
        website: 'Website',
        to: 'To',
        toPlaceholder: 'name@example.com',
        subject: 'Subject',
        message: 'Message',
      },
      options: {
        summary: 'Customise',
        hint: 'colour, size, error level',
        errorCorrection: 'Error correction',
        ecLow: 'Low (7%)',
        ecMedium: 'Medium (15%)',
        ecQuartile: 'Quartile (25%)',
        ecHigh: 'High (30%)',
        size: 'Download size',
        foreground: 'Foreground',
        background: 'Background',
        transparent: 'Transparent background',
      },
      canvasLabel: 'Your generated QR code',
      downloadPng: 'Download PNG',
      downloadSvg: 'Download SVG',
      wipe: 'Wipe',
      status: {
        empty: 'Fill in the fields to generate a QR code.',
        ready: 'Ready. {n} characters encoded and nothing left your device.',
        wiped: 'Wiped. Nothing was ever stored.',
        tooLong: 'That is too much data for one QR code. Try shortening it.',
      },
      noScript: 'The generator needs JavaScript to draw the code. With it on, nothing you type leaves your device.',
    },
  },

  a11y: {
    skip: 'Skip to content',
    primaryNav: 'Primary',
    menu: 'Menu',
    darkMode: 'Dark mode',
    tourControls: 'Tour controls',
    talkPanel: 'Talk to Emily',
    speakButton: 'Hold to speak',
    footerNav: 'Footer',
  },
} as const;

export type Site = typeof site;

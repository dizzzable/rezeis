/**
 * "Contests" feature bundle (EN), lazy-loaded via withFeatureBundle('contests').
 * See `contests.ru.ts`.
 */
export const en = {
  contestsPage: {
    form: {
      descriptionRu: 'Description (RU)',
      descriptionEn: 'Description (EN)',
      descriptionHint: 'Rules and conditions. Line breaks are kept.',
      prizeTitleEn: 'Prize title (EN)',
      lockedLive:
        'The contest is running: people entered on these terms. You can fix the title and the description and move the end to a later time.',
      endAtExtend: 'End and draw — later only',
      audience: 'Who may enter',
      audienceHint: 'Nothing selected — everybody except blocked users. Within a row it is “or”, between rows “and”.',
      subscription: 'Subscription',
      sub: {
        ACTIVE: 'Active',
        EXPIRED: 'Expired',
        TRIAL: 'Trial',
        LIMITED: 'Limited',
        NONE: 'No subscription',
      },
      plan: 'Plan',
      planEmpty: 'No plans in the catalogue yet',
      platform: 'Platform',
      platforms: {
        telegram: 'Telegram',
        miniapp: 'Mini App',
        web: 'Web',
      },
      contact: 'Has contact',
      contacts: {
        hasTelegram: 'Telegram',
        hasEmail: 'Email',
        hasWebPush: 'Web push',
      },
      inactiveDays: 'Inactive ≥ days',
      inactiveDaysPlaceholder: 'e.g. 30',
      channel: 'Channel subscription',
      channelHint:
        'With a channel set, the cabinet asks Telegram whether the person is subscribed before taking the entry. The bot must be an admin of the channel. An account without Telegram cannot enter. Checked once, on entry.',
      channelLink: 'Channel link',
      channelLinkPlaceholder: 'https://t.me/…',
      channelId: 'Channel ID',
      channelIdPlaceholder: '-100… — required for a private channel',
      tickets: 'Extra chances',
      ticketsHint:
        'Entering gives one ticket. Here you can give more: for each payment and for each invited friend who paid for a subscription — during the contest. More tickets, a better chance, but one place per person. A refund before the draw takes its tickets back. 0 — off.',
      ticketsPerPurchase: 'For each payment',
      ticketsPerReferral: 'For each friend who paid',
      maxTicketsPerUser: 'Ticket ceiling per person',
      maxTicketsPlaceholder: 'no ceiling',
      announce: 'Announce the contest',
      announceHint:
        'When the contest starts, the bot and the cabinet tell everybody who may enter — a few hundred messages a minute. The wording is in “Notification templates”, “A new contest”. Entrants always get their results.',
    },
    row: {
      drawError: 'The draw failed: {{error}}',
      drawErrorHint: 'Retried every minute until it goes through.',
      channel: 'Channel',
      tickets: 'Tickets',
      announceSending: 'Announcement going out',
      announceSent: 'Announcement sent',
      resultsSending: 'Results going out',
      resultsSent: 'Results sent',
    },
    actionsExtra: {
      entrants: 'Entrants',
    },
    cancelDialog: {
      title: 'Cancel the contest?',
      description:
        'There will be no draw, nobody gets a prize, and it cannot be undone. The entries stay on record. Entrants are not messaged — the cabinet marks the contest “Cancelled”.',
      confirm: 'Cancel the contest',
    },
    entrants: {
      title: 'Entrants: {{count}}',
      empty: 'Nobody has entered yet.',
      tickets_one: '{{count}} ticket',
      tickets_few: '{{count}} tickets',
      tickets_many: '{{count}} tickets',
      tickets_other: '{{count}} tickets',
      liveHint: 'Before the draw, tickets are counted from payments and friends as of this minute; the draw counts them for good.',
      more: 'Show more',
      noName: 'No name',
    },
    draw: {
      tickets: 'Tickets in the draw: {{count}}',
      seed: 'Draw key',
      seedHint:
        'Made at publication. Until the draw the cabinet showed only its SHA-256, so anybody can check the key was not changed.',
    },
  },
};

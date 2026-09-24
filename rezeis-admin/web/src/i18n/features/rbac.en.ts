/**
 * Lazy-loaded i18n feature bundle (en): rbac
 *
 * The roles page (`features/rbac/roles-page.tsx`) and its permission
 * catalogue. Loaded by the page itself before it paints; see `useRolesWords`.
 *
 * Contains namespaces: rolesPage — all of it except `rolesPage.systemRoles`,
 * which the Administrators page needs for its role picker and so stays in
 * the core dictionary.
 */

export const en = {
  rolesPage: {
    title: 'Roles & permissions',
    subtitle:
      'Who may do what in the panel. A role is a set of permissions: create one here, then assign it to an admin on the Administrators tab.',
    intro:
      'A role is a set of permissions for the sections of the panel. Assign it to an admin on the Administrators tab, in the “Access role (RBAC)” field, and they can do only what the role allows. Hover over or tap the (i) beside any row to see what each permission unlocks.',
    syncButton: 'Sync system roles',
    syncTip:
      'Creates any missing system role and adds the permissions a panel update brought to them. Removes nothing and does not touch your own roles.',
    syncSuccess: 'System roles synced',
    syncFailed: 'Could not sync the system roles: {{message}}',
    newRole: 'New role',
    newRoleTip: 'Opens the form for a new role: an identifier, a name and the permissions it grants.',
    noRoles: 'No roles yet. System roles appear after the next backend start.',
    selectRole: 'Select a role on the left to see and edit its permissions.',
    noPermission: 'Unavailable: your role does not include “{{permission}}”.',
    nameTooShort: 'Enter a name of at least 2 characters first.',
    moreAbout: 'More about {{name}}',
    accessDeniedTitle: 'Roles are not available to you',
    accessDenied: 'Your role does not include “{{permission}}”, so the roles are not shown.',
    loadFailedTitle: 'The roles did not load',
    roleLoadFailedTitle: 'This role did not load',
    counts: {
      permissions_one: '{{count}} permission',
      permissions_other: '{{count}} permissions',
      admins_one: '{{count}} admin',
      admins_other: '{{count}} admins',
    },
    editor: {
      identifier: 'Identifier: {{name}}',
      systemRole: 'System role',
      save: 'Save',
      saveTip:
        'Saves the name, description and ticked permissions. If you removed a permission, every admin with this role is signed out and signs in again with the new set.',
      saveTipSystem: 'Saves the name and description. The permissions of a system role cannot be changed.',
      delete: 'Delete',
      deleteTip: 'Deletes the role for good. Only a role nobody holds can be deleted.',
      deleteAssigned_one:
        'The role is assigned to {{count}} admin. Give them another role on the Administrators tab first.',
      deleteAssigned_other:
        'The role is assigned to {{count}} admins. Give them another role on the Administrators tab first.',
      deleteConfirm: 'Delete the role “{{name}}”? This cannot be undone.',
      displayName: 'Name',
      displayNameInfo: 'What admins see in the role list and when a role is assigned to them.',
      description: 'Description',
      descriptionInfo: 'Who the role is for and what it lets them do. Only admins see it.',
      descriptionPlaceholder: 'What this role is for',
      systemReadOnly: 'The permissions of a system role cannot be changed',
      systemReadOnlyDescription:
        'The panel sets them itself: Superadmin gets everything, including permissions added by future versions, and the other system roles get a fixed set. You can still change the name and description. For a different set of permissions, create your own role with “New role”.',
      unknownTitle: 'This role holds permissions the panel no longer has',
      unknownBody:
        'They grant nothing, and the server will not save a role that holds them. Remove them, then save the role:',
      unknownRemove: 'Remove them',
    },
    matrix: {
      title: 'Permissions',
      sectionColumn: 'Section',
      dangerLabel: 'Why this is dangerous: {{permission}}',
      dangerPrefix: 'Dangerous:',
      dangerLegend:
        'marks a dangerous permission: it can move money, destroy data for good, lock people out or expose secrets. Hover over or tap the sign to see why.',
      blockedLegend: 'Greyed-out boxes are permissions you do not hold yourself, so you cannot grant them.',
      cannotGrant: 'You cannot grant a permission you do not hold yourself',
      beyondActorTitle: 'This role holds permissions you do not',
      beyondActorBody:
        'Saving is refused while they stay ticked. You may remove them; you may not grant them:',
      tickAll: 'all',
      // Begins with the visible word ({{label}}): the accessible name of a
      // control has to contain the text it shows (WCAG 2.5.3).
      tickAllLabel: '{{label}}: tick the permissions of “{{name}}” that you can grant',
      clearAll: 'none',
      clearAllLabel: '{{label}}: untick every permission of “{{name}}”',
    },
    groups: {
      overview: 'Overview',
      customers: 'Customers',
      subscriptions: 'Subscriptions and plans',
      payments: 'Payments',
      support: 'Support',
      marketing: 'Marketing',
      content: 'Content and appearance',
      remnawave: 'Remnawave and imports',
      integrations: 'Automation and integrations',
      access: 'Access and security',
      system: 'System',
      other: 'Other',
    },
    // What each action means across the whole catalogue: the column headers
    // and their (i). What it means for ONE section is in `resources` below.
    actions: {
      view: {
        name: 'View',
        description:
          'See the section’s data: lists, cards, statistics. Most other permissions of a section are of little use without it.',
      },
      create: {
        name: 'Create',
        description: 'Add new entries: a plan, a promo code, a rule, a broadcast.',
      },
      edit: {
        name: 'Edit',
        description:
          'Change what already exists. In many sections this also covers switching things on and off and changing their order.',
      },
      delete: {
        name: 'Delete',
        description: 'Remove entries. What is deleted usually cannot be brought back.',
      },
      bulk_operations: {
        name: 'Bulk actions',
        description: 'Act on many selected entries at once.',
      },
      resolve: {
        name: 'Resolve',
        description:
          'Decide on something that waits for a person: close a ticket, approve a withdrawal, hand over a prize, triage a signal. The exact meaning is in the (i) of each row.',
      },
      run: {
        name: 'Run',
        description: 'Start something by hand instead of waiting for its schedule or event.',
      },
      export: {
        name: 'Export',
        description: 'Download the section’s data as a file.',
      },
      import: {
        name: 'Import',
        description: 'Bring data in from outside: from a file or another panel.',
      },
      archive: {
        name: 'Archive',
        description: 'Read closed (archived) support conversations.',
      },
      enforce: {
        name: 'Enforce',
        description:
          'Take a hard measure against one customer: cut off their connections or reverse an add-on they received.',
      },
      moderate: {
        name: 'Moderate',
        description:
          'Approve or reject what waits for approval: partners’ ad requests, blocked device reductions.',
      },
      merge: {
        name: 'Merge',
        description: 'Combine two customer accounts into one. Cannot be undone.',
      },
      view_registration: {
        name: 'Registration data',
        description: 'See the IP address, browser, referrer and UTM tags a customer signed up with.',
      },
      export_registration: {
        name: 'Export registrations',
        description: 'Download the registration data of every customer as a file.',
      },
      refund: {
        name: 'Refund',
        description: 'Return money to a customer through the payment provider.',
      },
      view_secrets: {
        name: 'View secrets',
        description: 'See secret keys in full instead of masked.',
      },
    },
    // One entry per catalogue resource: its name, what it is about, one line
    // per action it offers and, for dangerous ones, why. Every line was written
    // against the route that permission guards; "has no effect yet" means no
    // route and no screen checks it. `permission-catalog.test.ts` fails when a
    // resource or action is missing here or no longer exists on the server.
    resources: {
      dashboard: {
        name: 'Dashboard',
        description:
          'The panel’s home page: key figures, server health and search across the panel. Search only returns what the role may view in each section.',
        actions: {
          view: 'The home page, server health, quick search, and system notifications for admins.',
        },
      },
      analytics: {
        name: 'Analytics',
        description: 'Business reports: revenue, retention, trial conversion, payment providers.',
        actions: {
          view: 'Every report on the Analytics page, and the Analytics tab in Payments.',
          export: 'Has no effect yet: nothing in the panel checks this permission.',
        },
      },
      users: {
        name: 'Users',
        description: 'Your service’s customers: the list, search and the customer card.',
        actions: {
          view: 'The list, search and the customer card: profile, activity history, points.',
          create: 'Add a customer by hand.',
          edit: 'Profile, points, blocking, invite settings, the web cabinet’s login and password, the Telegram link, a message to the customer.',
          delete: 'Delete a customer. Cannot be undone.',
          bulk_operations:
            'Act on selected customers at once: block, set the language, extend subscriptions, reset traffic and more. Deleting also needs “Delete”; blocking, extending and resets also need “Edit”.',
          merge:
            'Combine two accounts of one customer: subscriptions and payments move over, partner balances add up. Cannot be undone.',
          view_registration:
            'The sign-up IP, browser, referrer and UTM tags, and the addresses the customer has connected from, in the customer card.',
          export: 'Download the customer list as CSV with the columns you pick, without registration data.',
          export_registration:
            'Download everyone’s registration data (IP, browser, referrer, UTM) and unlock those columns in the regular export.',
        },
        danger: {
          delete: 'The customer is deleted together with their subscriptions and Remnawave profiles; there is no undo.',
          merge: 'The second account is deleted once its subscriptions and payments have moved; a merge cannot be undone.',
          export: 'Personal data of every customer, in one file.',
          export_registration: 'The IP addresses and sources of every customer, in one file: personal data.',
        },
      },
      blocked_identities: {
        name: 'Blocklist',
        description:
          'Telegram IDs, emails and logins that may not sign up or sign in, even before an account exists.',
        actions: {
          view: 'See the list.',
          create: 'Add entries, one at a time or as a list.',
          delete: 'Remove entries.',
        },
      },
      fraud_signals: {
        name: 'Fraud signals',
        description: 'Signs of suspicious customers: a shared subscription, too many devices or addresses.',
        actions: {
          view: 'Signals, statistics, the addresses a customer is connected from right now, exemptions, and notifications about new signals.',
          resolve:
            'Triage signals (acknowledge, resolve, dismiss), run the detectors by hand, grant and revoke exemptions.',
          enforce: 'Cut off the violator’s live connections through Remnawave.',
        },
      },
      subscriptions: {
        name: 'Subscriptions',
        description: 'Customers’ subscriptions: terms, traffic, devices and the link to Remnawave.',
        actions: {
          view: 'The subscription list and statistics, a subscription’s devices, price quotes for renewals and plan changes.',
          create: 'Give a customer a subscription or a trial.',
          edit: 'Change a subscription (term, plan, traffic and device limits, on or off) and its squads, reset its traffic, sync it with Remnawave; move subscribers off a plan (together with “Plans: Delete”).',
          delete: 'Delete a subscription or unbind one of the customer’s devices.',
        },
        danger: {
          delete: 'The subscription and its Remnawave profile are removed: the customer loses what they paid for, with no undo.',
        },
      },
      plans: {
        name: 'Plans',
        description: 'The plans customers buy: prices, terms, limits and squads.',
        actions: {
          view: 'The plans, their statistics and settings.',
          create: 'Add a plan.',
          edit: 'Change plans and their order, archive and restore them, give a particular customer access to a plan.',
          delete: 'Delete a plan and move its subscribers to another one (together with the subscription permissions).',
        },
      },
      add_ons: {
        name: 'Add-ons',
        description: 'The catalogue of paid extras for a subscription: extra traffic and devices.',
        actions: {
          view: 'The catalogue and its statistics.',
          create: 'Add an add-on.',
          edit: 'Change an add-on or archive it.',
          delete: 'Delete an add-on.',
        },
      },
      add_on_entitlements: {
        name: 'Add-on delivery',
        description:
          'How purchased add-ons reach customers’ subscriptions, and repairing failures. Among the system roles only Superadmin has it.',
        actions: {
          view: 'Delivery metrics and a subscription’s full picture: ledger, incidents, device plans.',
          run: 'Retry a stalled push to Remnawave.',
          resolve: 'Force a reconcile or acknowledge an incident.',
          enforce: 'Reverse a delivered add-on with a compensation or a write-off. This affects money.',
          moderate: 'Approve a blocked device reduction: the customer’s extra devices get unbound.',
        },
        danger: {
          enforce: 'Reverses an add-on the customer paid for, with a compensation or a write-off: it moves money.',
        },
      },
      auto_renew: {
        name: 'Auto-renewal',
        description:
          'Automatic renewal: charging saved payment methods and warning customers before their subscription ends.',
        actions: {
          view: 'See the last cycle’s result and the schedule.',
          run: 'Run a cycle now instead of waiting for the schedule: charge subscriptions about to end and mark expired ones.',
        },
      },
      payments: {
        name: 'Payments',
        description: 'Customers’ transactions and refunds.',
        actions: {
          view: 'The transaction list, reconciliation with the providers, and payment notifications for admins.',
          create: 'Create an unpaid payment draft for a customer. The panel has no button for it yet; it only matters for direct API requests.',
          edit: 'End a customer’s autopay: “Users” → customer → “Subscriptions” tab → “Autopay” → “Cancel autopay” (Platega, RollyPay) and “Turn off YooKassa autopay”. No money is returned, the paid term is unchanged, and the customer is not told.',
          delete: 'Has no effect yet: nothing in the panel checks this permission.',
          export: 'Has no effect yet: nothing in the panel checks this permission.',
          refund: 'Refund a payment through the provider, in full or in part. And record a refund made at the provider outside the panel (“Record refund”): the panel sends nothing to the provider and undoes on its side what the payment gave.',
        },
        danger: {
          refund: 'Sends real money back to the customer; a refund cannot be undone.',
        },
      },
      payment_gateways: {
        name: 'Payment gateways',
        description:
          'The payment providers customers pay through: their keys, currency and the order customers see them in.',
        actions: {
          view: 'See the gateways and their settings, with secret keys masked.',
          view_secrets:
            'See the stored keys in full. Not needed to set a gateway up: a new key can be pasted in without it.',
          edit: 'Switch gateways on and off, change their keys, currency and order, create the default gateways.',
        },
        danger: {
          view_secrets: 'Whoever holds a gateway’s keys can act as your shop at that provider.',
          edit: 'Replacing a gateway’s keys can send customers’ payments to someone else’s account.',
        },
      },
      payment_webhooks: {
        name: 'Payment webhooks',
        description: 'The notifications payment providers send about every payment.',
        actions: {
          view: 'The list of received notifications and how they were processed.',
          resolve:
            'Open a notification in full, including the provider’s raw data, to investigate a failure. Opening the raw data is logged.',
          run: 'Process a notification again, for example when a payment was not credited.',
        },
      },
      support_tickets: {
        name: 'Support tickets',
        description: 'Conversations with customers and site visitors in support.',
        actions: {
          view: 'The queue, conversations, attachments and notifications about new tickets. Closed ones also need “Archive”.',
          create: 'Start a conversation with a customer yourself.',
          edit: 'Reply, attach files, ask for documents, reopen a closed ticket (together with “Archive”).',
          delete: 'Delete a ticket’s files, keeping the conversation itself.',
          resolve: 'Close a ticket; stop a visitor’s device from opening new anonymous conversations.',
          archive: 'Read closed (archived) conversations and their attachments. They often hold personal data.',
        },
      },
      faq: {
        name: 'FAQ',
        description: 'The frequently asked questions customers see.',
        actions: {
          view: 'Every question, hidden ones too.',
          create: 'Add a question.',
          edit: 'Change a question, upload pictures and videos for it.',
          delete: 'Delete a question together with its files.',
        },
      },
      user_hints: {
        name: 'Customer hints',
        description:
          'Pop-up hints customers see in the cabinet: in the browser, the installed app or the Telegram mini app.',
        actions: {
          view: 'See the hints.',
          create: 'Create a hint.',
          edit: 'Change a hint.',
          delete: 'Delete a hint together with the record of who was shown it.',
        },
      },
      promocodes: {
        name: 'Promo codes',
        description: 'Promo codes and who redeemed them.',
        actions: {
          view: 'The codes and their redemptions.',
          create: 'Create a promo code.',
          edit: 'Change a promo code, generate a code.',
          delete: 'Switch a promo code off and move it to the archive.',
        },
      },
      broadcasts: {
        name: 'Broadcasts',
        description:
          'Messages to all or some customers: in the bot and the cabinet, and, if you choose, by email or in a channel.',
        actions: {
          view: 'Drafts, past broadcasts and the audience size.',
          create: 'Create a draft.',
          edit: 'Edit a draft and upload media, cancel a broadcast in progress, correct messages already sent.',
          delete: 'Delete a broadcast, and wipe already sent messages from Telegram within 48 hours.',
          run: 'Send a broadcast now or at a set time, send a test, retry the failed messages.',
        },
      },
      referrals: {
        name: 'Referrals',
        description: 'The referral programme: who invited whom, invites and rewards.',
        actions: {
          view: 'Invites, referral links and rewards, and the programme’s analytics.',
          edit: 'Create and revoke invites, grant, issue and revoke rewards, attach a referrer by hand.',
        },
      },
      referral_settings: {
        name: 'Referral settings',
        description: 'The invite limits of the referral programme.',
        actions: {
          view: 'See the current invite limits.',
          edit: 'Has no effect yet: the referral programme’s settings are changed with “Settings: Edit”.',
        },
      },
      partners: {
        name: 'Partners',
        description: 'The partner programme: partners, their earnings, balances and payouts.',
        actions: {
          view: 'Partners, their earnings, referrals and withdrawal history, the analytics and CSV exports.',
          edit: 'Make a customer a partner, switch a partner on or off, adjust the balance and rates, attach a referral.',
          bulk_operations: 'Has no effect yet: approving withdrawals in bulk needs “Withdrawals: Resolve”.',
        },
        danger: {
          view: 'The withdrawal list and its CSV export carry every partner’s payout details: cards and wallets.',
          edit: 'Can credit any amount to a partner’s balance, and that balance can be withdrawn or spent.',
        },
      },
      partner_settings: {
        name: 'Partner settings',
        description: 'Reserved for the partner programme’s settings, which today live under “Settings”.',
        actions: {
          view: 'Has no effect yet: the partner programme’s settings open with “Settings: View”.',
          edit: 'Has no effect yet: they are changed with “Settings: Edit”.',
        },
      },
      withdrawals: {
        name: 'Withdrawals',
        description: 'Partners’ requests to withdraw their earnings.',
        actions: {
          view: 'Notifications about new requests and the “Withdrawals” item in quick search. The request list itself opens with “Partners: View”.',
          resolve:
            'Approve a request, marking it paid, or reject it and return the amount to the partner’s balance. The money itself is sent outside the panel.',
        },
        danger: {
          resolve: 'An approval is the record real money is paid out against; a rejection puts the amount back on a balance that can be withdrawn again.',
        },
      },
      quests: {
        name: 'Quests',
        description: 'Tasks customers complete for rewards.',
        actions: {
          view: 'The quest list.',
          create: 'Create a quest.',
          edit: 'Change quests, their order and icons.',
          delete: 'Delete a quest.',
        },
      },
      wheel: {
        name: 'Wheel of fortune and contests',
        description: 'The wheel of fortune, contests, their prizes and the key pools prizes come from.',
        actions: {
          view: 'The wheel, contests, prizes and how many keys are left; the keys themselves are masked.',
          edit: 'The wheel’s sectors, odds and settings; create, publish, cancel and draw contests; load keys into pools.',
          resolve: 'Hand a prize to its winner, or refuse it with a reason.',
          view_secrets: 'See prize keys in full. Every reveal is logged.',
        },
        danger: {
          view_secrets: 'Whoever reads an unclaimed key can redeem it before the winner does.',
        },
      },
      advertising: {
        name: 'Advertising',
        description: 'Ad campaigns and placements, their results, and partners’ ad requests.',
        actions: {
          view: 'Campaigns, placements and their numbers, requests, exchange rates. The list of customers a placement brought also needs “Users: View”.',
          create: 'Create a campaign or a placement.',
          edit: 'Change a campaign or a placement, set an exchange rate.',
          delete: 'Delete a placement.',
          moderate: 'Approve a partner’s ad request, counter it with your own terms, or reject it.',
        },
      },
      bot_config: {
        name: 'Bot config',
        description: 'The Telegram bot: menu, texts, emoji, banners, screens and the bot map.',
        actions: {
          view: 'See the bot’s settings, screens and map.',
          edit: 'Change the menu, texts, emoji and banners; edit and publish screens; import emoji packs.',
        },
      },
      notifications: {
        name: 'Customer notifications',
        description:
          'The messages the service sends customers on its own, such as expiry reminders, and the log of what was sent.',
        actions: {
          view: 'The templates and the log of sent notifications.',
          edit: 'Create, change and delete templates, restore the standard text.',
        },
      },
      subpage_config: {
        name: 'Subscription page',
        description:
          'The subscription page and the connect screen in the cabinet: their look, the apps and the setup instructions.',
        actions: {
          view: 'See their settings.',
          edit: 'Change and save them, switch the connect screen on and off.',
        },
      },
      landing_config: {
        name: 'Web landing',
        description: 'The website page visitors see before they sign in.',
        actions: {
          view: 'The draft, the published version and the history.',
          edit: 'Save the draft, publish it, roll back to an earlier version.',
        },
      },
      branding: {
        name: 'Branding',
        description:
          'Reserved for your service’s logo, name and colours, which today are changed under “Settings”.',
        actions: {
          view: 'Has no effect yet: branding opens with “Settings: View”.',
          edit: 'Has no effect yet: branding is changed with “Settings: Edit”.',
        },
      },
      appearance: {
        name: 'Appearance',
        description:
          'Reserved for the panel’s look. Each admin sets their own theme, and needs no permission for it.',
        actions: {
          view: 'Has no effect yet: nothing in the panel checks this permission.',
          edit: 'Has no effect yet: nothing in the panel checks this permission.',
        },
      },
      remnawave: {
        name: 'Remnawave',
        description: 'The Remnawave VPN panel: servers (nodes), hosts, squads and customers’ connections.',
        actions: {
          view: 'Panel and node status, statistics, squads, devices and live connections.',
          edit: 'Enable, disable and restart nodes, reset their traffic, reorder hosts, drop connections.',
        },
        danger: {
          edit: 'Disabling a node cuts off every customer connected through it.',
        },
      },
      imports: {
        name: 'Imports',
        description:
          'Moving customers and subscriptions over from Remnawave and from other panels and bots: 3x-ui, Remnashop, Altshop, Stealthnet, Bedolaga.',
        actions: {
          view: 'The import history and a preview of the source’s plans.',
          create: 'Has no effect yet: left over from an older version; importing needs “Import”.',
          import: 'Start an import from Remnawave, 3x-ui, Remnashop, Altshop, Stealthnet or Bedolaga.',
          run: 'Sync with Remnawave, give imported customers a plan, cancel or roll back an import (a rollback removes the imported customers), copy the source’s plans.',
        },
        danger: {
          run: 'Rolling an import back deletes every customer it brought in, all at once.',
        },
      },
      automations: {
        name: 'Automations',
        description:
          '“Event → action” rules that run on their own: a Telegram message, a hint, a request to another system, blocking a customer or an address.',
        actions: {
          view: 'The rules, the event catalogue and the run log.',
          create:
            'Create a rule. A rule that blocks an address, blocks a customer or sends event data out also needs “Blocked IPs: Create”, “Users: Edit” or “Outgoing webhooks: Create”.',
          edit: 'Change a rule, switch it on or off. Changing or switching on a rule with such an action needs that permission too; switching one off never does.',
          delete: 'Delete a rule together with its run log.',
          run: 'Run a rule by hand. Its blocking and sending actions need their own permissions here as well.',
        },
      },
      webhooks: {
        name: 'Outgoing webhooks',
        description: 'Sending events about customers, subscriptions and payments to your own systems.',
        actions: {
          view: 'The event subscriptions and the delivery history, with the data that was sent.',
          create: 'Add an address to send events to. The signing secret is shown once.',
          edit: 'Change the address and events, issue a new secret, send a test, deliver again.',
          delete: 'Delete a subscription together with its delivery history.',
        },
        danger: {
          create: 'Events about customers and payments start going to the address given.',
          edit: 'Changing the address can send this data to someone else’s system.',
        },
      },
      email: {
        name: 'Email (SMTP)',
        description:
          'The mail server the service writes to customers through: confirmation codes, notifications, broadcasts, support replies.',
        actions: {
          view: 'See the settings; the password stays hidden.',
          edit: 'Change the server and password, check the connection, send a test email.',
        },
        danger: {
          edit: 'Every email to customers goes through this server, confirmation codes included: whoever runs it can read them.',
        },
      },
      api_tokens: {
        name: 'API tokens',
        description: 'Keys for programs that work with the panel: the cabinet, the bot, monitoring.',
        actions: {
          view: 'The token list, without the tokens themselves.',
          create: 'Create a token; its value is shown once.',
          delete: 'Revoke a token: the program using it stops working at once.',
        },
        danger: {
          create: 'A token opens the panel’s service API, the one the cabinet and the bot use, with no role limits.',
          delete: 'Revoking the token the cabinet or the bot uses stops them.',
        },
      },
      admins: {
        name: 'Administrators',
        description: 'Panel accounts, and the list of IP addresses the panel may be opened from.',
        actions: {
          view: 'The admin list and the allowed IP addresses.',
          create: 'Create an admin account, with a role no broader than your own.',
          edit: 'Change other admins’ passwords, roles and status; add and change allowed IP addresses.',
          delete: 'Delete admin accounts and allowed IP addresses.',
        },
        danger: {
          create: 'Gives a person their own way into the panel.',
          edit: 'Lets its holder change someone else’s password, or allow the panel only from listed addresses and lock everyone else out.',
          delete: 'A deleted admin loses access; removing an allowed address can lock out whoever signs in from it.',
        },
      },
      rbac_roles: {
        name: 'Roles and permissions',
        description: 'This page: the roles and what each one allows.',
        actions: {
          view: 'See the roles and their permissions.',
          create: 'Create new roles, only from permissions you hold yourself.',
          edit: 'Change roles’ names, descriptions and permissions; sync the system roles.',
          delete: 'Delete non-system roles that nobody holds.',
        },
        danger: {
          create: 'A new role can pass everything you can do on to other admins.',
          edit: 'Changes access for everyone with the role at once; removing a permission signs them all out.',
        },
      },
      auth_providers: {
        name: 'Authentication methods',
        description: 'How admins sign in to the panel: through Telegram, GitHub, Yandex and other services.',
        actions: {
          view: 'See how each method is set up, without its secrets.',
          edit: 'Switch methods on and off, change their keys and the list of who may sign in with them.',
        },
        danger: {
          edit: 'A wrong setting can let a stranger into the panel or close this way in.',
        },
      },
      external_auth: {
        name: 'External auth',
        description:
          'How customers sign in to the web cabinet: through Telegram, Google, Yandex and Mail.ru, and the rules for disposable email addresses.',
        actions: {
          view: 'See the settings.',
          edit: 'Change keys, switch sign-in methods on and off, set the email rules.',
        },
        danger: {
          edit: 'A wrong key or a switched-off method, and customers cannot sign in to the cabinet.',
        },
      },
      blocked_ips: {
        name: 'Blocked IPs',
        description: 'Addresses the panel refuses everything from, even the sign-in page.',
        actions: {
          view: 'See the list.',
          create: 'Block an address or a range; change the reason or expiry of a block.',
          delete: 'Lift a block.',
        },
        danger: {
          create: 'Can cut other admins, or the cabinet’s server, off from the panel. Blocking your own address is refused.',
        },
      },
      audit: {
        name: 'Audit log',
        description: 'Which admin did what in the panel, and when.',
        actions: {
          view: 'Read the log.',
          export: 'Download the log as a file.',
        },
      },
      settings: {
        name: 'Settings',
        description:
          'Service-wide settings: access for customers, currency, branding, points, the referral and partner programmes, anti-fraud, legal documents, AI support.',
        actions: {
          view: 'See these settings. Secrets are never shown.',
          edit: 'Change them; also use the AI chat and set up AI support.',
        },
        danger: {
          edit: 'Can close sign-ups or purchases for every customer at once.',
        },
      },
      backups: {
        name: 'Backups',
        description: 'Database backups: the schedule, delivery to Telegram, restoring.',
        actions: {
          view: 'The backup list and the schedule settings.',
          create: 'Take a backup now; change the schedule and the Telegram chat backups are sent to.',
          delete: 'Delete a backup together with its file.',
          run: 'Restore the database from a backup: a stored one or an uploaded file.',
          export: 'Download a backup file.',
        },
        danger: {
          create: 'The same permission sets the chat backups go to, so the whole database can be sent to someone’s own Telegram.',
          delete: 'A deleted backup is gone: you can no longer restore from it.',
          run: 'Restoring replaces the whole database with the copy: everything since it was taken is lost.',
          export: 'A backup is the whole database: customers, payments, admin password hashes and the mail password in plain text.',
        },
      },
      config_portability: {
        name: 'Config portability',
        description: 'Saving the panel’s settings to a file and loading them back, for example when moving to a new server.',
        actions: {
          view: 'See which parts can be transferred.',
          export: 'Download the file: roles, automations, webhooks, notification templates, settings, blocked IPs, the panel’s IP allowlist, FAQ, legal documents. Settings secrets are left out.',
          import: 'Load such a file; it overwrites those parts, and each part also needs the permission of its own section. Roles in it cannot grant more than you hold.',
        },
        danger: {
          export: 'The file holds the roles and the panel’s access lists, and with “Outgoing webhooks: Edit” also the webhook secrets.',
          import: 'Overwrites roles, settings, blocked IPs and the panel’s IP allowlist in one go, and can lock you and others out.',
        },
      },
      system_logs: {
        name: 'System logs',
        description: 'The server’s technical log, for tracking down errors.',
        actions: {
          view: 'Read the log and see how detailed it is.',
          edit: 'Change how detailed the log is, without a restart.',
          delete: 'Clear the log.',
        },
      },
    },
    toasts: {
      roleUpdated: 'Role saved',
      updateFailed: 'Could not save the role: {{message}}',
      roleDeleted: 'Role deleted',
      deleteFailed: 'Could not delete the role: {{message}}',
      roleCreated: 'Role created',
      createFailed: 'Could not create the role: {{message}}',
    },
    // The server's own refusals on this page, in words. `role-errors.ts`
    // recognises the sentences; anything else goes through `translate-error`.
    errors: {
      missingPermission: 'Your role does not include “{{permission}}”.',
      cannotGrant: 'You cannot grant permissions you do not hold yourself: {{permissions}}.',
      nameTaken: 'A role with the identifier “{{name}}” already exists.',
      nameReserved: 'The identifier “{{name}}” belongs to a system role. Choose another one.',
      notFound: 'The role no longer exists; someone may have deleted it.',
      systemUndeletable: 'A system role cannot be deleted.',
      assigned: 'The role is assigned to admins. Give them another role first.',
      namePattern:
        'The identifier may use only lowercase Latin letters, digits and “_”, and must start with a letter.',
      unknownPermission:
        'The panel no longer has the permission {{permission}}. Remove it with “Remove them” above the permissions, then save.',
      duplicatePermission: 'The permission “{{permission}}” is listed twice.',
      tooShort_one: '{{field}} must be at least {{count}} character long.',
      tooShort_other: '{{field}} must be at least {{count}} characters long.',
      tooLong_one: '{{field}} can be at most {{count}} character long.',
      tooLong_other: '{{field}} can be at most {{count}} characters long.',
      // The request fields a length refusal can name, in the form's own words.
      fields: {
        name: 'Identifier',
        displayName: 'Name',
        description: 'Description',
      },
    },
    createDialog: {
      title: 'New role',
      dialogDescription: 'Choose an identifier and the name admins will see, then tick what the role may do.',
      stableName: 'Identifier',
      stableNamePlaceholder: 'ops_lead',
      stableNameHint:
        'Lowercase Latin letters, digits and “_”, starting with a letter; 2 to 32 characters. Cannot be changed later.',
      stableNameInvalid: 'Start with a letter and use only lowercase Latin letters, digits and “_”.',
      stableNameReserved: 'This identifier belongs to a system role.',
      displayName: 'Name',
      displayNamePlaceholder: 'Operations lead',
      description: 'Description',
      descriptionPlaceholder: 'What this role is for',
      cancel: 'Cancel',
      create: 'Create role',
      createTip: 'Creates the role with the ticked permissions. Then assign it to an admin on the Administrators tab.',
      createNeedsIdentifier: 'Enter a valid identifier first.',
    },
  },
} as const

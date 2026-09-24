/**
 * "Bot map" feature bundle (EN). Lazy-loaded via withFeatureBundle('botMap').
 * Wave 2 of the bot-studio-redesign spec — list view + inspectors.
 */
export const en = {
  botMapPage: {
    title: 'Bot map',
    subtitle:
      'Every bot screen and message in one list — see where each button leads, edit RU/EN copy in place.',
    refresh: 'Refresh',
    loadFailed: 'Failed to load the map',
    banner: {
      label: 'Banner',
      none: 'No banner set',
      pick: 'Pick from library',
      upload: 'Upload',
      uploaded: 'Banner uploaded',
      uploadFailed: 'Banner upload failed',
      tooLarge: 'File too large (max 8 MB)',
      clear: 'Remove banner',
      deleteFromLibrary: 'Delete from library',
      hint: 'When unset, the bot uses the global banner. PNG/JPEG/WEBP/GIF, up to 8 MB.',
    },
    tabs: {
      list: 'List',
      diagram: 'Diagram',
    },
    diagram: {
      placeholderTitle: 'Diagram — coming in the next wave',
      placeholderBody:
        'The visual canvas with nodes and edges ships in Wave 3. For now, every change goes through the list on the left — same data, just a different presentation.',
    },
    rail: {
      searchPlaceholder: 'Search a screen, button, notification type…',
      empty: 'No matches',
      total: 'Nodes: {{count}}',
      groups: {
        graph: 'Graph screens',
        reply: 'Main menu',
        'notification:expires': 'Notifications — Expiry',
        'notification:referral': 'Notifications — Referrals',
        'notification:partner': 'Notifications — Partners',
        'notification:promocode': 'Notifications — Promo codes',
        'notification:system': 'Notifications — System',
        'notification:other': 'Notifications — Other',
        terminal: 'Mini App pages',
        // Screens the bot builds itself, with no block on the canvas (`SYSTEM_SCREENS`).
        system: 'Built-in bot screens',
      },
    },
    badges: {
      root: 'Start',
      published: 'Published',
      draft: 'Draft',
      active: 'Active',
      disabled: 'Disabled',
      buttons: '{{count}} buttons',
      noButtons: 'No buttons',
    },
    destination: {
      screen: '→ screen {{name}}',
      webApp: '→ Mini App {{route}}',
      url: '→ URL {{host}}',
      chat: '→ Support chat',
      chatOrScreen: '→ Support chat, or without a public @username the screen {{name}}',
      callback: '→ Callback {{id}}',
      back: '→ Back to menu',
      mainMenu: '→ Main menu',
      invalid: '✕ Target unset',
      unsafeUrl: '✕ Unsafe URL',
      // The same answers «Diagram» writes under a main-menu button with the same route.
      site: '→ Cabinet website {{path}}',
      unanswered: '✕ The bot does not know this button — it answers «Menu updated» and shows the main menu',
      missingScreen: '✕ No such screen — the bot answers «Menu updated» and shows the main menu',
      missingPage: '✕ The Mini App has no such page',
    },
    // «Схема»: something typed in the inspector is not saved yet, or its save
    // is still on its way (`pending-edits.ts`).
    unsavedGuard: {
      title: 'Edits are not saved yet',
      description:
        'The screen editor holds something unsaved: a link, a caption or a text still being saved, or a link the bot cannot open — the reason is under its field. Stay to check it.',
      stay: 'Stay',
      leave: 'Leave anyway',
    },
    inspector: {
      empty: 'Pick a node on the left to open its editor.',
      saved: 'Saved',
      saveFailed: 'Save failed',
      restore: 'Restore default',
      restored: 'Template restored to the shipped default',
      restoreFailed: 'Could not restore the template',
      restoreConfirm: 'Replace this template with the shipped default? Your edits to it will be lost.',
      enFallback: 'When EN is empty, the bot delivers the RU copy.',
      emojiAria: 'Insert emoji',
    },
    graphScreen: {
      title: 'Bot graph screen',
      shortIdLabel: 'Screen identifier',
      isRoot: 'Start screen',
      textRu: 'Text (RU)',
      textEn: 'Text (EN)',
      placeholderRu: 'What the user sees on this screen…',
      placeholderEn: 'Same screen for English-speaking users…',
      buttonCountLabel: 'Buttons on this screen',
      banner: 'Screen banner',
      bannerHint: "A custom banner image for this screen — shown instead of the bot's default banner. Clear it to leave the screen with no banner (or the global bot banner when 'One banner for all screens' is on). Changes apply after you publish the flow.",
      tooltipFullEditor:
        "Edit this screen's buttons, banner and actions on the Diagram tab.",
    },
    replyKeyboard: {
      title: 'Main menu',
      subtitle:
        'The buttons under the bot’s greeting (/start and «◀️ Back to menu»). Each button leads somewhere — a bot screen, the cabinet, or a chat.',
      buttonId: 'Button id',
      label: 'Label',
      action: 'Action',
      target: 'Target',
      visible: 'Visible',
      empty: 'No buttons yet — add them on the Diagram tab.',
      saveLabel: 'Save label',
    },
    notification: {
      title: 'Notification template',
      typeLabel: 'Event type',
      isActive: 'Template is active',
      titleRu: 'Title (RU)',
      titleEn: 'Title (EN)',
      bodyRu: 'Body (RU)',
      bodyEn: 'Body (EN)',
      placeholderTitleRu: 'Subject for Russian-speaking users',
      placeholderTitleEn: 'English subject line',
      placeholderBodyRu:
        'Notification body. Supports placeholders like {{name}}, {{plan}}, {{expiresAt}}.',
      placeholderBodyEn: 'Same body for English-speaking users.',
      buttonsTitle: 'Notification buttons',
      buttonsHint:
        'Buttons attach to the Telegram message. webApp targets deep-link the user into a cabinet route.',
      addButton: 'Add button',
      removeButton: 'Remove',
      kind: 'Kind',
      kindOptions: {
        webApp: 'Mini App',
        url: 'URL',
        callback: 'Callback',
      },
      style: 'Button style',
      styleOptions: {
        default: 'Default',
        primary: 'Primary (blue)',
        success: 'Success (green)',
        danger: 'Danger (red)',
      },
      row: 'Row',
      rowHint: 'Buttons that share a row number render side-by-side.',
      labelRu: 'Label (RU)',
      labelEn: 'Label (EN)',
      targetWebApp: 'Mini App route (e.g. /renew)',
      screen: 'Mini App screen',
      targetUrl: 'Absolute HTTPS URL',
      targetCallback: 'callback_data (e.g. menu:main)',
      callbackHint:
        'The bot answers: menu:main or menu — the main menu; screen:<shortId> or a screen’s shortId itself — that screen (a screen of your own opens more reliably with screen:<shortId>); invite, rules, help — their screens; back_to_menu — the main menu; close — deletes the message; check_channel or check_channel:q:<id> — the channel subscription check, as «I subscribed»; quest_channel:<id> — the «Subscribe to channel» quest check; lang:<code>, such as lang:ru — switches the language; ai_support_exit — leaves AI support. With any other value the button does nothing.',
      defaultTargetHint:
        'With no buttons, the system still deep-links into the most relevant cabinet section — see the diagram.',
      lifetimeTopUpHint:
        'A subscription that never expires has nothing to renew, so the bot turns this notification’s buttons that open «Subscription renewal» (/renew) into «📦 Buy more traffic» → «Add-ons» (/addons) for that subscription. The push and the cabinet bell lead there too. The diagram draws it as its own arrow.',
      save: 'Save template',
    },
    terminal: {
      title: 'Mini App page',
      subtitle:
        'Read-only node: a cabinet route. Notification and graph buttons deep-link here. The page itself lives in the cabinet (reiwa) codebase.',
      route: 'Route',
      description: 'Description',
    },
  },
  // The words of `botFlow` that only «Карта бота» shows — its built-in screens,
  // system buttons, the texts it lists per screen, the main menu's routes and
  // additions. They load with this bundle, not before first paint; the rest of
  // `botFlow` stays in the core dictionary. `addResourceBundle` merges deep, so
  // the keys keep their paths (`botFlow.systemScreens.*` …) and no caller changes.
  botFlow: {
    screenTexts: {
      title: 'Bot texts for this screen',
      hint: 'The real copy the bot shows on this screen (title, description, stats, button labels). Applies immediately — reiwa picks it up on the next refresh.',
      ru: 'RU',
      en: 'EN',
      enToggle: 'English version',
      placeholder: 'Text…',
      save: 'Save',
      saved: 'Text saved',
      saveFailed: 'Failed to save text',
      captions: {
        shareButton: 'The «Share» button in the bot',
        sharePrompt: '«Share» from the bot — the text under the bot link (Telegram puts the link there itself)',
        shareWebLine: '«Share» from the bot — the website line; {{token}} is where the link goes, keep it',
        inlineMessage: '«Share» from the Mini App — the message (the bot adds the link under it)',
        inlineTitle: '«Share» from the Mini App — the title the sender picks',
        inlineDescription: '«Share» from the Mini App — the line under the title',
        inlineOpen: '«Share» from the Mini App — the button under the message',
        inlineMessagePlain: 'The same when the sender has no referral link — the message',
        inlineTitlePlain: 'The same without a referral link — the title',
        inlineDescriptionPlain: 'The same without a referral link — the line under the title',
        inlineStart: 'The same without a referral link — the button offering to start the bot',
        // When the bot shows a text that is not simply part of this screen
        // (reiwa `invite.ts`, `help-callback.ts`, `help.ts`).
        hubTitle: 'Title — only when there is no «invite» screen: while there is one, the bot shows the screen’s text',
        hubDescription: 'Description — likewise only without an «invite» screen',
        hubLinkLabel:
          'The line above the link — for partners; for everybody else only without an «invite» screen (otherwise the placeholder in the screen’s text places the link)',
        hubWebLinkLabel: 'The line above the website link — wherever the line above the link is shown',
        partnerTitle: 'For a partner — the title instead of this screen’s text',
        partnerDescription: 'For a partner — the description instead of this screen’s text',
        referralDisabled: 'Instead of the screen, when the referral program is off (a partner still gets the screen)',
        referralInvitedOnly:
          'Instead of the screen, when the program is for invited users only and this person came without an invitation',
        referralLinkUnavailable:
          'Instead of the screen, when there is no link: the panel gave no code (no answer, invitations used up) or there is neither a bot username nor a cabinet address',
        supportTitle: 'The /help command’s text — the «Help» button shows this screen’s text',
        supportNotConfigured: 'The /help command when no support @username is set',
        helpContactSupport: 'The «write to support» line when support is set as a numeric id instead of an @username',
        rulesIntro:
          'The rules text when there is a link to them — only when there is no «rules» screen: while there is one, the bot shows that screen’s text',
        rulesUnavailable: 'The rules text when there is no link to them — likewise only without a «rules» screen',
        welcomeMessage: 'The greeting — when the start screen has no text (otherwise the bot shows the start screen’s text)',
        chooseAction: 'Instead of the greeting when it is empty (hidden), and the answer to the old «Back to menu» button',
        subscriptionLine: 'The subscription lines under the greeting — for subscribers (except in the minimal format)',
        menuUpdated:
          'An old button pressed — the pop-up over the main menu the bot draws in place of that message',
      },
    },
    systemButtons: {
      title: 'System buttons',
      description:
        'These buttons are appended automatically by the bot — their action depends on user data (referral link, support handle) and is fixed. A button the bot does not always show says under it when it does. You can edit their label (RU/EN) and, where the bot reads one, give them a premium emoji (icon). To add your own buttons, use «Add button» below.',
      back: '◀️ Back to menu',
      labelRu: 'Label (RU)',
      labelEn: 'Label (EN)',
      invite: {
        share: '📤 Share on Telegram',
        copy: '📋 Copy link',
        copyWeb: '🌐 Copy the website link',
        openCabinet: '👤 Open in cabinet',
        openExchange: '💱 Exchange points',
        partnerCabinet: '🤝 Partner cabinet',
      },
      rules: {
        open: '📜 Open rules',
      },
      help: {
        contact: '🆘 Message support',
        openApp: '🆘 Support in the app',
      },
      // When the bot shows a button it does not always show (the conditions in
      // reiwa `src/bot/pages/*.ts`, see `computeSystemButtons`).
      conditions: {
        webLink: 'When the cabinet has an https address and the bot has a username',
        referralCabinet: 'Everybody but partners — when the cabinet has an https address',
        partnerCabinet: 'Partners only — when the cabinet has an https address',
        exchange: 'When the cabinet has an https address; for a partner, only while they still have points',
        rulesOpen: 'When a document is on in «Legal documents» or a rules link is set',
        helpOpenApp: 'When the Mini App has an https address',
        helpContact: 'When a support @username is set (not a numeric id)',
        autoBack: 'Only while the screen has no buttons of its own',
        trial: 'For somebody with no active subscription, when a free trial is open to them',
        trialPaid: 'The same, when the trial is paid; the bot fills in the price',
        channelJoin: 'When «Channel link» or the channel’s username is set',
        paymentReturnOpen:
          'Opens the Mini App; without its https address, the payment page on the cabinet website; without either there is no button',
        passwordReset: 'Only together with an issued link',
        aiExit: 'Under every AI support answer and its errors',
      },
      // Main-menu buttons missing from the button list: the bot adds them itself.
      mainMenu: {
        trial: '🆓 Try for free',
        trialPaid: '🆓 Try for {{price}}',
      },
    },
    // Where the bot sends a tap on a main-menu button — the line under it on the canvas.
    replyTargets: {
      screen: 'screen {{name}}',
      support: 'support chat',
      supportOrScreen: 'support chat, or without a public @username the screen {{name}}',
      cabinetBrowser: 'cabinet in the browser',
      miniApp: 'Mini App {{path}}',
      site: 'cabinet website {{path}}',
      url: '{{host}}',
      unhandled: 'the bot does not know this button — it answers «Menu updated» and shows the main menu',
      mainMenu: 'main menu',
      missingScreen: 'no screen {{shortId}} — the bot answers «Menu updated» and shows the main menu',
      missingPage: 'the Mini App has no page {{path}}',
      unsafeUrl: 'the bot leaves this button out: Telegram refuses {{host}}',
    },
    mainMenu: {
      title: 'What the bot adds to the menu itself',
      hint: 'These buttons and texts are not in the button list above — the bot builds them itself, but their captions and texts can be changed here. The trial button’s icon is the TRIAL slot (or GIFT, PROMO) on the «Emoji packs» page, «Emoji slots» tab.',
      textsTitle: 'Texts around the greeting',
    },
    // Screens the bot builds itself that have no block on the canvas
    // (`SYSTEM_SCREENS` in `features/bot-flow/system-screens.ts`).
    systemScreens: {
      badge: 'Built-in screen',
      hint: 'The bot builds this screen itself — it has no block on the canvas. Its button captions and texts are changed here, as in «Texts».',
      textsCount: 'Texts: {{count}}',
      buttons: {
        channelJoin: '📢 Open channel',
        channelCheck: '✅ I subscribed',
        langRu: '🇷🇺 Russian',
        langEn: '🇬🇧 English',
        paymentReturnOpen: '📱 Open app',
        passwordReset: '🔑 Set a new password',
        aiExit: '❌ Exit support',
      },
      channelGate: {
        title: 'Channel required',
        trigger: 'The bot answers somebody not in the channel with this while «Channel Required» is on',
      },
      questChannel: {
        title: 'Quest «Join the channel»',
        trigger: 'The cabinet sends people here from the quest’s button. The button captions are shared with «Channel required»',
      },
      lang: {
        title: 'Language',
        trigger: 'The /lang command',
      },
      paymentReturn: {
        title: 'Back from a payment',
        trigger: 'Somebody who paid from the Mini App comes back here from the payment page',
      },
      passwordReset: {
        title: 'Password reset',
        trigger: 'Cabinet: «Forgot password?» → get the link in Telegram',
      },
      paysupport: {
        title: 'Payment question',
        trigger: 'The /paysupport command — Telegram requires it of a bot that takes payments',
      },
      error: {
        title: 'Error message',
        trigger: 'When the bot failed to handle a message or a tap',
      },
      aiSupport: {
        title: 'AI support',
        trigger: 'The /support command',
      },
      commands: {
        title: 'Command list',
        trigger: 'The commands Telegram lists for «/» and in the bot’s menu, with their descriptions',
      },
      staleButton: {
        title: 'An old button',
        trigger:
          'A button on an old message that the bot no longer has was pressed: it was removed or changed, or the screen it led to was deleted. The bot shows the «Menu updated» pop-up and draws the main menu in place of that message. The bot does not retarget old buttons, and does not rewrite messages nobody touched',
      },
      serviceReplies: {
        title: 'Short answers',
        trigger: 'The bot’s answers without buttons: closed sign-up, Telegram linking, Stars payments',
      },
      captions: {
        channelRequired: 'The request to subscribe — instead of an answer, to somebody not subscribed',
        channelNotSubscribed: 'On «I subscribed» without a subscription: a pop-up and a message',
        channelVerified: 'The pop-up once the subscription is confirmed; the greeting follows',
        questPrompt: 'The request to join the quest’s channel',
        questVerified: 'Pop-up: subscription confirmed, the reward is claimed in the cabinet',
        questNotSubscribed: 'Pop-up when there is no subscription',
        questRetry: 'Pop-up or message when the check failed',
        questLinkFirst: 'When this Telegram is not linked to a cabinet account',
        langChoose: 'The question above the language buttons',
        langChanged: 'The answer after the choice, in the new language; the bot fills in the language’s name',
        langName: 'The language’s name in that answer',
        passwordResetLink: 'The link was issued; the bot fills in the login',
        passwordResetNoAccount: 'This Telegram has no cabinet login',
        passwordResetRecentlySent: 'A link went out less than a minute ago',
        passwordResetHourlyLimit: 'Five links in the last hour — no more',
        passwordResetUnavailable: 'No link could be issued',
        paysupportBody: 'The text when a support @username is set',
        paysupportUnavailable: 'The text when it is not',
        paysupportPrefill: 'The ready first message in the support chat',
        aiIntro: 'The answer to /support when AI support is on',
        aiUnavailable: 'When AI support is off or not set up',
        aiExited: 'After leaving AI support',
        aiRateLimited: 'Too many messages in a row',
        aiFailed: 'The AI gave no answer',
        accessRestricted: '/start when the service is closed to everybody (access mode)',
        accessRegBlocked: '/start by a newcomer while sign-up is closed',
        accessInvitedNoCode: '/start by a newcomer without an invitation while it is invitation-only',
        telegramLink: 'Linking Telegram by the cabinet’s link — the answer',
        starsReceived: 'Telegram Stars payment — the message after paying',
        starsRefused: 'Telegram Stars payment — why the payment form refused',
        commandDescription: 'The command’s description in the «/» list',
        menuUpdated: 'The pop-up over the main menu',
      },
    },
  },
  // Why a button's target is not saved — the reasons only a notification's or
  // a screen's button can have. They join the main menu's six in the core
  // dictionary (`botConfigPage.buttons.fields.actionTarget.problems`); the server
  // refuses the same (`buttonTargetProblem`).
  botConfigPage: {
    buttons: {
      fields: {
        actionTarget: {
          problems: {
            linkNeedsHttps: 'The bot opens this link over https:// only',
            pageOnly:
              'This takes a cabinet page such as /renew: the bot would open an address as a page the cabinet does not have',
            addressOnly: 'This takes a whole address starting with https://; a cabinet page opens from a "Mini App" button',
          },
        },
      },
    },
  },
} as const

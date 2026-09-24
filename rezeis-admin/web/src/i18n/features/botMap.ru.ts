/**
 * "Карта бота" feature bundle (RU). Lazy-loaded via withFeatureBundle('botMap').
 * Wave 2 of the bot-studio-redesign spec — list view + inspectors.
 */
export const ru = {
  botMapPage: {
    title: 'Карта бота',
    subtitle:
      'Все экраны и сообщения бота в одном списке. Видно, куда ведут кнопки, и можно править тексты RU/EN сразу.',
    refresh: 'Обновить',
    loadFailed: 'Не удалось загрузить карту',
    banner: {
      label: 'Баннер',
      none: 'Баннер не задан',
      pick: 'Выбрать из библиотеки',
      upload: 'Загрузить',
      uploaded: 'Баннер загружен',
      uploadFailed: 'Не удалось загрузить баннер',
      tooLarge: 'Файл слишком большой (максимум 8 МБ)',
      clear: 'Убрать баннер',
      deleteFromLibrary: 'Удалить из библиотеки',
      hint: 'Если баннер не задан — используется общий баннер бота. PNG/JPEG/WEBP/GIF, до 8 МБ.',
    },
    tabs: {
      list: 'Список',
      diagram: 'Схема',
    },
    diagram: {
      placeholderTitle: 'Схема — в следующей волне',
      placeholderBody:
        'Холст с узлами и рёбрами появится в Wave 3. Сейчас все правки делаются из списка слева, изменения те же — отображение разное.',
    },
    rail: {
      searchPlaceholder: 'Поиск экрана, кнопки, типа уведомления…',
      empty: 'Ничего не найдено',
      total: 'Узлов: {{count}}',
      groups: {
        graph: 'Граф-экраны',
        reply: 'Главное меню',
        'notification:expires': 'Уведомления — Истечение',
        'notification:referral': 'Уведомления — Рефералы',
        'notification:partner': 'Уведомления — Партнёры',
        'notification:promocode': 'Уведомления — Промокоды',
        'notification:system': 'Уведомления — Системные',
        'notification:other': 'Уведомления — Прочее',
        terminal: 'Mini App-страницы',
        // Экраны, которые бот строит сам, без блока в схеме (`SYSTEM_SCREENS`).
        system: 'Встроенные экраны бота',
      },
    },
    badges: {
      root: 'Старт',
      published: 'Опубликовано',
      draft: 'Черновик',
      active: 'Активно',
      disabled: 'Выключено',
      buttons: 'Кнопок: {{count}}',
      noButtons: 'Без кнопок',
    },
    destination: {
      screen: '→ экран {{name}}',
      webApp: '→ Mini App {{route}}',
      url: '→ URL {{host}}',
      chat: '→ Чат поддержки',
      chatOrScreen: '→ Чат поддержки, а без публичного @username — экран {{name}}',
      callback: '→ Колбэк {{id}}',
      back: '→ Назад в меню',
      mainMenu: '→ Главное меню',
      invalid: '✕ Цель не задана',
      unsafeUrl: '✕ Небезопасный URL',
      // Те же ответы, что «Схема» пишет под кнопкой главного меню с тем же маршрутом.
      site: '→ Сайт кабинета {{path}}',
      unanswered: '✕ Бот не отвечает на эту кнопку',
      missingScreen: '✕ Такого экрана нет — бот ответит «экран не найден»',
      missingPage: '✕ В мини-приложении нет такой страницы',
    },
    // «Схема»: something typed in the inspector is not saved yet, or its save
    // is still on its way (`pending-edits.ts`).
    unsavedGuard: {
      title: 'Правки ещё не сохранены',
      description:
        'В редакторе экрана есть несохранённое: ссылка, подпись или текст ещё сохраняются, или ссылку бот не откроет — почему, сказано под полем. Останьтесь, чтобы проверить.',
      stay: 'Остаться',
      leave: 'Всё равно уйти',
    },
    inspector: {
      empty: 'Выберите узел слева, чтобы открыть редактор.',
      saved: 'Сохранено',
      saveFailed: 'Не удалось сохранить',
      restore: 'Вернуть по умолчанию',
      restored: 'Шаблон возвращён к поставляемому виду',
      restoreFailed: 'Не удалось вернуть шаблон',
      restoreConfirm: 'Заменить шаблон поставляемым по умолчанию? Ваши правки в нём пропадут.',
      enFallback: 'Если EN-перевод пуст, бот покажет RU-копию.',
      emojiAria: 'Вставить эмодзи',
    },
    graphScreen: {
      title: 'Граф-экран бота',
      shortIdLabel: 'Идентификатор экрана',
      isRoot: 'Стартовый экран',
      textRu: 'Текст (RU)',
      textEn: 'Текст (EN)',
      placeholderRu: 'Что показать пользователю на этом экране…',
      placeholderEn: 'Same screen for English-speaking users…',
      buttonCountLabel: 'Кнопок на экране',
      banner: 'Баннер экрана',
      bannerHint: 'Своя картинка-баннер для этого экрана. Показывается вместо стандартного баннера бота. Если убрать — экран без баннера (или общий баннер бота, если включён тумблер «Один баннер для всех экранов»). Изменения применятся после публикации Flow.',
      tooltipFullEditor:
        'Кнопки, баннер и действия экрана редактируются на вкладке «Схема».',
    },
    replyKeyboard: {
      title: 'Главное меню',
      subtitle:
        'Кнопки под приветствием бота (/start и «◀️ В меню»). Каждая кнопка ведёт куда-то в боте, в кабинет или в чат.',
      buttonId: 'ID кнопки',
      label: 'Подпись',
      action: 'Действие',
      target: 'Цель',
      visible: 'Видна',
      empty: 'Кнопок ещё нет — добавьте их на вкладке «Схема».',
      saveLabel: 'Сохранить подпись',
    },
    notification: {
      title: 'Шаблон уведомления',
      typeLabel: 'Тип события',
      isActive: 'Активный шаблон',
      titleRu: 'Заголовок (RU)',
      titleEn: 'Заголовок (EN)',
      bodyRu: 'Тело (RU)',
      bodyEn: 'Тело (EN)',
      placeholderTitleRu: 'Заголовок уведомления для русского пользователя',
      placeholderTitleEn: 'English subject line',
      placeholderBodyRu:
        'Текст уведомления. Поддерживаются плейсхолдеры вида {{name}}, {{plan}}, {{expiresAt}}.',
      placeholderBodyEn: 'Same body for English-speaking users.',
      buttonsTitle: 'Кнопки уведомления',
      buttonsHint:
        'Кнопки прикрепляются к Telegram-сообщению. webApp-цель ведёт в кабинет на конкретный путь.',
      addButton: 'Добавить кнопку',
      removeButton: 'Удалить',
      kind: 'Тип',
      kindOptions: {
        webApp: 'Mini App',
        url: 'URL',
        callback: 'Callback',
      },
      style: 'Стиль кнопки',
      styleOptions: {
        default: 'Обычная',
        primary: 'Основная (синяя)',
        success: 'Успех (зелёная)',
        danger: 'Опасность (красная)',
      },
      row: 'Ряд',
      rowHint: 'Кнопки с одинаковым номером ряда встанут в одну строку.',
      labelRu: 'Подпись (RU)',
      labelEn: 'Подпись (EN)',
      targetWebApp: 'Маршрут Mini App (например, /renew)',
      screen: 'Экран мини-приложения',
      targetUrl: 'Абсолютный HTTPS URL',
      targetCallback: 'callback_data (например, menu:main)',
      callbackHint:
        'Бот отвечает на: menu:main или menu — главное меню; screen:<shortId> или сам shortId экрана — этот экран (свой экран надёжнее открывать через screen:<shortId>); invite, rules, help — их экраны; back_to_menu — главное меню; close — удаляет сообщение; check_channel или check_channel:q:<id> — проверка подписки на канал, как «Я подписался»; quest_channel:<id> — проверка задания «Подписка на канал»; lang:<код>, например lang:ru, — смена языка; ai_support_exit — выход из ИИ-поддержки. На другое значение кнопка ничего не сделает.',
      defaultTargetHint:
        'Без кнопок системa автоматически ведёт пользователя в раздел кабинета — можно увидеть на схеме.',
      save: 'Сохранить шаблон',
    },
    terminal: {
      title: 'Mini App-страница',
      subtitle:
        'Read-only узел: страница в кабинете. Сюда ведут кнопки уведомлений и графа. Контент страницы редактируется в коде кабинета (reiwa).',
      route: 'Маршрут',
      description: 'Описание',
    },
  },
  // The words of `botFlow` that only «Карта бота» shows — its built-in screens,
  // system buttons, the texts it lists per screen, the main menu's routes and
  // additions. They load with this bundle, not before first paint; the rest of
  // `botFlow` stays in the core dictionary. `addResourceBundle` merges deep, so
  // the keys keep their paths (`botFlow.systemScreens.*` …) and no caller changes.
  botFlow: {
    screenTexts: {
      title: 'Тексты бота для этого экрана',
      hint: 'Реальные тексты, которые бот показывает на этом экране (заголовок, описание, статистика, подписи кнопок). Меняются сразу — reiwa подхватит на ближайшем refresh.',
      ru: 'RU',
      en: 'EN',
      enToggle: 'Английская версия',
      placeholder: 'Текст…',
      save: 'Сохранить',
      saved: 'Текст сохранён',
      saveFailed: 'Не удалось сохранить текст',
      // Подписи над ключами, которые ищут по тому, что получает человек:
      // два сообщения «Поделиться» (`KEY_CAPTIONS` в SystemScreenTexts.tsx).
      captions: {
        shareButton: 'Кнопка «Поделиться» в боте',
        sharePrompt: '«Поделиться» из бота — текст под ссылкой на бота (ссылку Telegram ставит сам)',
        shareWebLine: '«Поделиться» из бота — строка со ссылкой на сайт; {{token}} — место для ссылки, не удаляйте',
        inlineMessage: '«Поделиться» из мини-приложения — текст сообщения (ссылку бот добавит под ним)',
        inlineTitle: '«Поделиться» из мини-приложения — заголовок, который выбирает отправитель',
        inlineDescription: '«Поделиться» из мини-приложения — подпись под заголовком',
        inlineOpen: '«Поделиться» из мини-приложения — кнопка под сообщением',
        inlineMessagePlain: 'То же, когда у отправителя нет реферальной ссылки — текст сообщения',
        inlineTitlePlain: 'То же без реферальной ссылки — заголовок',
        inlineDescriptionPlain: 'То же без реферальной ссылки — подпись',
        inlineStart: 'То же без реферальной ссылки — кнопка, которая предлагает запустить бота',
        // Когда бот показывает текст, который не просто часть экрана
        // (reiwa `invite.ts`, `help-callback.ts`, `help.ts`).
        hubTitle: 'Заголовок — только если экрана «invite» нет: пока он есть, бот берёт текст экрана',
        hubDescription: 'Описание — тоже только без экрана «invite»',
        hubLinkLabel:
          'Подпись над ссылкой — у партнёров; у остальных только без экрана «invite» (иначе ссылку ставит плейсхолдер в тексте экрана)',
        hubWebLinkLabel: 'Подпись над ссылкой на сайт — там же, где подпись над ссылкой',
        partnerTitle: 'Партнёру — заголовок вместо текста этого экрана',
        partnerDescription: 'Партнёру — описание вместо текста этого экрана',
        referralDisabled: 'Вместо экрана, если реферальная программа выключена (партнёру экран показывается всё равно)',
        referralInvitedOnly:
          'Вместо экрана, если программа только для приглашённых, а человек пришёл без приглашения',
        referralLinkUnavailable:
          'Вместо экрана, если ссылки нет: панель не выдала код (не ответила, кончились приглашения) или у бота нет username, а у кабинета — адреса',
        supportTitle: 'Текст команды /help — кнопка «Помощь» показывает текст этого экрана',
        supportNotConfigured: 'Команда /help, когда @username поддержки не задан',
        helpContactSupport: 'Строка «напишите в поддержку», когда вместо @username задан числовой id',
        rulesIntro:
          'Текст правил, когда есть ссылка на них, — только если экрана «rules» нет: пока он есть, бот берёт текст этого экрана',
        rulesUnavailable: 'Текст правил, когда ссылки на них нет, — тоже только без экрана «rules»',
        welcomeMessage: 'Приветствие — если у стартового экрана нет текста (иначе бот берёт текст стартового экрана)',
        chooseAction: 'Вместо приветствия, если оно пустое (скрыто), и ответ на старую кнопку «В меню»',
        subscriptionLine: 'Строки о подписке под приветствием — у кого есть подписка (кроме формата minimal)',
      },
    },
    systemButtons: {
      title: 'Системные кнопки',
      description:
        'Эти кнопки бот добавляет автоматически — их действие зависит от данных пользователя (реферальная ссылка, support-handle) и фиксировано. Если кнопка есть не всегда, под ней написано, когда бот её показывает. Подпись (RU/EN) можно отредактировать, а там, где бот это читает, — задать премиум-эмодзи (иконку). Чтобы добавить свои кнопки — используйте «Добавить кнопку» ниже.',
      back: '◀️ В меню',
      labelRu: 'Подпись (RU)',
      labelEn: 'Подпись (EN)',
      invite: {
        share: '📤 Поделиться в Telegram',
        copy: '📋 Скопировать ссылку',
        copyWeb: '🌐 Скопировать ссылку на сайт',
        openCabinet: '👤 Профиль в кабинете',
        openExchange: '💱 Обменять баллы',
        partnerCabinet: '🤝 Партнёрский кабинет',
      },
      rules: {
        open: '📜 Открыть правила',
      },
      help: {
        contact: '🆘 Написать в поддержку',
        openApp: '🆘 Поддержка в приложении',
      },
      // Когда бот показывает кнопку, которая есть не всегда (условия в
      // reiwa `src/bot/pages/*.ts`, см. `computeSystemButtons`).
      conditions: {
        webLink: 'Если у кабинета есть адрес https и у бота есть username',
        referralCabinet: 'Всем, кроме партнёров, — если у кабинета есть адрес https',
        partnerCabinet: 'Только партнёрам — если у кабинета есть адрес https',
        exchange: 'Если у кабинета есть адрес https; партнёру — пока у него остались баллы',
        rulesOpen: 'Если на странице «Документы» включён документ или задана ссылка на правила',
        helpOpenApp: 'Если у мини-приложения есть адрес https',
        helpContact: 'Если задан @username поддержки (не числовой id)',
        autoBack: 'Пока у экрана нет своих кнопок',
        trial: 'Тем, у кого нет активной подписки, если им доступен бесплатный пробный период',
        trialPaid: 'Тем же, если пробный период платный; цену бот подставит сам',
        channelJoin: 'Если задана «Ссылка на канал» или username канала',
        paymentReturnOpen:
          'Открывает мини-приложение; без его адреса https — страницу оплаты на сайте кабинета; без обоих кнопки нет',
        passwordReset: 'Только вместе с выданной ссылкой',
        aiExit: 'Под каждым ответом ИИ-поддержки и под её ошибками',
      },
      // Кнопки главного меню, которых нет в списке кнопок: бот добавляет их сам.
      mainMenu: {
        trial: '🆓 Попробовать бесплатно',
        trialPaid: '🆓 Попробовать за {{price}}',
      },
    },
    // Куда бот ведёт нажатие на кнопку главного меню — строка под кнопкой на схеме.
    replyTargets: {
      screen: 'экран {{name}}',
      support: 'чат поддержки',
      supportOrScreen: 'чат поддержки, а без публичного @username — экран {{name}}',
      cabinetBrowser: 'кабинет в браузере',
      miniApp: 'мини-приложение {{path}}',
      site: 'сайт кабинета {{path}}',
      url: '{{host}}',
      unhandled: 'бот не отвечает на эту кнопку',
      mainMenu: 'главное меню',
      missingScreen: 'нет экрана {{shortId}} — бот ответит «экран не найден»',
      missingPage: 'в мини-приложении нет страницы {{path}}',
      unsafeUrl: 'бот не покажет эту кнопку: Telegram не примет {{host}}',
    },
    mainMenu: {
      title: 'Что бот добавляет в меню сам',
      hint: 'Этих кнопок и текстов нет в списке кнопок выше — бот строит их сам, но подписи и тексты можно поменять здесь. Иконка кнопки пробного периода — слот TRIAL (или GIFT, PROMO) на странице «Эмодзи-паки», вкладка «Слоты эмодзи».',
      textsTitle: 'Тексты вокруг приветствия',
    },
    // Экраны, которые бот строит сам и у которых нет блока в схеме
    // (`SYSTEM_SCREENS` в `features/bot-flow/system-screens.ts`).
    systemScreens: {
      badge: 'Встроенный экран',
      hint: 'Этот экран бот строит сам — блока в схеме у него нет. Подписи кнопок и тексты меняются здесь, как в «Тексты».',
      textsCount: 'Текстов: {{count}}',
      buttons: {
        channelJoin: '📢 Перейти в канал',
        channelCheck: '✅ Я подписался',
        langRu: '🇷🇺 Русский',
        langEn: '🇬🇧 English',
        paymentReturnOpen: '📱 Открыть приложение',
        passwordReset: '🔑 Задать новый пароль',
        aiExit: '❌ Выйти из поддержки',
      },
      channelGate: {
        title: 'Канал обязателен',
        trigger: 'Бот отвечает этим тому, кто не подписан на канал, пока включено «Канал обязателен»',
      },
      questChannel: {
        title: 'Задание «Подписка на канал»',
        trigger: 'Кабинет присылает сюда по кнопке задания. Подписи кнопок — общие с «Канал обязателен»',
      },
      lang: {
        title: 'Выбор языка',
        trigger: 'Команда /lang',
      },
      paymentReturn: {
        title: 'Возврат после оплаты',
        trigger: 'Сюда возвращается со страницы оплаты тот, кто платил из мини-приложения',
      },
      passwordReset: {
        title: 'Сброс пароля',
        trigger: 'Кабинет: «Забыли пароль?» → получить ссылку в Telegram',
      },
      paysupport: {
        title: 'Вопрос по оплате',
        trigger: 'Команда /paysupport — её Telegram требует от бота, который принимает оплату',
      },
      error: {
        title: 'Сообщение об ошибке',
        trigger: 'Когда бот не смог обработать сообщение или нажатие',
      },
      aiSupport: {
        title: 'ИИ-поддержка',
        trigger: 'Команда /support',
      },
      commands: {
        title: 'Список команд',
        trigger: 'Команды, которые Telegram показывает по «/» и в меню бота, с подписями',
      },
      screenNotFound: {
        title: 'Экран не найден',
        trigger: 'Кнопка вела на экран, которого больше нет в опубликованной схеме',
      },
      serviceReplies: {
        title: 'Короткие ответы',
        trigger: 'Ответы бота без кнопок: закрытый вход, привязка Telegram, оплата звёздами',
      },
      captions: {
        channelRequired: 'Просьба подписаться — вместо ответа тому, кто не подписан',
        channelNotSubscribed: 'На «Я подписался», если подписки нет: всплывающее окно и сообщение',
        channelVerified: 'Всплывающее окно, когда подписка подтверждена; затем — приветствие',
        questPrompt: 'Просьба подписаться на канал задания',
        questVerified: 'Всплывающее окно: подписка подтверждена, награду забирают в кабинете',
        questNotSubscribed: 'Всплывающее окно, если подписки нет',
        questRetry: 'Всплывающее окно или сообщение, если проверить не удалось',
        questLinkFirst: 'Если этот Telegram не привязан к аккаунту в кабинете',
        langChoose: 'Вопрос над кнопками языков',
        langChanged: 'Ответ после выбора, уже на новом языке; название языка бот подставит сам',
        langName: 'Название языка в этом ответе',
        passwordResetLink: 'Ссылка выдана; логин бот подставит сам',
        passwordResetNoAccount: 'У этого Telegram нет логина от кабинета',
        passwordResetRecentlySent: 'Ссылку отправили меньше минуты назад',
        passwordResetHourlyLimit: 'За час отправлено пять ссылок — больше нельзя',
        passwordResetUnavailable: 'Ссылку выдать не удалось',
        paysupportBody: 'Текст, если @username поддержки задан',
        paysupportUnavailable: 'Текст, если он не задан',
        paysupportPrefill: 'Готовое первое сообщение в чате поддержки',
        aiIntro: 'Ответ на /support, когда ИИ-поддержка включена',
        aiUnavailable: 'Когда ИИ-поддержка выключена или не настроена',
        aiExited: 'После выхода из ИИ-поддержки',
        aiRateLimited: 'Слишком много сообщений подряд',
        aiFailed: 'ИИ не ответил',
        accessRestricted: '/start, когда сервис закрыт для всех (режим доступа)',
        accessRegBlocked: '/start нового человека, пока регистрация закрыта',
        accessInvitedNoCode: '/start нового человека без приглашения, пока вход только по приглашениям',
        telegramLink: 'Привязка Telegram по ссылке из кабинета — ответ',
        starsReceived: 'Оплата звёздами Telegram — сообщение после оплаты',
        starsRefused: 'Оплата звёздами Telegram — почему форма оплаты отказала',
        commandDescription: 'Подпись команды в списке по «/»',
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
            linkNeedsHttps: 'Эту ссылку бот откроет только по https://',
            pageOnly:
              'Здесь нужна страница кабинета, например /renew: адрес бот откроет как страницу, которой в кабинете нет',
            addressOnly: 'Здесь нужен полный адрес с https://, а страницу кабинета открывает кнопка «Mini App»',
          },
        },
      },
    },
  },
} as const

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
      callback: '→ Колбэк {{id}}',
      back: '→ Назад в меню',
      invalid: '✕ Цель не задана',
      unsafeUrl: '✕ Небезопасный URL',
    },
    inspector: {
      empty: 'Выберите узел слева, чтобы открыть редактор.',
      saved: 'Сохранено',
      saveFailed: 'Не удалось сохранить',
      enFallback: 'Если EN-перевод пуст, бот покажет RU-копию.',
      emojiAria: 'Вставить эмодзи',
      openOldEditor: 'Открыть старый редактор графа',
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
      tooltipFullEditor:
        'Редактор кнопок и медиа экрана живёт в старом конструкторе — откройте его для расширенных правок.',
    },
    replyKeyboard: {
      title: 'Главное меню (reply-клавиатура)',
      subtitle:
        'Кнопки этого набора видны пользователю поверх клавиатуры Telegram. Каждая кнопка ведёт куда-то в боте, в кабинет, или в чат.',
      buttonId: 'ID кнопки',
      label: 'Подпись',
      action: 'Действие',
      target: 'Цель',
      visible: 'Видна',
      empty: 'Кнопок ещё нет — добавьте их в старом конструкторе.',
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
      labelRu: 'Подпись (RU)',
      labelEn: 'Подпись (EN)',
      targetWebApp: 'Маршрут Mini App (например, /renew)',
      targetUrl: 'Абсолютный HTTPS URL',
      targetCallback: 'callback_data (например, menu:main)',
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
} as const

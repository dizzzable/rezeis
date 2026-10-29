/**
 * «Конкурсы» feature bundle (RU), lazy-loaded via withFeatureBundle('contests').
 *
 * What the page learned on 29.10.2026 — audience, channel, tickets, the
 * announcement, the participants, a draw that failed. Deep-merged into
 * `contestsPage` from the core dictionary, whose older keys stay where the
 * quick search reads them.
 */
export const ru = {
  contestsPage: {
    form: {
      descriptionRu: 'Описание (RU)',
      descriptionEn: 'Описание (EN)',
      descriptionHint: 'Правила и условия. Переносы строк сохраняются.',
      prizeTitleEn: 'Название приза (EN)',
      lockedLive:
        'Конкурс уже идёт: люди участвовали на этих условиях. Можно поправить название и описание и перенести окончание на более позднее время.',
      endAtExtend: 'Конец и розыгрыш — только позже',
      audience: 'Кто может участвовать',
      audienceHint: 'Ничего не отмечено — все, кроме заблокированных. Отмеченное внутри одной строки — «или», строки между собой — «и».',
      subscription: 'Подписка',
      sub: {
        ACTIVE: 'Активная',
        EXPIRED: 'Истёкшая',
        TRIAL: 'Триал',
        LIMITED: 'Ограниченная',
        NONE: 'Нет подписки',
      },
      plan: 'Тариф',
      planEmpty: 'В каталоге пока нет тарифов',
      platform: 'Платформа',
      platforms: {
        telegram: 'Telegram',
        miniapp: 'Mini App',
        web: 'Веб',
      },
      contact: 'Есть контакт',
      contacts: {
        hasTelegram: 'Telegram',
        hasEmail: 'Email',
        hasWebPush: 'Web-push',
      },
      inactiveDays: 'Не заходил ≥ дней',
      inactiveDaysPlaceholder: 'напр. 30',
      channel: 'Подписка на канал',
      channelHint:
        'Если указать канал, перед заявкой кабинет спросит у Telegram, подписан ли человек. Бот должен быть администратором канала. Аккаунту без Telegram участвовать нельзя. Проверка — один раз, при заявке.',
      channelLink: 'Ссылка на канал',
      channelLinkPlaceholder: 'https://t.me/…',
      channelId: 'ID канала',
      channelIdPlaceholder: '-100… — нужен для закрытого канала',
      tickets: 'Дополнительные шансы',
      ticketsHint:
        'За участие — один билет. Здесь можно дать ещё: за каждую оплату и за каждого приглашённого друга, который оплатил подписку, — в период конкурса. Чем больше билетов, тем выше шанс, но одно место на человека. Возврат оплаты до розыгрыша забирает её билеты. 0 — выключено.',
      ticketsPerPurchase: 'За каждую оплату',
      ticketsPerReferral: 'За каждого оплатившего друга',
      maxTicketsPerUser: 'Потолок билетов на человека',
      maxTicketsPlaceholder: 'без потолка',
      announce: 'Сообщить о конкурсе',
      announceHint:
        'Когда конкурс начнётся, бот и кабинет сообщат о нём всем, кто может участвовать, — несколько сотен сообщений в минуту. Текст — в «Шаблонах уведомлений», «Новый конкурс». Итоги участникам приходят всегда.',
    },
    row: {
      drawError: 'Розыгрыш не прошёл: {{error}}',
      drawErrorHint: 'Повторяется каждую минуту, пока не пройдёт.',
      channel: 'Канал',
      tickets: 'Билеты',
      announceSending: 'Анонс рассылается',
      announceSent: 'Анонс отправлен',
      resultsSending: 'Итоги рассылаются',
      resultsSent: 'Итоги разосланы',
    },
    actionsExtra: {
      entrants: 'Участники',
    },
    cancelDialog: {
      title: 'Отменить конкурс?',
      description:
        'Розыгрыша не будет, призы никто не получит, вернуть конкурс нельзя. Заявки останутся в истории. Участникам ничего не приходит — в кабинете конкурс будет помечен «Отменён».',
      confirm: 'Отменить конкурс',
    },
    entrants: {
      title: 'Участники: {{count}}',
      empty: 'Пока никто не участвует.',
      tickets_one: '{{count}} билет',
      tickets_few: '{{count}} билета',
      tickets_many: '{{count}} билетов',
      tickets_other: '{{count}} билета',
      liveHint: 'До розыгрыша билеты считаются по оплатам и друзьям на эту минуту; окончательно — при розыгрыше.',
      more: 'Показать ещё',
      noName: 'Без имени',
    },
    draw: {
      tickets: 'Билетов в розыгрыше: {{count}}',
      seed: 'Ключ жребия',
      seedHint:
        'Создан при публикации. До розыгрыша кабинет показывал только его SHA-256 — по нему любой может убедиться, что ключ не меняли.',
    },
  },
};

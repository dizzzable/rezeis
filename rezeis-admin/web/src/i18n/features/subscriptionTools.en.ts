/**
 * Lazy-loaded i18n feature bundle (en): subscriptionTools
 *
 * Contains namespaces: subscriptionTools, duplicateMerge.
 *
 * Everything behind the «Инструменты» button of the Subscriptions page: the
 * sheet, its five tabs, and the two dialogs they open. `duplicateMerge` is the
 * first of those tabs and keeps its own namespace, because its keys predate the
 * sheet and are read by its own tests.
 *
 * The five tab titles are NAMED BY SERVER MESSAGES (the Russian ones, as
 * «Подписки» → «Инструменты» → «…»). Change one here and the sentence the
 * server writes points at a tab that no longer exists — keep the Russian file's
 * titles byte-identical to what the server says.
 *
 * NO `{{count}}` ANYWHERE, deliberately. `count` is i18next's plural trigger,
 * and `platformSettings` already carries the shape this project must not
 * repeat: a bare key used as the English singular next to `_other`, which
 * renders correctly today only because i18next still falls back to the bare
 * key, and breaks the day `compatibilityJSON` is pinned to v4. Every number
 * here is interpolated under its own name (`total`, `selected`, `pairs`), so no
 * plural machinery engages in either language and the two dictionaries carry
 * exactly the same leaves.
 */

export const en = {
  subscriptionTools: {
    button: 'Tools',
    sheet: {
      title: 'Subscription tools',
      description:
        'Checks and repairs that concern many subscriptions at once. Each tab asks for its own permission, so you see only the ones you may use.',
    },
    tabs: {
      merge: 'Duplicate subscription merge',
      squads: 'Subscriptions on squads the panel does not serve',
      unlinked: 'Subscriptions without a Remnawave link',
      extraProfiles: 'Extra profiles in Remnawave',
      lifetime: 'Lifetime subscriptions with a date',
    },

    common: {
      loadFailedTitle: 'The list did not load',
      loadFailedBody:
        'Nothing is shown rather than an empty list: an empty list here would read as "nothing is wrong".',
      openCustomer: 'Open the customer card',
      customerUnnamed: 'no name',
      noTelegram: 'no Telegram',
      planMissing: 'no plan',
      fieldMissing: '—',
      truncated: 'Showing the first {{shown}} of {{total}}.',
      actionColumn: 'Action',
    },

    // The automatic check that replaced «Починка привязки к панели». It runs by
    // itself, so there is no button — only when it ran, how it went, and when
    // it runs next.
    check: {
      neverRan: 'The automatic check has not finished a run yet.',
      lastRun: 'Last run of the automatic check: {{when}}, {{trigger}}.',
      triggers: {
        boot: 'when the panel started',
        import: 'after a backup import',
        retry: 'the retry an hour after an incomplete run',
        daily: 'the daily run',
        unknown: 'reason not reported',
      },
      outcomes: {
        complete: 'Result: everything was checked.',
        incomplete: 'Result: not everything was checked — the rest is retried in an hour.',
        unknown: 'Result: not reported.',
      },
      nextRun: 'Next run: {{when}}.',
      nextRunUnknown: 'The next run is not scheduled.',
      running: 'running now',
      howItRuns:
        'It runs by itself: when the panel starts, after every backup import, once a day, and an hour later for whatever it could not finish.',
    },

    // «Привязать профиль»: this sheet's own dialog. The user card has one too;
    // this one is not shared with it on purpose — it lives inside a component
    // another surface owns.
    linkDialog: {
      action: 'Link profile',
      title: 'Link a Remnawave profile',
      description:
        'The subscription gets the Remnawave profile with this id. The panel reads the profile first and refuses one that another customer’s reiwa_id line names.',
      subscription: 'Subscription: {{subscription}}',
      pickSubscription: 'Which subscription gets the profile',
      pickSubscriptionHint: 'The customer has several subscriptions without a link — choose one.',
      subscriptionOption: '{{plan}} · {{status}} · created {{created}} · {{id}}',
      idLabel: 'Remnawave profile id',
      idPlaceholder: 'Digits only, e.g. 4471',
      idHint: 'The numeric id Remnawave shows for the profile.',
      idInvalid: 'Enter the numeric Remnawave profile id — digits only.',
      confirm: 'I checked that this is this customer’s profile',
      confirmHint:
        'Only needed when nothing proves it: no reiwa_id line naming this customer, and no matching Telegram id, e-mail or verified web-account e-mail. The link is then recorded in the audit log as confirmed by you without proof. A reiwa_id line naming another customer refuses the link whatever you confirm.',
      submit: 'Link profile',
      linked: 'Remnawave profile linked',
      failedTitle: 'Not linked',
    },

    unlinked: {
      intro:
        'Live subscriptions whose Remnawave link the automatic check could not prove yet: an empty link that still records how to find the profile, or a value that is not a numeric profile id. A subscription the check links leaves this list at once.',
      count: 'Subscriptions without a link: {{total}}.',
      empty: 'There are no subscriptions without a link.',
      table: {
        customer: 'Customer',
        subscription: 'Subscription',
        holds: 'Holds now',
        reason: 'Why it is not linked',
        checkedAt: 'Checked',
      },
      holdsEmpty: 'empty',
      notCheckedYet: 'not yet',
      lookedUpBy: {
        shortUuid: 'the short UUID in its subscription link',
        username: 'the username stored with the subscription',
        unknown: 'its subscription link or its stored username',
      },
      // One sentence per `UnlinkedReasonCode`, facts interpolated.
      reasons: {
        notCheckedYet: 'The check has not looked at this subscription yet — it will on its next run.',
        noRoute:
          'Nothing to look it up by: the subscription link has no short UUID and there is no Remnawave username.',
        notFound: 'Remnawave found no profile by {{lookedUpBy}}.',
        panelUnavailable: 'Remnawave did not answer — the check tries again in an hour.',
        profileUnreadable: 'Profile {{profileId}} was found but could not be read back: it is gone or unreadable.',
        ownedByOther:
          'Profile {{profileId}} belongs to another customer by its reiwa_id line ({{otherUserId}}) — it is not linked to this subscription.',
        noOwnerProof:
          'Nothing proves profile {{profileId}} is this customer’s: its description has no reiwa_id line, or its lines name different customers. If it is theirs, link it with “Link profile” and confirm.',
        markedForOtherSubscription:
          'Profile {{profileId}} was issued to another subscription by its subscription_id line ({{otherSubscriptionId}}) — it is not linked to this one.',
        profileTaken:
          'Profile {{profileId}} is already linked to subscription {{otherSubscriptionId}} of another customer ({{otherUserId}}).',
        duplicatePair:
          'Profile {{profileId}} is already linked to another subscription of the same customer ({{otherSubscriptionId}}): a duplicate pair, merged on the “Duplicate subscription merge” tab.',
        changedDuringCheck: 'The subscription changed while the check ran — the next run looks at it again.',
        panelAgrees:
          'Remnawave answers with the very value this subscription holds — there is nothing to rewrite. If the subscription does not work, link its profile by hand.',
        unknown: 'A reason this build does not know: {{code}}',
      },
      openMerge: 'Open “Duplicate subscription merge”',
    },

    extraProfiles: {
      intro:
        'Remnawave profiles whose reiwa_id line names a customer while none of that customer’s live subscriptions is linked to them. Taken from the last comparison and checked against the database again every time the list opens. Nothing is ever deleted here.',
      comparedAt: 'The comparison last read Remnawave: {{when}}.',
      neverCompared: 'The comparison has not read Remnawave yet.',
      readComplete: 'Remnawave gave the whole list.',
      readPartial: 'Remnawave did not give the whole list — profiles beyond it were not compared.',
      counts:
        'Profiles read: {{read}}. Without an owner line (not compared): {{withoutOwner}}. Linked automatically: {{autoLinked}}.',
      countUnknown: 'not reported',
      empty: 'There are no extra profiles.',
      emptyNeverCompared: 'Nothing to show until the automatic check has compared Remnawave once.',
      truncated: 'The list is cut: customers shown — {{shown}}.',
      customerMissing: 'customer not found in the panel',
      table: {
        profile: 'Profile',
        status: 'Status in Remnawave',
        created: 'Created',
        traffic: 'Traffic used',
        marker: 'subscription_id line',
        autoLink: 'What the automatic link did',
      },
      profileId: 'id {{id}}',
      markerNone: 'none',
      linkedNow: 'linked now',
      linkedByOther: 'linked to subscription {{id}} of another customer',
      namedByDeleted: 'recorded against deleted subscription {{id}}',
      profileStatus: {
        ACTIVE: 'active',
        DISABLED: 'disabled',
        LIMITED: 'limited',
        EXPIRED: 'expired',
      },
      // One sentence per `AutoLinkOutcome`.
      autoLink: {
        linked: 'The check linked it to subscription {{subscriptionId}} ({{when}}).',
        noSubscriptionWithoutLink: 'Not linked: the customer has no live subscription without a link.',
        severalSubscriptions:
          'Not linked: the customer has several subscriptions without a link, so which one is ambiguous.',
        severalProfiles: 'Not linked: the customer has several extra profiles, so which one is ambiguous.',
        subscriptionMarkerMismatch: 'Not linked: the profile’s subscription_id line names another subscription.',
        subscriptionRecordsAnotherProfile:
          'The only subscription without a link records the id of another Remnawave profile — not linked automatically.',
        takenByOtherRow: 'Not linked: a live subscription of another customer is linked to it.',
        namedByDeletedSubscription:
          'The profile is still recorded against deleted subscription {{subscriptionId}} — it is not linked to any other subscription.',
        syncInFlight: 'Not linked: the subscription has a sync job queued or running — the check tries again later.',
        changedDuringCheck: 'Not linked: the subscription or the profile changed while the check ran.',
        panelUnavailable: 'Not attempted: the last read of Remnawave failed.',
        ownerNotInPanel: 'Not linked: the panel has no customer with this reiwa_id.',
        unknown: 'An outcome this build does not know: {{code}}',
      },
      // The owners the panel does not have, listed apart from the customers.
      unknownOwners: {
        title: 'Customers not found in the panel',
        intro:
          'The reiwa_id line of these profiles names a customer this panel does not have: one deleted here (deleting a customer removes their Remnawave profile only when that succeeds), or a customer of another panel that uses the same Remnawave. There is nothing to link them to. Before deleting such a profile in Remnawave, make sure it is not another panel’s.',
        shown: 'Shown: {{shown}} of {{total}} — customers deleted here first.',
        deletedAt: 'customer deleted in the panel {{when}}',
      },
      withoutLinkTitle: 'This customer’s subscriptions without a link',
      withoutLinkNone: 'The customer has no subscription without a link.',
      withoutLinkItem: '{{plan}} · {{status}} · created {{created}} · holds {{holds}} · {{id}}',
      noLinkTarget: 'Nothing to link it to: the customer has no subscription without a link.',
    },

    lifetime: {
      intro:
        'Subscriptions sold without an end that carry an end date now. For such a subscription the panel used to send Remnawave the date “created + 30 days”, then took that date back as its own — and on that day Remnawave switched the customer off. Nothing here happens by itself: only the rows you press it for are changed.',
      preselectNote:
        'Selected in advance are only the rows with the old defect’s fingerprint: the date is the profile’s creation in Remnawave plus 30 days, and no payment for a term came after it.',
      count: 'Found: {{total}}. Selected: {{selected}}.',
      empty: 'There are no lifetime subscriptions with a date.',
      table: {
        customer: 'Customer',
        plan: 'Plan',
        expiresAt: 'Date now',
        status: 'Status',
        evidence: 'Why it is lifetime',
        hints: 'Hints',
      },
      selectRow: 'Select subscription {{id}}',
      notLinked: 'no Remnawave link',
      evidence: {
        snapshot: 'its own plan snapshot says “no end”',
        payment: 'payment {{paymentId}} was for “no end”',
        paymentLine: 'its line in combined renewal {{paymentId}} was for “no end”',
        plan: 'plan {{planId}} sells nothing but “no end”',
        unknown: 'evidence this build does not know: {{kind}}',
      },
      hints: {
        thirtyDaysAfterCreate: 'date = profile created in Remnawave + 30 days',
        datedPaymentAfter: 'a payment for a term came after it — the date may be paid for',
      },
      restoreOne: 'Make lifetime again',
      restoreSelected: 'Make lifetime again ({{selected}})',
      running: 'Restoring…',
      confirm: {
        titleOne: 'Make subscription {{id}} lifetime again?',
        titleMany: 'Make the selected subscriptions lifetime again ({{selected}})?',
        doesTitle: 'What it does:',
        does: {
          endDate: 'removes the end date — the card shows “Expires: Unlimited”;',
          status: 'an expired subscription becomes active again; a disabled or limited one keeps its status;',
          addOns: 'add-ons bought “until the end of the subscription” that ended on the wrong date come back;',
          sync: 'one ordinary sync sends Remnawave the date 31.12.2099 — how Remnawave stores “no end” — and a profile Remnawave switched off on the old date comes back on.',
        },
        doesNotTitle: 'What it does not do:',
        doesNot: {
          message: 'sends the customer no message;',
          money: 'refunds nothing and touches no payment;',
          deleted: 'deleted subscriptions are not listed here and are not restored;',
          limits: 'leaves limits, plan and squads as they are;',
          automatic: 'nothing happens by itself — only the rows you pressed it for.',
        },
        action: 'Make lifetime again',
      },
      results: {
        title: 'Result',
        summary: 'Made lifetime again: {{restored}} of {{sent}}.',
        table: {
          subscription: 'Subscription',
          outcome: 'Outcome',
          details: 'Details',
        },
        outcomes: {
          restored: 'Made lifetime again',
          alreadyLifetime: 'Already lifetime',
          notEligible: 'No grounds',
          refunded: 'Payment refunded or charged back — not restored',
          deleted: 'Deleted',
          notFound: 'Not found',
          failed: 'Error: {{message}}',
          noAnswer:
            'No answer ({{message}}) — pressing it again is safe: a restored subscription answers “Already lifetime”.',
          notSent: 'Not sent — the run stopped at an earlier batch.',
          unknown: 'An outcome this build does not know: {{code}}',
        },
        failedNoMessage: 'no description',
        notNamedInAnswer: 'the answer did not name it',
        previousDate: 'the date was {{date}}',
        statusChanged: 'status {{before}} → {{after}}',
        revivedAddOns: 'add-ons back: {{revived}}',
        syncQueued: 'a sync to Remnawave is queued',
      },
    },
  },

  duplicateMerge: {
    title: 'Duplicate subscription merge',
    hint: 'Two live subscriptions on ONE Remnawave profile. The merge keeps the older row with the customer history, moves everything that referenced the newer one onto it, and retires the newer one. Preview first, write second.',

    limitLabel: 'Pairs per run',
    limitHint: 'Up to {{max}}. Each pair costs the panel two resolves and one profile read.',

    runDryRun: 'Preview the merge',
    running: 'Running…',
    runReal: 'Merge for real',
    dryRunNote:
      'The preview writes nothing. A real run is a separate button behind a confirmation that says how many pairs it will merge.',

    confirmTitle: 'Merge these duplicate pairs for real?',
    confirmBody:
      'For every pair that passes every check, this retires the newer subscription and hands the older one the live panel profile. It is not a preview, and this screen cannot undo it.',
    confirmHistory:
      'It MOVES the customer’s payments, receipt lines, promocode activations, referral point spends and trial claim from the retired row onto the surviving one, and repoints the cabinet at the surviving row. Nothing on the panel is created, changed or deleted.',
    confirmMergeable: 'The last preview found {{pairs}} mergeable pair(s) in this sweep.',
    confirmNoPreview:
      'No preview has been run in this sweep, so how many pairs will be merged is unknown.',
    confirmScope: 'This run merges up to {{limit}} pair(s), starting {{from}}.',
    confirmFromStart: 'from the beginning of the selection',
    confirmFromCursor: 'after subscription {{id}}',
    confirmAction: 'Merge the pairs',

    reportTitle: 'Merge report',
    modeDry: 'Preview — nothing was written',
    modeReal: 'Real run — pairs were merged',
    pagesRun: 'Merge runs in this sweep: {{pages}}',
    metrics: {
      pairsExamined: 'Pairs examined',
      merged: 'Pairs merged',
      wouldMerge: 'Pairs mergeable',
      refused: 'Pairs refused',
    },

    hasMoreTitle: 'The merge did not finish',
    hasMoreBody:
      'This run stopped with pairs still left in the selection. Nothing after subscription {{cursor}} has been looked at yet — the numbers above describe what was examined, not the backlog.',
    hasMoreNoCursorBody:
      'This run hit its own "pairs per run" cap rather than the end of the scan, so there is no cursor to carry on from: it deliberately reports the position it started at, never a position past a pair it never touched. Run it again from the beginning — the pairs merged in this run are no longer live halves, so each run advances.',
    continueDry: 'Continue the merge preview',
    continueReal: 'Continue merging from here',
    finishedTitle: 'The merge reached the end of the selection',
    finishedBody: 'No duplicate pair remains after subscription {{cursor}}.',
    finishedBodyEmpty: 'Nothing matched the selection.',

    mergedTitleDry: 'Would be merged',
    mergedTitleReal: 'Merged',
    emptyMerged: 'No examined pair was mergeable.',
    refusedTitle: 'Refused',
    emptyRefused: 'Every examined pair was mergeable.',
    unknownOutcomeTitle: 'Outcome this build does not recognise',

    table: {
      survivor: 'Survivor — kept',
      duplicate: 'Duplicate — retired',
      customer: 'Customer',
      liveIdentity: 'Live panel identity',
      holder: 'Bound to it now',
      reattached: 'Moved to the survivor',
      reason: 'Reason',
    },
    panelIdInline: 'panel id {{id}}',
    fieldMissing: '—',
    refusalUnnamed: 'Refused without naming a reason',

    holder: {
      survivor: 'The survivor',
      duplicate: 'The duplicate',
      both: 'Both halves — do not delete either',
      unknown: 'not reported',
      survivorNow: 'The survivor, now',
      cameFromDuplicate: 'It came off the duplicate.',
      cameFromSurvivor: 'The survivor already held it before this merge.',
      cameFromBoth: 'Both halves held it before this merge.',
      cameFromUnknown: 'Which half it came off was not reported.',
    },

    reattachedItem: '{{relation}} — {{moved}}',
    reattachedNone: 'Nothing referenced the duplicate.',
    reattachedEmpty: 'Nothing to move: {{relations}}.',
    reattachedUnreported: 'not reported',
    supersededJobs: 'Sync jobs defused on the retired row — {{jobs}}',
    supersededUnreported: 'Sync jobs defused — not reported',

    relations: {
      transactions: 'Payments',
      transactionItems: 'Receipt lines',
      promocodeActivations: 'Promocode activations',
      referralPointsExchanges: 'Referral point spends',
      trialClaim: 'Trial claim',
      currentSubscriptionOf: 'Cabinet “current subscription” pointer',
      syncJobs: 'Sync job history (stays on the retired row)',
    },

    groupHeading: '{{refusal}} — {{rows}} pair(s)',
    retryClass: {
      retryable: 'Try it again',
      blocked: 'Blocked until something else is done',
      never: 'Never merge these',
      unknown: 'Unknown to this build',
    },
    retryNote: {
      retryable:
        'Nothing is wrong with these rows — the world was briefly not cooperating. Running the merge again can succeed.',
      blocked:
        'Running the merge again unchanged returns the same refusal. Do the step below first, then run it again.',
      never:
        'These two rows are not a duplicate pair. Running the merge again will never change that, and merging them by hand would move one customer’s history onto another.',
      unknown:
        'This build does not recognise this refusal, so it cannot say whether running the merge again would help. Read the server’s own reason on each row.',
    },

    refusals: {
      differentCustomers: 'Two different customers',
      differentPanelProfiles: 'Two different panel profiles',
      notOwned: 'The profile belongs to somebody else',
      ownerUnproven: 'Not proven to be this customer’s',
      survivorMissing: 'The survivor row does not exist',
      duplicateMissing: 'The duplicate row does not exist',
      alreadyRetired: 'One half is already deleted',
      neitherHoldsIdentity: 'Neither half is bound to the profile',
      entitlementHistoryOnDuplicate: 'The duplicate carries entitlement history',
      trialClaimOnBoth: 'Both halves hold a trial claim',
      survivorNotOlder: 'The survivor is not the older row',
      sameSubscription: 'The same subscription was named twice',
      survivorUnresolved: 'The panel did not resolve the survivor',
      duplicateUnresolved: 'The panel did not resolve the duplicate',
      profileUnreadable: 'The profile could not be read back',
      syncJobRunning: 'A sync job for the duplicate is running',
      raceLost: 'Something changed under the merge',
    },

    remedy: {
      differentCustomers:
        'Leave them alone. Two rows belonging to two customers are two real subscriptions; if one of them looks wrong, repair that row on the customer’s own page.',
      differentPanelProfiles:
        'Leave them alone. Each row resolves to its own panel profile, so both are real subscriptions and neither is a copy of the other.',
      notOwned:
        'Leave them alone. The panel profile carries another account’s ownership marker, so it is not this customer’s to merge. Check on the panel who that profile belongs to.',
      ownerUnproven:
        'Nothing proves whose the profile is: its description has no line naming the owner, or its lines name different customers. Check it in Remnawave. If it is this customer’s, add the line «reiwa_id: <customer id>» to its description there and preview again, removing any line that names somebody else; if it is not, leave the pair alone.',
      survivorMissing:
        'Nothing to do here — the row named as the survivor is gone. Preview again; the discovery sweep will report the pair as it stands now.',
      duplicateMissing:
        'Nothing to do here — the row named as the duplicate is gone. Preview again; the discovery sweep will report the pair as it stands now.',
      alreadyRetired:
        'Nothing to do here — one half is already deleted, so this is not two live rows. If the surviving row is still bound to nothing, it is listed on the “Subscriptions without a Remnawave link” tab; link it there with “Link profile”.',
      neitherHoldsIdentity:
        'Link one of them first. Neither of these rows is bound to the profile they both resolve to, so there is no live identity for the merge to hand the survivor. Find one of them on the “Subscriptions without a Remnawave link” tab and press “Link profile”, then preview the merge again — a pair can have one live half or two, and either is enough.',
      entitlementHistoryOnDuplicate:
        'This pair has to be resolved by hand. The duplicate carries subscription terms, add-on entitlements or an effective projection, and there is no order in which those can be re-parented safely. Take it to whoever owns the entitlement lifecycle.',
      trialClaimOnBoth:
        'Settle the trial ledger first. Only one subscription may hold a trial claim, so one of these two claims has to be released or consumed by the ledger’s own rules before the merge can move the other.',
      survivorNotOlder:
        'Preview again and let discovery choose. The survivor must be the OLDER row — it is the one carrying the payments and the operator’s plan. If both rows were created at the same instant, nothing in the data says which is which and the pair needs a human decision.',
      sameSubscription:
        'Preview again and let discovery choose. A pair is two different subscriptions; one row cannot be merged into itself.',
      survivorUnresolved:
        'Check that the panel is reachable and answering, then run the merge again. Nothing was changed.',
      duplicateUnresolved:
        'Check that the panel is reachable and answering, then run the merge again. Nothing was changed.',
      profileUnreadable:
        'The profile resolved but could not be read back — the panel is unavailable or answered with something undecodable. Run the merge again once it is healthy.',
      syncJobRunning:
        'Wait for the running sync job to finish, then run the merge again. A claimed job cannot be recalled, so retiring the row underneath it would leave a worker acting on a profile that had just changed hands.',
      raceLost:
        'Run the merge again. Something else wrote to one of these rows while the merge was in flight; the whole transaction was rolled back and nothing was changed.',
    },

    ranDry: 'Preview: {{mergeable}} of {{pairs}} pair(s) mergeable',
    ranReal: 'Merged {{merged}} of {{pairs}} pair(s)',
  },
} as const

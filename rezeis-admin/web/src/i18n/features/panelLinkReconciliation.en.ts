/**
 * Lazy-loaded i18n feature bundle (en): panelLinkReconciliation
 *
 * Contains namespaces: panelLinkReconciliation, duplicateMerge.
 *
 * `duplicateMerge` rides in this bundle rather than in one of its own because
 * both surfaces sit on the SAME page (`/subscriptions`, which loads this
 * feature key) and look at the same rows: the merge discovers its pairs by
 * running the reconciliation sweep. A second lazy bundle would be a second
 * chunk and a second `loadFeatureBundle` call for one card on a screen that
 * has already fetched this one.
 *
 * NO `{{count}}` ANYWHERE, deliberately. `count` is i18next's plural trigger,
 * and `platformSettings` already carries the shape this project must not
 * repeat: a bare key used as the English singular next to `_other`, which
 * renders correctly today only because i18next still falls back to the bare
 * key, and breaks the day `compatibilityJSON` is pinned to v4. Every number
 * here is interpolated under its own name (`rows`, `limit`, `scanned`), so no
 * plural machinery engages in either language and the two dictionaries carry
 * exactly the same leaves.
 */

export const en = {
  panelLinkReconciliation: {
    title: 'Panel link repair',
    hint: 'Bulk repair for subscriptions whose Remnawave profile exists but whose stored panel identity is empty. Preview first, write second.',

    limitLabel: 'Rows per run',
    limitHint: 'Up to {{max}}. Every row costs the panel one resolve and one profile read.',
    chunkLabel: 'Database page size',
    chunkHint: 'Up to {{max}}. Bounds memory, not panel load.',

    runDryRun: 'Run preview',
    running: 'Running…',
    runReal: 'Repair for real',
    dryRunNote:
      'The preview writes nothing. A real run is a separate button behind a confirmation.',

    confirmTitle: 'Write panel links for real?',
    confirmBody:
      'This writes the resolved Remnawave identity onto matching subscriptions and hands each of those customers that panel profile. It is not a preview, and this screen cannot undo it.',
    confirmRepairable: 'The last preview found {{rows}} repairable row(s) in this sweep.',
    confirmNoPreview:
      'No preview has been run in this sweep, so how many rows will be written is unknown.',
    confirmScope: 'This run examines up to {{limit}} row(s), starting {{from}}.',
    confirmFromStart: 'from the beginning of the selection',
    confirmFromCursor: 'after subscription {{id}}',
    confirmAction: 'Write links',

    eraKnown: 'Panel era: {{era}}',
    eraScope3x:
      'Both populations were searched: rows holding no identity at all, and rows holding a dead 2.x uuid. A repair count of zero here means nothing was broken.',
    eraScope2x:
      'Only rows holding no identity at all were searched. On a 2.x panel a uuid-shaped identity is the correct one, so the stale population does not exist here — a repair count of zero does NOT mean stale rows were checked and found clean.',
    eraScopeOther:
      'This build does not recognise that era, so it cannot say which populations the sweep searched. Read the counts below as covering an unknown subset.',
    duplicateDangerTitle: 'Do not clean these duplicates up by hand',
    duplicateDangerBody:
      'A duplicate pair is two live subscriptions on ONE panel profile, and the polarity is backwards from instinct: the older, legitimate-looking row holds a dead identity, and the wrong-looking duplicate is the one bound to the profile the customer is actually using. Deleting either half through the panel destroys a paying customer’s service — read the "Bound to live profile" column before touching anything.',
    duplicateDangerBothLive:
      'One kind of pair is worse still, and the "Resolved by" column is where it shows: where nothing was resolved because both rows ALREADY store the same identity, neither half looks wrong. Both are bound to the same real panel profile, so there is no dead row to delete safely — deleting either one takes a live profile with it. The link repair has nothing to write for these, and running it again will not change them. Only the creation date separates them, and the merge keeps the OLDER row, because that is the row carrying the payments and the customer history.',
    duplicateDangerNext:
      'Run the repair for real first; this sweep only diagnoses pairs. Merging the two subscriptions moves history, payments and referral links and is a separate action that is not part of this repair.',
    eraUnknownTitle: 'Panel era unknown',
    eraUnknownBody:
      'This run could not tell which era of the Remnawave API it was talking to. It therefore cannot say which identity spelling belongs on a row — so a report of zero repairs here means "the panel answered nothing", not "nothing is broken". Fix the panel connection and run the preview again before trusting these numbers.',

    reportTitle: 'Report',
    modeDry: 'Preview — nothing was written',
    modeReal: 'Real run — links were written',
    pagesRun: 'Runs in this sweep: {{pages}}',
    metrics: {
      scanned: 'Rows examined',
      linked: 'Links written',
      wouldLink: 'Repairable',
      unrepaired: 'Rows not repaired',
      staleIdentityScanned: 'Stale identities examined',
      duplicatePairs: 'Duplicate pairs found',
      sharedIdentityPairs: 'Pairs with two live halves',
    },
    metricUnavailable: 'not reported',

    hasMoreTitle: 'The sweep did not finish',
    hasMoreBody:
      'This run stopped at its row cap with rows still left in the selection. Nothing after subscription {{cursor}} has been looked at yet — the numbers above describe what was examined, not the backlog.',
    continueDry: 'Continue preview from here',
    continueReal: 'Continue repairing from here',
    finishedTitle: 'The sweep reached the end of the selection',
    finishedBody: 'No damaged row remains after subscription {{cursor}}.',
    finishedBodyEmpty: 'Nothing matched the selection.',

    repairedTitleDry: 'Would be repaired',
    repairedTitleReal: 'Repaired',
    unrepairedTitle: 'Not repaired',
    emptyRepaired: 'No examined row was repairable.',
    emptyUnrepaired: 'Every examined row was repairable.',

    table: {
      subscription: 'Subscription',
      user: 'User',
      panelUsername: 'Panel username',
      resolvedBy: 'Resolved by',
      storedId: 'Stored identity',
      resolvedId: 'Resolved identity',
      panelId: 'Panel id',
      duplicateOf: 'Duplicate of',
      holdsLive: 'Bound to live profile',
      reason: 'Reason',
    },
    holdsLiveYes: 'Live — do not delete',
    holdsLiveNo: 'Not bound',
    storedEmpty: 'empty',
    fieldMissing: '—',
    resolvedByShortUuid: 'subscription short UUID',
    resolvedByUsername: 'panel username',
    resolvedByStoredIdentity: 'the identity both live rows already store',

    groupHeading: '{{outcome}} — {{rows}} row(s)',
    outcomes: {
      linked: 'Linked',
      wouldLink: 'Would link',
      unresolved: 'Panel did not resolve it',
      notOwned: 'Belongs to somebody else',
      conflict: 'Profile already held by another subscription',
      raceLost: 'Linked by a concurrent provision',
      staleIdentity: 'Stale identity, not repairable',
      duplicatePair: 'Duplicate of another subscription',
    },

    ranDry: 'Preview: {{repairable}} of {{scanned}} row(s) repairable',
    ranReal: 'Repaired {{linked}} of {{scanned}} row(s)',
  },

  duplicateMerge: {
    title: 'Duplicate subscription merge',
    hint: 'Two local subscriptions on ONE panel profile, produced by the 2.x → 3.x identity split. The merge keeps the older row with the customer history, moves everything that referenced the newer one onto it, and retires the newer one. Preview first, write second.',

    limitLabel: 'Pairs per run',
    limitHint: 'Up to {{max}}. Each pair costs the panel two resolves and one profile read.',
    chunkLabel: 'Database page size',
    chunkHint: 'Up to {{max}}. Bounds the discovery scan, not the number of merges.',

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

    eraKnown: 'Discovery panel era: {{era}}',
    eraScope3x:
      'Discovery searched both populations: rows holding no identity at all, and rows holding a dead 2.x uuid. A pair count of zero here means no duplicate pair was found.',
    eraScope2x:
      'On a 2.x panel a uuid-shaped identity is the correct one, so the population this defect lives in does not exist here. A pair count of zero does NOT mean stale rows were checked and found clean.',
    eraScopeOther:
      'This build does not recognise that era, so it cannot say which population discovery searched. Read the counts below as covering an unknown subset.',
    eraUnknownTitle: 'Discovery could not identify the panel era',
    eraUnknownBody:
      'The discovery sweep could not tell which era of the Remnawave API answered, so it refused to guess which identity spelling is current. A count of zero pairs here means "the panel answered nothing", not "there are no duplicates". Fix the panel connection and preview again before trusting these numbers.',

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
        'These two rows are not the pair the identity split produces. Running the merge again will never change that, and merging them by hand would move one customer’s history onto another.',
      unknown:
        'This build does not recognise this refusal, so it cannot say whether running the merge again would help. Read the server’s own reason on each row.',
    },

    refusals: {
      differentCustomers: 'Two different customers',
      differentPanelProfiles: 'Two different panel profiles',
      notOwned: 'The profile belongs to somebody else',
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
      survivorMissing:
        'Nothing to do here — the row named as the survivor is gone. Preview again; the discovery sweep will report the pair as it stands now.',
      duplicateMissing:
        'Nothing to do here — the row named as the duplicate is gone. Preview again; the discovery sweep will report the pair as it stands now.',
      alreadyRetired:
        'Nothing to do here — one half is already deleted, so this is not two live rows. If the surviving row is still bound to nothing, run the panel link repair above on it.',
      neitherHoldsIdentity:
        'Run the panel link repair above first. Neither of these rows is bound to the profile they both resolve to, so there is no live identity for the merge to hand the survivor. Once at least one of them holds it, preview the merge again — a pair can have one live half or two, and either is enough.',
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

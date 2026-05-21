# Promocodes Next Actions

## Immediate Repo State

The promo vertical is materially implemented and locally verified across:

- `rezeis-admin`
- `ruid`
- `rezeis-admin/web`
- `ruid/web`

Remaining unresolved work is no longer a promo-module implementation gap. It is a
blocked follow-on domain expansion.

## Next Safe Actions

1. **Broaden the referral UX around the shipped first slice**
   - add referral history in `ruid/web`
   - add invite revoke UX in `ruid/web`
   - add operator referral pages in `rezeis-admin/web`

2. **Decide whether promo should stay separate from quote/payment**
   - if yes: keep `G2` deferred
   - if no: define exact pricing / quote semantics before implementation

3. **Expand referral exchange types beyond gift-promocode**
   - subscription days
   - personal discount
   - purchase discount
   - traffic bonus

4. **Reconcile plan-state bookkeeping**
   - update `.sisyphus/plans/*.md` only in a session where those files are not read-only

## Not Safe To Do Blindly

The following should not be started without the prerequisites above:

- wiring gift-promocode exchange directly off current Prisma referral models
- merging promo activation into quote/payment path by assumption
- treating referral points and partner balance as interchangeable ledgers

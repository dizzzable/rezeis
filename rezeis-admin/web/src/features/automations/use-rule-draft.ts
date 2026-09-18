import { useState } from 'react';

import type { AutomationRule, UpsertRulePayload } from './automations-api';

/** A rule and the draft taken from it. The editor draws both or neither. */
export interface RuleInHand {
  readonly rule: AutomationRule;
  readonly draft: UpsertRulePayload;
}

function draftOf(rule: AutomationRule): UpsertRulePayload {
  return {
    name: rule.name,
    description: rule.description ?? '',
    isEnabled: rule.isEnabled,
    triggerKind: rule.triggerKind,
    triggerSpec: rule.triggerSpec,
    conditions: rule.conditions,
    actions: rule.actions,
  };
}

/**
 * What the draft is taken from: which rule it is, and every field the operator
 * edits.
 *
 * NOT `updatedAt`. Every execution writes the rule's run columns
 * (`automation-executor.service.ts`), and Prisma's `@updatedAt` moves with any
 * write to the row — so a draft keyed on it started over after every run.
 * «Запустить» re-reads the rule, and whatever the operator had typed and not
 * saved was replaced with the copy on the server. The run count, the last run
 * and the timestamps are read from the rule itself on every render, so the
 * header still counts the run.
 *
 * `createdAt` completes the identity of an unsaved draft, which has no id yet:
 * the page stamps each draft with the moment it was opened, so opening a draft
 * again — the same template twice — still starts it over. A saved rule's
 * `createdAt` never moves.
 *
 * NOT `isEnabled` either — that one is MERGED, see `useRuleDraft`. The switch
 * beside the rule in the list writes it at once, and a draft started over by
 * that press threw away everything the operator had typed into the open editor.
 */
function snapshotKeyOf(rule: AutomationRule): string {
  const { isEnabled: _switchIsMerged, ...edited } = draftOf(rule);
  return JSON.stringify([rule.id, rule.createdAt, edited]);
}

/**
 * The editable copy of the rule the editor has open.
 *
 * The draft is reset whenever a different rule arrives, or the same rule with
 * something the operator edits changed on the server — a save, here or
 * elsewhere — and kept across every other render, so the operator's typing
 * survives a refetch that changed nothing and a run that changed only the run.
 *
 * THE RENDER THAT NOTICES THE CHANGE DRAWS THE NEW DRAFT. The reset is the
 * "adjust state while rendering" pattern, and React runs the component again
 * once that render returns — but everything after the adjustment in the SAME
 * render used to read the draft still in state. The editor was then one
 * component instance for every rule, so after Create that render held the
 * draft, saw `isNew` already false and had no rule under the new id yet, and
 * built the existing-rule header from nothing: `formatDateTime('')` threw
 * `RangeError: Invalid time value` and the whole Automations page went down
 * right after «Правило создано» (panel 0.9.7.56). Opening a rule whose detail
 * had not been read yet ran the same render.
 *
 * The page has since given each selection an editor of its own
 * (`key={selectedId}`), so a draft no longer outlives its rule's id. The hook
 * does not count on that: inside one editor the rule still changes under the
 * draft in state — the answer to «Сохранить», a re-read, a template opened
 * again over an unsaved draft — and the render that notices it runs as before.
 *
 * So the value that render works with is the one it has just derived, and the
 * rule and its draft come out as ONE value: a caller cannot hold a draft
 * without the rule it was taken from, nor one rule's draft next to another.
 *
 * THE SWITCH ALONE IS MERGED, NOT RESET. When the only thing that moved on the
 * server is `isEnabled` — the list's switch, pressed while this rule is open —
 * the draft takes the new value and keeps everything else the operator typed.
 * Without that, the editor kept showing the old «Включено», and «Сохранить»
 * wrote the old switch back over the one just pressed. A switch flipped here
 * and not saved is kept across a re-read that did not move it.
 */
export function useRuleDraft(rule: AutomationRule | undefined): {
  readonly inHand: RuleInHand | null;
  readonly setDraft: (next: UpsertRulePayload) => void;
} {
  const [draft, setDraft] = useState<UpsertRulePayload | null>(null);
  // "store previous prop in state and adjust during render":
  // https://react.dev/learn/you-might-not-need-an-effect#adjusting-some-state-when-a-prop-changes
  const [snapshotKey, setSnapshotKey] = useState<string | null>(null);
  // The switch as the server last had it, kept apart from the key.
  const [serverSwitch, setServerSwitch] = useState<boolean | null>(null);
  const key = rule ? snapshotKeyOf(rule) : null;
  let current = draft;
  if (key !== snapshotKey) {
    current = rule ? draftOf(rule) : null;
    setSnapshotKey(key);
    setServerSwitch(rule ? rule.isEnabled : null);
    setDraft(current);
  } else if (rule && current && rule.isEnabled !== serverSwitch) {
    current = { ...current, isEnabled: rule.isEnabled };
    setServerSwitch(rule.isEnabled);
    setDraft(current);
  }
  return { inHand: rule && current ? { rule, draft: current } : null, setDraft };
}

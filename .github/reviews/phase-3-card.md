# Review: phase-3-card

Fresh-eyes review on 2026-11-11 by an Opus reviewer agent with a shell (typecheck, unit tests and
build run; harness and screenshots inspected; ext-apps 2.0.4 API checked against the installed
package), followed by fixes on this branch (commits 666bf8c, 916c280, 53a39b8, eecb058). Scope: the
card (`ui/src`), the harness (`ui/dev`), the screenshot and results scripts, the stdio smoke
addition, and small shared/analyzer changes the fixes needed.

## Findings

Critical (fixed, every branch unit-tested):

1. The comparison headline could say "Fixed." after a rule-2-only fix plus run-to-run noise, with
   the main problem still there and the keystroke over budget; the reverse noise said "Not fixed
   yet" beside a Resolved line; and a 0.1 ms drop never counted (float). New rule: "Fixed." only
   when the baseline's top finding is resolved, nothing is new and a keystroke fits in 16.7 ms;
   "Partly fixed." when something was resolved but not all of that holds; "Faster." only for a drop
   of at least 10 % and 0.5 ms with nothing resolved; otherwise "Not fixed yet." Times compared in
   rounded tenths. `Comparison.baselineTopFindingId` added (optional, additive).

Should-fix (all fixed): skeleton stuck forever on an `isError` result, a result without
structuredContent, or a `toolcancelled` event; `updateModelContext` overwrote earlier context (now
one combined text); the "couldn't check" state had no action; re-runs with a remaining finding lost
the why/line/fix chips; whitespace-only diffs showed an empty box; no side padding (chip borders and
focus rings clipped at the frame edge; the harness had padding the host does not); `clipboardWrite`
permission missing on the resource; the screenshot script deleted the committed live shots (now in
`live/`); the same number repeated two or three times in the no-findings and "Fixed." states.

Nits (all fixed): `=>` shown as a ligature in code; "More changes not shown" when nothing was
hidden, missing gap marker, unused line numbers; indistinguishable added/removed fallbacks when the
host sends no status colours; package.json and zod pulled into the bundle (removed; size unchanged
because ext-apps itself bundles zod); Node types in browser tsconfig; `aria-controls` to absent
panels, double-send of the primary button, `<title>` "Card", an internal run id shown to the user;
caption verb on the unchecked state, tree times that disagreed with the bar.

Not done, by §8's own wording optional: the receiving state does not show the code streaming in.

Confirmed clean by the reviewer: every §8 element and label present word for word (caption, five
tree labels, three chips, "What one keystroke does", "Watch it again", the exact "Fix it and check"
message, 16.7 ms marker, at most two actions, no popovers); host wiring matches ext-apps 2.0.4
(toolinput/toolinputpartial/toolresult before connect, auto-resize so no inner scroll, host style
variables with `data-theme`, no external scripts or fonts, `prefersBorder:false`, CSP
`assets.claude.ai`); the LCS diff is correct on insert/delete/replace, CRLF and empty files; the
card tests assert §8 wording and behaviour, not smoke renders; reduced motion and keyboard access
handled; colour never the only signal; Phase 2 untouched except the additive comparison field and a
caption fix.

Resolved: all 17 items fixed on this branch; typecheck, 127 unit tests, golden suite 28/28 and the
build green at eecb058; screenshots retaken (56 harness + 4 live).

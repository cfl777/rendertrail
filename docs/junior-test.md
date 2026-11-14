# Junior developer test (HANDOFF §9, Phase 3 "You")

Goal: a junior developer gets from "it's laggy" to a checked fix **without asking you anything**.
Run it with 3 people, one at a time, about 20 minutes each.

## Before the session

- Claude Desktop with Rendertrail connected (the card shows on your machine already).
- The laggy search box open in an editor: `fixtures/laggy-search/` (after Phase 4: `examples/laggy-search/`).
- Screen recording on, with their permission. No coaching once they start.

## What you say (read it, then stop talking)

> "Typing in this search box feels laggy. Use Claude to find out why and fix it. Think out loud.
> I can't answer questions, but tell me whenever you are unsure what to do next."

Do not mention Rendertrail, memo, re-renders or the card.

## What a pass looks like

| Step | They should get there alone | Time you'd expect |
|---|---|---|
| 1 | Ask Claude about the lag; the card appears | 2 min |
| 2 | Say in their own words what is wrong ("the list re-renders on every letter although nothing changed") | 3 min |
| 3 | Open at least one of: Why does it happen? / Show me the line / How do I fix it? | 2 min |
| 4 | Press "Fix it and check" (or ask Claude to fix it) | 2 min |
| 5 | Read the second card and say whether it is fixed, and how they know | 3 min |

## Observation sheet (one per person)

| | Notes |
|---|---|
| Name / experience with React | |
| First thing they looked at on the card | |
| Words they did not understand | |
| Where they stopped or hesitated (step, seconds) | |
| Anything they clicked that did nothing they expected | |
| Did they trust the "Fixed." card? What convinced them? | |
| Did they read the text answer, the card, or both? | |
| Their own summary of the problem, word for word | |
| Would they use it again? On what? | |
| Pass (all 5 steps alone) / Stuck at step … | |

## After three sessions

List every place two or more people got stuck. Those are the top fixes before the beta. One person
stuck once is a note, not a bug.

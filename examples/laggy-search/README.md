# Laggy search: an example to try Rendertrail on

A small React app with a search box that feels laggy while you type: every letter re-renders
200 result rows that didn't change.

```sh
npm install
npm run dev     # open the printed URL and type into the search box
```

## Try it

Install Rendertrail first (see the [main README](../../README.md#install)). Then open this folder in
Claude (Claude Desktop with the folder shared, or Claude Code started here) and ask:

> Why is typing in the search box laggy?

Claude sends the components in `src/` to Rendertrail with a short interaction (type "hello" into
the search box), and gets back something like this (timings depend on your computer):

```
Typing "hello" (5 letters): 20.5 ms per letter, over the 16.7 ms frame budget.
1. ResultsList (memo) re-renders with 200 ResultRow below it on every letter: prop `filters` is a
   new object each render with the same value, created at SearchPage.tsx:19. Wasted: about 20.4 ms
   per letter. Fix: wrap it in useMemo (React Compiler would do this automatically).
2. SearchBox sets state inside useEffect (SearchBox.tsx:10): one extra update per letter.
   Fix: compute charCount during render: `const charCount = value.length;`.
```

In Claude Desktop the same answer shows as a card. Then say **Fix it and check**: Claude wraps
`filters` in `useMemo`, records the same typing again, and the card shows before and after (about
0.1 ms per letter once it's fixed).

What it must **not** report: `Sidebar` (its memo works), and the `setTimeout` inside `useDebounce`
(that's a timer, not state set during an effect).

The components are the same as the project's golden test, `fixtures/laggy-search/`.

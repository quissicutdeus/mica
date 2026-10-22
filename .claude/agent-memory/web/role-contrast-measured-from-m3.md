# Measure a role's contrast from `m3.ts`, not by eye

Light-mode colours are generated at runtime by `sdk/lib/m3.ts`
`buildSchemes(seed)`; `app.css` holds only the dark default. To know whether a
role passes both schemes, bundle a scratch script that imports `buildSchemes`
with `node_modules/.bin/esbuild --bundle --platform=node --format=esm` and run
the output. Plain `node` on the `.ts` fails, because
`@material/material-color-utilities` uses extensionless imports, and there is no
`tsx` here.

Measured on MICA-411 (2026-10-22), on `surface-container`, across six seeds:
every text role clears 5.5:1 light and 9.5:1 dark. `on-surface` gives 14.7 and
12.6, `primary` 5.5 and 9.6, `error` 5.5 and 9.6. A palette literal like
`text-green-400` measured 1.49:1 on light. Per `a11y.spec.ts`, no single literal
green passes 4.5:1 on both schemes.

Pick a role by meaning as well as ratio: `primary`/`tertiary` are seeded, so a
red seed turns a "money in" `text-primary` the same red as `text-error`. Bank
and Casino use `on-surface` for the positive side and let the sign or the words
carry it.

Also from that run: `onAppForeground` fires synchronously on subscribe when the
app is already in front, so a component that also loads in `onMount` loads twice
on first open. And `renderApp`'s `rerender` is typed `Partial<AppProps>`; to
pass an app's extra prop, bind it to a wider function type rather than casting.

# @exulanica/landing

The public Exulanica title and Method surfaces. This package is deliberately not an Atlas shell.
It contains no application state, Companion runtime, formation replay, graph client, or renderer.

```bash
pnpm --dir web landing
pnpm --dir web landing:build
```

## Canonical Atlas handoff

The title's **Enter Atlas** link opens the single application composition root in `@exulanica/app`.
The destination is deployment-owned:

```bash
VITE_ATLAS_URL=https://atlas.example.com pnpm --dir web landing:build
```

`VITE_ATLAS_URL` may also be a same-origin path such as `/atlas`. A production build without this
value says that Atlas is not connected instead of guessing a domain or exposing a dead control.

During local development the default is `http://127.0.0.1:5173/?preview=1`, the documented Vite
preview for the canonical app. Override it whenever the app is running elsewhere:

```bash
VITE_ATLAS_URL='http://127.0.0.1:5175/?preview=1' pnpm --dir web landing
```

The preview query is only honored by the app's Vite development server. A production app build
does not accept it.

## Boundaries

The landing package depends only on `@exulanica/presentation` for shared semantic visual tokens.
`web/.dependency-cruiser.cjs` enforces that boundary and separately prevents renderer imports.
This keeps the public first paint lightweight while leaving world-owned visual identity, Atlas
navigation, the geometric Companion, evidence, Map, and Index inside the canonical application.

## Surfaces

- **Title** places the Exulanica wordmark over one generated memory crescent, with a lower-left
  navigation menu and one explicit entry into Atlas. It uses no scenic or photographic backdrop.
- **Method** explains the evidence and reconstruction contracts with the generated ladder figure.
- **Viewport boundary** states the product's current desktop input requirement rather than showing
  a fake small-screen product.

The signed-out surfaces share a neutral light canvas, keyboard focus treatment, and reduced-motion
rules. The landing palette is scoped locally so Atlas world profiles remain independent.

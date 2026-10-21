# Peragus — Frontend dark prototype V2

This folder contains the **standalone, interactive HTML design prototype** approved for further review.

- Open `peragus-v2-dark.html` locally in a browser to explore the interface.
- When served by the existing frontend, preview it at `/prototypes/peragus-v2-dark.html`.
- Scope: dashboard, operations, liquidity, integrations, institutional overview, settlement lab, API reference, wallet, onboarding, audit and incident views.
- **Prototype only:** sample financial data, UI-only interactions; no live trading, wallet transactions, API credentials, or backend operations.
- Dark-only visual direction inspired by clean institutional fintech UI.
- This branch was created from `develop`. The production routes and backend remain unchanged.

## Next implementation phase

Port the approved screens into typed React components in `app/frontend/src/`, reuse existing frontend API contracts and wallet safeguards, add responsive and accessibility tests, and connect only to existing approved backend endpoints. Do not modify `app/backend/` or on-chain programs as part of frontend work.

To preview the static file in a local checkout:

```bash
cd app/frontend
npm ci
npm run dev
```

Then open `http://localhost:3000/prototypes/peragus-v2-dark.html` if the dev server is configured on port 3000; otherwise use the local address printed by Vite.

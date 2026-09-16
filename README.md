# Movune public-source release candidate

This branch contains the curated public-source migration candidate. It is not the currently deployed Production release.

- Authorized source snapshot: `b9cfb459980af0b4b21e70f89420a0ca0aab7b69`
- Public baseline: `jing913/movune@5c58dc7d7f9c9d2e0b33f87db861dc08f5a4e928`
- Deployment status: not deployed from this branch

The source candidate can be newer than the version currently served by GitHub Pages and Render. Its presence does not mean that Phase, Stage, Collections, privacy, or realtime capabilities are live in Production.

## Structure

- `frontend/` — Vue frontend source and reproducible build configuration
- `backend/` — Express backend source and selected public engineering tests
- `docs/` — publication manifest and transitional documentation index

## Local validation

Use Node.js 24 and npm 11 or newer.

```text
cd frontend
npm ci
npm run format:check
npm run lint
npm run typecheck
npm run build

cd ../backend
npm ci
npm run format:check
npm run lint
npm run build
npm test
```

Copy each `.env.example` to a local `.env` and supply your own development values. Never commit real credentials. Variables beginning with `VITE_` are public build-time configuration and must never contain secrets.

`npm test` runs the selected public suites that do not require external services. Run `npm run test:integration` only after configuring your own local MongoDB `DB_URL`; no private or Production database value is provided by this repository.

## Licensing status

A repository-wide license has not yet been selected. No root `LICENSE` is included. The backend package retains its pre-existing package metadata pending an explicit owner decision; it must not be interpreted as a repository-wide license grant.

Full portfolio documentation and release automation are intentionally deferred to later migration checkpoints.

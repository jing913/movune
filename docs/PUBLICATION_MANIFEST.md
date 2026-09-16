# Publication manifest

This document records the reviewable source boundary for the Movune public portfolio repository. It is an audit record, not a product roadmap or deployment runbook.

## Source boundary

- Authorized application source snapshot: `b9cfb459980af0b4b21e70f89420a0ca0aab7b69`
- Public Production baseline used to prepare the candidate: `5c58dc7d7f9c9d2e0b33f87db861dc08f5a4e928`
- Initial curated source-candidate commit: `690c2da9b6e7195b3e324ec7e28852311f4a15da`
- Candidate status at preparation: local and not deployed

Application files were selected from the committed authorized snapshot. Uncommitted work and later development were not used.

## Publication scope

Included:

- reproducible Vue frontend source and configuration;
- Express backend source and configuration;
- curated policy, regression, API, and persistence tests;
- validation-only CI and a manual-only GitHub Pages Production release workflow;
- safe environment examples containing names and local/placeholding values only;
- reviewer-facing portfolio and architecture documentation;
- the approved homepage atmosphere asset described below.

Intentionally excluded:

- private implementation specifications, research, internal reviews, and working instructions;
- milestone-labelled and formula-focused internal tests not needed for the public suite;
- backend deployment workflows, deploy hooks, and operational secrets;
- compiled frontend/backend output, generated source maps, dependency directories, coverage, logs, and reports;
- uncommitted or later development work;
- unverified optional visual assets and unpublished screenshots.

## Included asset provenance

`frontend/src/assets/home-hero-atmosphere.png` is included as a project-owner-generated asset. The owner states that they personally requested and generated the image with OpenAI ChatGPT and used that output as Movune's homepage atmosphere artwork.

A visual sanity review found no recognizable copyrighted characters, movie frames or posters, studio logos, focal trademarks, signatures, watermarks, or other clearly attributable third-party artwork. This record explains the inclusion of this specific asset; it is not a general statement about all generated media.

Google Fonts remain external references and are not vendored into the repository.

## Excluded visual assets

The following source-snapshot assets remain excluded because redistribution provenance was not established and they are unnecessary for a reproducible build:

- `frontend/src/assets/hero.png`
- `frontend/src/assets/vite.svg`
- `frontend/src/assets/vue.svg`
- `frontend/public/favicon.svg`
- `frontend/public/icons.svg`

The favicon document reference was removed with the asset to avoid a broken request.

## Publication remediations

- Request logging retains the HTTP method and path while removing query-string values.
- The backend default test command contains selected suites that do not require an external database.
- MongoDB-dependent API and persistence suites are isolated behind `npm run test:integration`.
- Environment examples contain safe local values and explicit placeholders only.
- Generated source maps and build output are ignored and absent from the committed tree.
- Internal milestone terminology was removed from selected public test descriptions without changing tested behavior.

## Environment and secret boundary

The browser receives only `VITE_API_BASE_URL`; variables beginning with `VITE_` are public build-time configuration and must not contain secrets.

Database credentials, JWT signing material, the TMDB token, and SMTP credentials remain server-side environment values. Real `.env` files are excluded. Public examples must never contain Production or private values.

The prepared Pages workflow obtains the public Production API origin from the non-secret repository variable `VITE_API_BASE_URL`. That remote variable is not configured during candidate preparation, so the workflow fails closed until a later authorized checkpoint supplies it. No backend secret, Render hook, or server credential is referenced by the workflows.

## Prepared release boundary

- `.github/workflows/ci.yml` validates pull requests and manual runs only; it has no deployment job or deployment permission.
- `.github/workflows/deploy-production.yml` has only a manual `workflow_dispatch` trigger, accepts no arbitrary ref input, requires `main`, and records the exact dispatched commit used for the build.
- The Pages artifact is produced from `frontend/dist`; the existing frontend post-build step creates the SPA `404.html` fallback.
- GitHub Pages remains configured remotely to deploy the current `main` root. The prepared workflow is local, unpushed, undispatched, and not active.
- A later authorized activation must set `VITE_API_BASE_URL` and change the Pages source to GitHub Actions before public source is merged to `main`; otherwise the current branch-source binding would still deploy an ordinary `main` push.
- Render deployment remains outside this frontend release boundary.

## Documentation boundary

Public documentation is deliberately small:

- `README.md` is the portfolio entry point;
- `docs/ARCHITECTURE.md` explains the source candidate's technical boundaries;
- this manifest records provenance and exclusions;
- `CONTRIBUTING.md` records maintenance and validation conventions.

No private documentation library is mirrored into the public repository.

## Portfolio usage status

Movune is published for educational, portfolio, review, and demonstration purposes. No root `LICENSE` is included, the packages are marked private where appropriate, and no repository-wide open-source license or general reuse grant is made by public visibility alone.

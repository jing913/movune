# Publication manifest

## Source boundary

- Private source snapshot: `b9cfb459980af0b4b21e70f89420a0ca0aab7b69`
- Public baseline: `5c58dc7d7f9c9d2e0b33f87db861dc08f5a4e928`
- Candidate branch: `migration/public-source-rc`
- Candidate status: not deployed

All migrated application files were selected from the committed source snapshot. Uncommitted development work was not used.

## Included asset provenance

`frontend/src/assets/home-hero-atmosphere.png` is included as a project-owner-generated asset. The owner states that they personally requested and generated the image with OpenAI ChatGPT and used that output as Movune's homepage atmosphere artwork. A visual sanity review found no recognizable copyrighted characters, movie frames or posters, studio logos, focal trademarks, signatures, watermarks, or other clearly attributable third-party artwork.

This provenance record describes the basis for including this specific asset; it is not a general statement about all generated media.

Google Fonts remain external references and are not vendored into this repository.

## Excluded asset categories

The following source-snapshot assets are excluded because redistribution provenance was not established and they are not required for a reproducible build:

- `frontend/src/assets/hero.png`
- `frontend/src/assets/vite.svg`
- `frontend/src/assets/vue.svg`
- `frontend/public/favicon.svg`
- `frontend/public/icons.svg`

The favicon reference was removed to avoid a broken runtime request.

## Other exclusions

- Compiled frontend artifacts and generated source maps
- Private implementation specifications and research
- Internal milestone, recommendation-formula, and Stage/Phase tests
- Deployment workflows
- Local environment files, caches, logs, coverage, and generated reports

## Publication remediations

- Request logging retains the HTTP method and path while removing query-string values.
- Public environment examples contain names and safe local placeholders only.
- Generated source maps are excluded from the repository publication artifact.
- Repository-wide licensing remains an owner decision; no root license has been added.

Selected authorization, privacy, policy, and regression tests run without external services through `npm test`. Selected API and persistence suites remain available through `npm run test:integration` and require a developer-supplied local MongoDB configuration.

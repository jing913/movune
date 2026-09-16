# Repository conventions

Movune is published for portfolio and educational review. This document records the standards used to maintain the repository; it is not an invitation for unsolicited feature contributions.

## Change boundaries

- Keep application changes separate from deployment and release changes.
- Do not describe source-only behavior as deployed or Production-live.
- Do not commit credentials, local `.env` files, build output, source maps, coverage, logs, or generated reports.
- Preserve the public/private documentation boundary recorded in `docs/PUBLICATION_MANIFEST.md`.
- Treat `main` as the deployed Production history until a controlled release explicitly changes it.

## Local validation

Use Node.js 24.x and npm 11 or newer.

Frontend changes should pass:

```bash
cd frontend
npm ci
npm run format:check
npm run lint
npm run typecheck
npm run build
```

Backend changes should pass:

```bash
cd backend
npm ci
npm run format:check
npm run lint
npm run build
npm test
```

Run `npm run test:integration` only with a developer-owned local or test MongoDB configuration. Never point tests at private or Production data.

## Commit convention

Use focused commits with this format:

```text
<type>: <English summary>（中文摘要）
```

Before committing, review the complete diff, verify the relevant checks, and confirm that generated or sensitive files remain excluded.

## Licensing and external contributions

No open-source license is granted for this repository. Any future collaboration or reuse arrangement requires an explicit owner decision; do not infer permission from public visibility.

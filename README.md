# Movune

**Meet People Through Movies**<br>
透過電影，認識電影同好

_Movies move. Stories connect._

## Overview

Movune is a movie-first social discovery application. It treats films as more than content to browse: the movies a person favorites become useful context for understanding taste and meeting people with shared interests.

The experience starts with movie discovery and a personal Movie Space. Favorite genres and titles form a Movie DNA profile, which supports people discovery, match explanations, and the Encounter card interaction. A connection can continue through profiles, follows, message requests, direct conversations, and movie discussion rooms.

This repository is a curated public-source candidate for portfolio review. It contains working frontend and backend engineering that may be newer than the currently deployed website; source availability does not mean every capability has been released to Production.

## Product Highlights

- **Movie discovery** — browse, search, filter, and inspect TMDB movie data through a backend-controlled proxy.
- **Favorites and Movie Space** — save movies with uniqueness enforced per user and choose whether favorite information is public or private.
- **Movie DNA and people discovery** — turn favorite genre signals into a taste profile, then surface explainable similarities with other members.
- **Encounter** — reveal a potential movie connection through an accessible card-based discovery flow when sufficient taste signals exist.
- **Social connection** — view member profiles, follow people, receive notifications, and apply explicit block, report, and privacy rules.
- **Messaging** — support message requests, direct conversations, movie discussion rooms, read state, and authenticated realtime updates.

## Core User Flow

**Discover movies → Favorite → Build Movie DNA → Discover people → Follow → Message**

## Architecture

```text
Browser
  └─ Vue 3 + TypeScript + Pinia
       ├─ REST requests ───────────────┐
       └─ Socket.IO client ────────────┤
                                      ▼
                              Express + Socket.IO
                               ├─ Passport/JWT auth
                               ├─ Mongoose ──────────► MongoDB
                               └─ TMDB proxy ────────► TMDB API
```

The browser never receives the TMDB access token. Movie requests go through validated `/api/tmdb` routes, and the backend makes the authenticated upstream request. Application records—users, favorites, follows, collections, conversations, messages, notifications, blocks, and reports—are persisted through Mongoose.

See [Architecture](docs/ARCHITECTURE.md) for the technical boundaries and reviewer map.

## Technology Stack

| Area                       | Verified RC technologies                                                                      |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| Frontend                   | Vue 3.5, TypeScript 6, Vite 8, Pinia 4, Vue Router 5, Tailwind CSS 4, Axios, Socket.IO Client |
| Backend                    | Node.js 24, Express 5, TypeScript 6, Passport JWT, Socket.IO 4, Nodemailer                    |
| Data and external services | MongoDB, Mongoose 9, TMDB API                                                                 |
| Validation and quality     | Node test runner, ESLint 10, Prettier 3, vue-tsc                                              |

Versions above reflect the package manifests in this source candidate and may advance in later development.

## Engineering Highlights

1. **External API boundary** — TMDB input is allow-listed and validated server-side, keeping the upstream token out of browser code and presenting consistent application errors.
2. **Authentication lifecycle** — short-lived bearer access tokens are paired with hashed, rotating refresh tokens in an HTTP-only cookie. Frontend coordination prevents stale refresh results from reconnecting the wrong realtime identity.
3. **Policy-driven social authorization** — follow direction, blocks, message-request preferences, and conversation state are resolved into explicit capabilities. Invalid privacy state fails closed.
4. **Persistence integrity** — compound indexes prevent duplicate favorites, follows, collection memberships, direct participant pairs, and client message submissions.
5. **Scoped realtime delivery** — authenticated sockets join per-user rooms, while discussion subscriptions use room-specific channels. REST writes publish small invalidation events to the affected audience.

## Project Structure

```text
frontend/
  src/views/       Page-level product flows
  src/services/    REST and realtime clients
  src/stores/      Authentication and Encounter state

backend/
  src/routes/      HTTP route families
  src/controllers/ Request validation and response handling
  src/services/    Product, policy, and realtime orchestration
  src/models/      Mongoose schemas and integrity indexes
  test/            Curated public unit and integration suites

docs/
  ARCHITECTURE.md          Technical overview and reviewer map
  PUBLICATION_MANIFEST.md  Publication and provenance boundary
  RELEASE_RUNBOOK.md       Controlled frontend/backend release procedure
```

## Local Development

### Prerequisites

- Node.js 24.x
- npm 11 or newer
- A local/development MongoDB database
- A TMDB Read Access Token
- Optional SMTP credentials for password-reset email; development falls back to logging the reset URL when SMTP is not configured

### Backend

```bash
cd backend
npm ci
cp .env.example .env
npm run dev
```

Replace every placeholder in `backend/.env` before starting. The backend development server defaults to `http://localhost:3000`.

### Frontend

In another terminal:

```bash
cd frontend
npm ci
cp .env.example .env.local
npm run dev
```

Vite serves the frontend at `http://localhost:5173` by default.

### Environment variables

| Boundary                                    | Variables                                                                                                       |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Public browser configuration                | `VITE_API_BASE_URL`                                                                                             |
| Backend application configuration           | `PORT`, `FRONTEND_APP_URL`, `FRONTEND_ORIGIN`, `NODE_ENV`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_FROM` |
| Server secrets or credential-bearing values | `TMDB_READ_ACCESS_TOKEN`, `DB_URL`, `JWT_SECRET`, `SMTP_USER`, `SMTP_PASS`                                      |

`VITE_` values are bundled into browser code and must never contain secrets. Use only local or dedicated development credentials; do not use Production values.

## Testing

Frontend static validation:

```bash
cd frontend
npm run format:check
npm run lint
npm run typecheck
npm run build
```

Backend public suite:

```bash
cd backend
npm run format:check
npm run lint
npm run build
npm test
```

The default backend suite covers 88 selected policy, serialization, authentication-support, TMDB, and regression tests without requiring an external database. MongoDB-dependent API and persistence suites are deliberately separate:

```bash
cd backend
npm run test:integration
```

Integration tests require the developer's own local/development `DB_URL`. Never run them against a private or Production database.

## Production & Repository Status

| State                       | Meaning                                                                                                                   |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| **Current Production**      | The deployed frontend and backend remain on the separately controlled Production version.                                 |
| **Public-source candidate** | This repository may contain completed engineering work that has not yet been released to the deployed Production version. |
| **Ongoing development**     | Newer work can continue independently and is not automatically included in this candidate or released to Production.      |

In particular, the presence of collections, privacy controls, matching, or realtime source code must not be read as evidence that the same version is currently live. Production status is determined by the deployed release, not by source presence.

## Deployment

The current service topology is:

- **Frontend:** GitHub Pages
- **Backend:** Render web service
- **Database:** MongoDB Atlas
- **Movie metadata:** TMDB API, accessed by the backend

Deployment is intentionally controlled and separated from ordinary development pushes.

- **Current:** Production still uses the existing GitHub Pages branch source and separately managed Render service.
- **Prepared:** this source candidate contains validation-only CI and a manual-only `Deploy Movune Production` Pages workflow. The release workflow builds the exact dispatched `main` commit, requires the non-secret repository variable `VITE_API_BASE_URL`, and fails before artifact upload when the source or configuration is invalid.
- **Prepared backend boundary:** the existing Render service is intended to remain on `Auto Deploy: Off`. After the one-time source-binding migration, routine backend releases use Render's authenticated Dashboard action to deploy one reviewed public commit by SHA.
- **Not yet active:** these workflows and the Render target architecture remain local documentation in the unpublished candidate. GitHub Pages has not been switched to GitHub Actions, Render is still bound to the private development repository, the candidate has not been pushed or merged, and no Production release has occurred.

The CI workflow can validate pull requests or be run manually, but it has no deployment permissions or deployment steps. The Production workflow has no push trigger. Render release migration is a separate, human-authorized operational boundary and is not implemented by either workflow. See the [release runbook](docs/RELEASE_RUNBOOK.md) for the prepared—not active—transition and rollback procedure.

## Documentation

- [Architecture](docs/ARCHITECTURE.md) — system responsibilities, data relationships, and trust boundaries
- [Publication manifest](docs/PUBLICATION_MANIFEST.md) — source, asset, secret, and exclusion provenance
- [Release runbook](docs/RELEASE_RUNBOOK.md) — controlled Production activation, traceability, and rollback gates
- [Repository conventions](CONTRIBUTING.md) — review and local validation expectations

## Portfolio / Usage Notice

Movune is a personal academic and portfolio project. The source code is publicly viewable for review and demonstration purposes. No open-source license or general permission to reuse, modify, or redistribute the code is granted unless explicitly stated otherwise.

Movie metadata is provided through the TMDB API. This product uses the TMDB API but is not endorsed or certified by TMDB.

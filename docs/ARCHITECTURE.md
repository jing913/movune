# Movune architecture

This document describes the architecture present in the public-source candidate. It is a code-review guide, not a claim that every source capability is deployed in the current Production version.

## System overview

```text
Browser
  └─ Vue application
       ├─ HTTPS / JSON REST
       └─ authenticated Socket.IO
                    │
                    ▼
             Express application
              ├─ Passport/JWT boundary
              ├─ product and policy services
              ├─ Mongoose ─────────────► MongoDB
              └─ validated TMDB proxy ─► TMDB API
```

The frontend and backend are independently installable Node projects. The frontend consumes a single configurable API origin; the backend owns credentials, persistence, authorization, upstream TMDB access, and realtime publication.

## Frontend responsibilities

The Vue application provides routes for movie discovery and detail, Movie Space and collections, people discovery, Encounter, member profiles, inbox/conversations, and password reset.

Key boundaries:

- `src/router/` defines public and authenticated routes.
- `src/services/` contains typed REST clients, authentication refresh coordination, and Socket.IO session handling.
- `src/stores/` owns authenticated identity and Encounter UI state.
- `src/composables/` coordinates reusable favorites, collections, notifications, inbox, and Movie DNA behavior.
- `src/views/` assembles the page-level product flows.

Access tokens are kept in application state and attached to API requests. A failed authenticated request can trigger one coordinated refresh operation. Realtime connection state is bound to a verified user identity so an older credential result cannot reconnect a superseded session.

## Backend responsibilities

The Express server exposes route families for:

- authentication and account recovery;
- users, profiles, Movie DNA, matching, Encounter, blocks, and reports;
- favorites, collections, and follows;
- notifications and inbox summaries;
- direct conversations, messages, and movie discussion rooms;
- TMDB movie discovery and metadata.

Controllers validate transport input and shape HTTP responses. Services combine persistence and product rules. Pure policy utilities keep authorization decisions testable without a running database. A centralized error handler returns application errors, while request logging records only the HTTP method and path—not query-string values.

## Data responsibilities and relationships

MongoDB is accessed through Mongoose models. Important relationships include:

- a **User** owns authentication, profile, favorite-visibility, and message-request preferences;
- a **Favorite** joins a user to a TMDB movie and its genre signals;
- a **Follow** records a directed member relationship;
- a **Collection** owns ordered **CollectionMembership** movie entries;
- a **DirectConversation** owns participant and lifecycle state, with per-user read state in **DirectConversationState**;
- a **DiscussionRoom** represents a TMDB movie room, with per-user status and read state in **DiscussionMembership**;
- a **Message** belongs to a direct conversation or discussion room;
- **Notification**, **UserBlock**, and **Report** records support social feedback and safety boundaries;
- hashed **RefreshToken** and **PasswordResetToken** records support authentication lifecycle operations.

Compound indexes protect key invariants such as one favorite per user/movie, one follow per directed pair, one collection membership per collection/movie, one direct conversation per participant pair, and one message per sender/client-message identifier.

## TMDB integration

The browser calls `/api/tmdb/*`; it does not call TMDB with a project credential. The backend:

1. accepts only supported movie endpoints and query shapes;
2. validates identifiers, paging, locale, region, filters, and sort options;
3. adds the server-held `TMDB_READ_ACCESS_TOKEN`;
4. applies an upstream timeout and maps upstream failures to stable application errors.

The same boundary retrieves authoritative title and poster snapshots when application records need stable movie context.

## Authentication boundary

Passwords are hashed with bcrypt before persistence. Login issues a short-lived JWT access token and a random refresh token. Only a SHA-256 hash of the refresh token is stored; the raw token is returned in an HTTP-only cookie and rotated during refresh.

Passport validates bearer JWTs for protected REST routes. Socket.IO performs its own JWT verification during the connection handshake and confirms that the user still exists before joining a per-user room. Password-reset tokens are random, stored only as hashes, time-limited, and single-use.

## People discovery and Movie DNA

Favorite genre signals are aggregated into a Movie DNA profile. People discovery services compare eligible profiles and produce constrained, viewer-safe explanations such as shared genres and only those shared favorites permitted by visibility rules. Encounter uses the same authorized explanation boundary to reveal candidates through a card interaction.

The public documentation intentionally describes the responsibility and disclosure boundary without publishing internal weighting details.

## Messaging and realtime boundary

The source candidate supports direct-message requests, accepted conversations, movie discussion rooms, read state, reporting, and inbox summaries.

Before a direct interaction, a centralized contact policy evaluates:

- whether either member has blocked the other;
- follow direction;
- the recipient's message-request preference;
- existing conversation lifecycle state;
- whether the requested action is follow, block, unblock, report, or message.

Invalid preference data fails closed. REST mutations persist the authoritative state, then publish compact Socket.IO events to per-user or per-discussion rooms. The frontend uses those events to invalidate or refresh its read models instead of treating socket payloads as the database of record.

## Privacy and authorization boundaries

- Favorites default to private and are revealed according to a viewer-aware visibility policy.
- Match explanations expose only permitted shared evidence.
- Blocks suppress distribution and direct social access in both directions.
- Message requests and conversation transitions are authorized from persisted relationship state.
- Report actions validate the actor, target, and eligible message or conversation context.
- Collection reads distinguish owner and public access, while mutations require ownership.

These boundaries are represented in focused policy and service tests as well as API/persistence integration suites.

## Deployment topology

The currently deployed system uses:

- GitHub Pages for the frontend;
- Render for the Node/Express backend;
- MongoDB Atlas for persistence;
- TMDB for external movie metadata.

The public-source candidate is not deployed merely because it exists. Release changes remain separate from ordinary development changes, and future controlled-release automation is outside this document's current-state claims.

### Prepared frontend release boundary

The candidate prepares two independent GitHub Actions workflows:

- `ci.yml` validates frontend formatting, linting, types, and build output plus the self-contained backend public suite. It can run for pull requests or by manual dispatch and cannot deploy.
- `deploy-production.yml` is manual-only. It rejects any dispatch that is not based on `main`, checks out the exact `github.sha`, records that SHA in the workflow summary, validates and builds the frontend, uploads `frontend/dist`, and deploys through the protected `github-pages` environment.

The Production build reads the public API origin from the repository variable `VITE_API_BASE_URL`; a missing or non-HTTPS value fails closed. Server credentials are never supplied to the frontend workflow. The Vite build retains the `/movune/` project base, and its existing post-build step copies `index.html` to `404.html` for SPA refresh fallback.

This boundary is prepared but not active. The remote Pages source remains the existing `main` branch root until a later, separately authorized release checkpoint changes it to GitHub Actions. Neither workflow contains Render deployment logic.

## Source and Production lifecycle

Three states must remain distinct:

1. **Current Production** — the commit versions currently deployed by GitHub Pages and Render.
2. **Public-source candidate** — reviewed source that may include completed but unreleased engineering.
3. **Ongoing development** — later work that is neither automatically migrated into the candidate nor deployed.

For publication provenance and deliberate exclusions, see [Publication manifest](PUBLICATION_MANIFEST.md).

## Reviewer map

| Review interest                | Start here                                                                                                                       |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| HTTP and realtime composition  | `backend/src/server.ts`                                                                                                          |
| Authentication lifecycle       | `backend/src/controllers/authController.ts`, `backend/src/configs/passport.ts`, `frontend/src/services/api.ts`                   |
| Movie discovery proxy          | `backend/src/routes/tmdb.ts`, `backend/src/controllers/tmdbController.ts`, `backend/src/services/tmdbMetadataService.ts`         |
| Movie DNA and people discovery | `backend/src/services/movieDnaService.ts`, `backend/src/services/dnaMatchService.ts`, `backend/src/services/encounterService.ts` |
| Social authorization           | `backend/src/utils/contactAuthorizationPolicy.ts`, `backend/src/services/contactAuthorizationContextService.ts`                  |
| Messaging and realtime         | `backend/src/routes/messaging.ts`, `backend/src/services/messagingService.ts`, `backend/src/services/realtimeService.ts`         |
| Data integrity                 | `backend/src/models/`, `backend/test/`                                                                                           |
| Frontend product flows         | `frontend/src/router/index.ts`, `frontend/src/views/`, `frontend/src/services/`                                                  |

# Controlled Production release runbook

This runbook defines the controlled Batch 3 application release boundary for Movune. Preparation is complete only for the isolated candidate: the current Production service is already bound to the public repository, GitHub Pages uses GitHub Actions, and no Batch 3 publication or deployment step in this document has been authorized or executed.

## Release invariants

```text
private development push != Production release
public source push or merge != Production release
frontend release != backend release
```

Render Auto Deploy remains off. A CI result, Git push, or merge is not authorization. Backend authorization requires a deliberate authenticated Render Dashboard action after the exact public commit has passed the release gates. Frontend authorization remains a separate manual GitHub Pages workflow dispatch.

## Current and target boundaries

| Boundary | Current Production | Prepared future target |
| --- | --- | --- |
| Render service | `movune` (`srv-daf4ej740ujc739i04tg`) | same service |
| Repository | `jing913/movune` | same repository |
| Branch | `main` | `main` |
| Root directory | `backend` | `backend` |
| Build command | `npm ci --include=dev && npm run build` | unchanged |
| Start command | `npm start` | unchanged |
| Runtime / region | Node / Singapore | unchanged |
| Auto Deploy | off | off |
| Known-good backend | commit `38d6415bbf94d188334f854282d5d439dc082951`, deploy `dep-dblipsbncjis73dvsv60` | record a new public SHA only after release |

Current public `main` is `c2979fdbb3f4c2bdd8376ed789129532cac318bd`. The live backend SHA is deliberately different from public branch head. The isolated candidate is not yet a remote release source.

## Environment contract

Only variable names and behavior are recorded here. Values remain in Render and must not be copied into source, tickets, logs, or release notes.

| Classification | Names | RC behavior |
| --- | --- | --- |
| Startup-required | `DB_URL`, `JWT_SECRET`, `FRONTEND_APP_URL`, `FRONTEND_ORIGIN` | Missing values stop startup. The app URL must end in `/`; the origin must contain only the matching HTTP(S) origin. |
| Production-required | `NODE_ENV`, `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM` | `NODE_ENV=production` enables Production behavior. In Production, every SMTP field is required and its port/secure forms are validated. |
| Feature-required | `TMDB_READ_ACCESS_TOKEN` | The server can start without it, but TMDB-backed routes return a safe unavailable response. A Production release must retain it. |
| Platform-provided | `PORT` | Render supplies the listening port; local fallback is `3000`. |

The current Render service exposes every application-managed name above. No linked environment group or existing secret file was observed. `PORT` is platform-managed. The RC adds no additional Socket.IO variable; realtime uses the same HTTP server and `FRONTEND_ORIGIN` CORS boundary.

The service commands match `backend/package.json`: `npm run build` compiles TypeScript and `npm start` runs `dist/server.js`. The package requires Node `>=24 <25` and npm `>=11`; Render supports resolving a bounded `package.json` engine range. Before release, verify the resolved build runtime in the deploy log. No environment values are changed as part of repository migration.

## Gate C: database and index safety

Startup connects to `DB_URL` with Mongoose `autoIndex: false` and `autoCreate: false`; deployment commands do not invoke the migration runner. Gate C's current database/index work is closed by the accepted Phase 11 Batch 2 migration and recovery evidence: the bounded REV-02 DDL was applied once, independent reconciliation returned `NO_OP`, the verified recovery point remains preserved, and Production recovery completed. Evidence limitations remain explicit: `reversesDecisionId_1` preservation is supported by the allowlisted mutation scope, not a separate direct-name readback, and unauthorized-document safety is supported by the create-DDL-only runner scope rather than a full-database document comparison.

Batch 3 does not reopen Gate C and does not authorize another database connection or migration. A material candidate change to declared schema, indexes, startup initialization, or migration invocation would invalidate this reuse and require a new evidence decision before release.

## Selected release model

No Render workflow is added. Deploy-hook URLs and API keys are additional Production secrets with replay or leakage risk, and the available Render integration does not provide a safer one-person release boundary than the Dashboard.

The public binding is already active. With Auto Deploy off, use **Manual Deploy → Deploy a specific commit** and provide the reviewed public SHA. Do not use **Deploy latest commit** because branch head can move between review and release.

For every release, record the public source SHA, Render deployment ID, trigger, status, start/finish timestamps, and backend smoke result from Render's deployment history. Recheck Auto Deploy is off before and after the action.

## Future activation sequence

These steps require separate authorization and must not be executed from this preparation batch.

1. Verify the exact isolated candidate digest, manifest and reused Batch 2 evidence.
2. Record the pre-release baseline: public `main`, current Pages deployment/source, Render repository/branch/root, Auto Deploy state, live deploy ID/SHA/status, and frontend/backend fingerprints.
3. Confirm the non-secret repository variable `VITE_API_BASE_URL` remains suitable for the approved frontend build. GitHub Pages source is already GitHub Actions.
4. Publish only the approved candidate to public `main`. Record and freeze the resulting public SHA. Verify the push caused no Render deployment and no Pages deployment because the checked-in Pages workflow is manual-only.
5. Revalidate that the public SHA contains `backend/package.json`, the expected build/start scripts, the bounded Node/npm engines, and the approved backend source. Reconfirm all Render environment names and masked-value shape checks. Do not alter values.
6. Confirm the Render service has no deploy in progress and Auto Deploy is off. Obtain explicit authorization naming the exact public SHA.
7. In Render Dashboard, use **Manual Deploy → Deploy a specific commit** for that exact SHA on the existing `jing913/movune`, `main`, `backend` binding.
8. Observe that single deployment. If another deploy appears, the commit differs, Auto Deploy changes, or configuration drifts, stop; do not trigger a compensating deploy.
9. When live, record the public SHA and Render deployment metadata, verify Auto Deploy remains off, and smoke-test `/api/health`, `/`, CORS from the public frontend origin, authentication, TMDB proxy behavior, and one authenticated Socket.IO connection without exercising unreleased features.
10. Independently authorize the frontend release if desired. Dispatch the manual Pages workflow from the exact approved `main` SHA; record the workflow run ID, Pages deployment, and frontend smoke result. A backend-only release may stop after step 9, and a frontend-only later release does not touch Render.
11. Complete Production acceptance and compare both sides with the recorded baseline. Save the final frontend SHA/run ID and backend SHA/deploy ID/status/timestamps. Ordinary later pushes remain non-deploying.

After migration, each later backend release starts from a reviewed public SHA and uses **Deploy a specific commit**. A new repository rebind is not part of routine release.

## Failure and rollback

Stop on a wrong SHA, unexpected deployment, configuration drift, failed health check, authentication/CORS regression, database/index error, or material smoke failure. Do not combine rollback with unrelated configuration changes.

The known-good application reference is deploy `dep-dblipsbncjis73dvsv60` at commit `38d6415bbf94d188334f854282d5d439dc082951`. Confirm that retained artifact is still available before release. If release acceptance fails and its database compatibility remains certain, use the separately authorized Render rollback to that exact deploy and record the new rollback deployment. If the artifact is unavailable or database compatibility is uncertain, stop for a separately reviewed recovery decision.

Render rollback restores the selected deploy's build artifact and selected deploy configuration, but it does not reverse database writes or guarantee compatibility with indexes or data written by the failed release. If database compatibility is uncertain, keep traffic on the known-good application, stop, and execute the database recovery plan authorized by Gate C. A code rollback must not be represented as a database rollback.

## Official behavior basis

Verified on 2026-09-17 against current official documentation:

- [Deploying on Render](https://render.com/docs/deploys): Auto Deploy off, manual latest/specific-commit deploys, deployment history, and zero-downtime behavior.
- [Change a service's backing repo or image](https://render.com/changelog/change-your-services-backing-repo-or-image-in-the-render-dashboard): a backing-source change automatically triggers a deploy.
- [Monorepo support](https://render.com/docs/monorepo-support): root-directory command and file scope.
- [Environment variables and secrets](https://render.com/docs/configure-environment-variables): environment update/deploy behavior.
- [Deploy hooks](https://render.com/docs/deploy-hooks): hook secrecy and commit-ref support; hooks are deliberately not selected.
- [Rollbacks](https://render.com/docs/rollbacks): retained-artifact rollback behavior and configuration/database limitations.
- [Setting the Node.js version](https://render.com/docs/node-version): bounded `package.json` engine resolution.
- [Mongoose schemas](https://mongoosejs.com/docs/guide.html#indexes): default automatic index creation and Production impact.

## Open activation risks

- The next public candidate commit SHA does not exist until an authorized commit is created; do not substitute the local content digest for a Git SHA.
- Batch 2 Gate C evidence is reusable only while the candidate preserves the accepted schema, DDL and startup boundaries.
- The current Render service has no configured health-check path even though the RC exposes `/api/health`; changing that setting is outside this preparation and may itself trigger a deploy.
- The candidate is not remote, so Render cannot select its future public commit until the authorized publication step creates and verifies that SHA.
- Render build-artifact retention is plan-dependent; rollback availability must be rechecked immediately before activation.

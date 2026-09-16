# Controlled Production release runbook

This runbook defines a future release boundary for Movune. It is preparation only: the public release candidate is local, the Render service is still bound to the private development repository, GitHub Pages still uses its existing branch source, and no step in this document has been executed.

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
| Repository | `jing913/movune-source` | `jing913/movune` |
| Branch | `demo/ui-preview` | `main` |
| Root directory | `backend` | `backend` |
| Build command | `npm ci --include=dev && npm run build` | unchanged |
| Start command | `npm start` | unchanged |
| Runtime / region | Node / Singapore | unchanged |
| Auto Deploy | off | off |
| Known-good backend | commit `ec13281aef2995666111bd21a6e0dabd890754e3`, deploy `dep-daf9r9p7lnhs73ffhr10` | record a new public SHA only after release |

Current public `main` is `5c58dc7d7f9c9d2e0b33f87db861dc08f5a4e928`. The local candidate is not yet a remote release source.

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

Source inspection found no migration command, pre-deploy command, seed operation, destructive startup write, or dependency on post-candidate private work. Startup connects to `DB_URL` before listening.

The models do declare collections plus unique, TTL, and compound indexes. The RC does not set Mongoose `autoIndex` or `autoCreate` off. Mongoose documents automatic model initialization/index creation as the default and warns that index builds can significantly affect a Production database. Therefore the first RC backend release is blocked until Gate C records all of the following without running application integration tests against Production:

1. compare every RC-declared index with the Production database's existing indexes;
2. check unique-index candidates for duplicate data and TTL/index option conflicts;
3. estimate index-build load and choose a controlled maintenance window if any index is missing;
4. decide whether indexes will be created explicitly before release or whether a reviewed code/config change will disable automatic creation;
5. confirm rollback data compatibility and record a database backup/recovery point where available.

Gate C is not satisfied by a successful build. It is a release blocker until an authorized database review closes it.

## Selected release model

No Render workflow is added. Deploy-hook URLs and API keys are additional Production secrets with replay or leakage risk, and the available Render integration does not provide a safer one-person release boundary than the Dashboard.

The selected model has two phases:

- **Initial binding migration:** changing the backing repository is itself the explicitly authorized first backend release. Render's current documentation says this change automatically triggers a deploy. Public `main` must already equal the approved and frozen SHA before the binding is changed. Do not start a second manual deploy while the binding-triggered deploy is queued or running.
- **Subsequent releases:** with the public binding active and Auto Deploy off, use **Manual Deploy → Deploy a specific commit** and provide the reviewed public SHA. Do not use **Deploy latest commit** because branch head can move between review and release.

For every release, record the public source SHA, Render deployment ID, trigger, status, start/finish timestamps, and backend smoke result from Render's deployment history. Recheck Auto Deploy is off before and after the action.

## Future activation sequence

These steps require separate authorization and must not be executed from this preparation batch.

1. Complete M11 verification on the exact local candidate and close Gate C.
2. Record the pre-release baseline: public `main`, current Pages deployment/source, Render repository/branch/root, Auto Deploy state, live deploy ID/SHA/status, and frontend/backend fingerprints.
3. Configure the public non-secret repository variable `VITE_API_BASE_URL`, then change GitHub Pages source from branch deployment to GitHub Actions. Confirm this settings change does not publish the candidate.
4. Publish and merge only the approved candidate to public `main`. Record and freeze the resulting public SHA. Verify the merge caused no Pages or Render deployment.
5. Revalidate that the public SHA contains `backend/package.json`, the expected build/start scripts, the bounded Node/npm engines, and the approved backend source. Reconfirm all Render environment names and masked-value shape checks. Do not alter values.
6. Confirm the Render service has no deploy in progress and Auto Deploy is off. Obtain explicit human authorization naming the exact public SHA and acknowledging that source rebinding immediately deploys it.
7. In Render Dashboard, change the backing source to `jing913/movune`, branch `main`, root directory `backend`; preserve Node runtime, build/start commands, environment configuration, and Auto Deploy off. This source change is the first controlled backend release action.
8. Observe the single automatically triggered deployment. If another deploy appears, the commit differs, Auto Deploy changes, or configuration drifts, stop; do not trigger a compensating deploy.
9. When live, record the public SHA and Render deployment metadata, verify Auto Deploy remains off, and smoke-test `/api/health`, `/`, CORS from the public frontend origin, authentication, TMDB proxy behavior, and one authenticated Socket.IO connection without exercising unreleased features.
10. Independently authorize the frontend release if desired. Dispatch the manual Pages workflow from the exact approved `main` SHA; record the workflow run ID, Pages deployment, and frontend smoke result. A backend-only release may stop after step 9, and a frontend-only later release does not touch Render.
11. Complete Production acceptance and compare both sides with the recorded baseline. Save the final frontend SHA/run ID and backend SHA/deploy ID/status/timestamps. Ordinary later pushes remain non-deploying.

After migration, each later backend release starts from a reviewed public SHA and uses **Deploy a specific commit**. A new repository rebind is not part of routine release.

## Failure and rollback

Stop on a wrong SHA, unexpected deployment, configuration drift, failed health check, authentication/CORS regression, database/index error, or material smoke failure. Do not combine rollback with unrelated configuration changes.

For the first release, the known-good reference is deploy `dep-daf9r9p7lnhs73ffhr10` at private-source commit `ec13281aef2995666111bd21a6e0dabd890754e3`. Render Dashboard can roll back to a retained successful deploy artifact; Dashboard rollback automatically disables Auto Deploy. Confirm the target artifact is still retained, then use **Rollback to this deploy** and record the new rollback deployment. If the artifact is unavailable, use a separately reviewed recovery plan rather than guessing at a public commit equivalent.

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

- Repository rebinding is confirmed to deploy immediately; it cannot be treated as a non-deploying setup step.
- Gate C remains open until Production index compatibility is reviewed.
- The current Render service has no configured health-check path even though the RC exposes `/api/health`; changing that setting is outside this preparation and may itself trigger a deploy.
- The public RC is not remote, so Render cannot validate access to `jing913/movune` or its commit until a later checkpoint.
- Render build-artifact retention is plan-dependent; rollback availability must be rechecked immediately before activation.

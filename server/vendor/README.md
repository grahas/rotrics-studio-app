# Vendored `@untether/client`

`untether-client-0.1.0.tgz` is the official Node client for the
[`grahas/untether`](https://github.com/grahas/untether) daemon, vendored as a
tarball because npm cannot install a package from a git subdirectory
(`@untether/client` lives at `clients/node/packages/client` in that repo).

- Built from untether commit: see `../../UNTETHER_COMMIT` (repo root) -
  currently `eea7df6b98c8022962be63e43df46783cfe886c6` (PR #6, "Node client
  libraries", merged on top of the Go daemon/management-UI/DexArm-profile
  work from PRs #3-#5).
- Rebuild with `node server/scripts/update-untether-client.js` any time
  `UNTETHER_COMMIT` is bumped. The script clones `grahas/untether` at that
  commit, runs `npm ci && npm run pack` inside `clients/node`, and copies the
  resulting tarball here, updating `server/package.json`'s
  `@untether/client` dependency path if the version changed.
- `server/package.json` depends on it via
  `"@untether/client": "file:vendor/untether-client-0.1.0.tgz"`.

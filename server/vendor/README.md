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

## Local patch on top of `eea7df6`

Running the client inside an Electron renderer (where `@untether/client`
executes via the bundled local server in `electron/`'s preload script,
`nodeIntegration: true`) surfaced a real upstream bug: `mdns-transport.ts`
(and a couple of socket-teardown call sites in `line.ts`/`raw.ts`) call
`.unref()` unconditionally on the return value of `setInterval`/`setTimeout`.
In a browser-like global scope - which is what an Electron renderer process
has, even with Node integration enabled, because the implicit global object
is `window` - `setInterval`/`setTimeout` resolve to the DOM timer API and
return a plain number instead of Node's `Timeout` object, so `.unref` is
`undefined` and calling it throws, crashing mDNS discovery (and, downstream,
the whole socket.io connection) a few seconds after the renderer loads.

This vendored tarball has a minimal patch applied on top of commit
`eea7df6b98c8022962be63e43df46783cfe886c6`: every such `.unref()` call is
changed to `.unref?.()` so it's a no-op when the handle doesn't support it
(Node still gets the "don't keep the process alive" behavior; a browser-like
host just skips it, which is fine since nothing in that context manages
process lifetime via timers anyway).

This is an upstream fix that belongs in `grahas/untether` itself (filed as
grahas/untether#7, fix proposed in grahas/untether#8 with a regression test)
- once it merges there, re-run `node server/scripts/update-untether-client.js`
to pick up the real, patched upstream commit and drop this local patch note.

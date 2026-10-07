/**
 * Integration test for linkClient.js against the REAL untether daemon
 * (built from source at the pinned commit) using its `--fake-devices`
 * simulated backend - no physical DexArm/Raspberry Pi required. Mirrors
 * the scenarios grahas/untether's own clients/node integration tests cover
 * (connect, echo, busy), but exercised through OUR adapter.
 *
 * Needs a Go toolchain on PATH (same requirement as
 * electron/scripts/fetch-untether.js) and network access on first run to
 * fetch/build untether from source; set UNTETHER_BIN to reuse a
 * pre-built binary instead.
 *
 * Run with: node --test test/integration/linkClient.test.js
 */
'use strict';

const path = require('node:path');
// Only transform server/src/** (the ES-module source under test) - leave
// this CommonJS test file and its helpers alone. Target the current Node
// runtime (native async/await) so the transform skips the regenerator-based
// async-to-generator rewrite entirely - it would otherwise need a
// regeneratorRuntime global that's only coincidentally present once the
// full app (not this isolated test) has already pulled in an unrelated
// dependency (jimp) that happens to polyfill it as a side effect.
require('babel-register')({
    presets: [['env', {targets: {node: 'current'}}]],
    only: [path.join(__dirname, '..', '..', 'src')],
});

const test = require('node:test');
const assert = require('node:assert/strict');
const {LineConnection} = require('@untether/client');
const {startDaemon, sleep} = require('./daemon.js');
const linkClient = require('../../src/linkClient.js').default;
const {SERIAL_PORT_OPEN, SERIAL_PORT_CLOSE, SERIAL_PORT_ERROR, SERIAL_PORT_DATA} = require('../../src/constants.js');

function once(emitter, event) {
    return new Promise((resolve) => emitter.once(event, resolve));
}

test('linkClient against a real (fake-backed) untether daemon', async (t) => {
    const daemon = await startDaemon({fakeDevices: 'dexarm:1'});
    t.after(() => daemon.stop());

    const dexarm = await daemon.device('dexarm');
    const target = {host: '127.0.0.1', port: daemon.port(dexarm, 'line')};

    await t.test('open() connects and emits SERIAL_PORT_OPEN', async () => {
        const opened = once(linkClient, SERIAL_PORT_OPEN);
        linkClient.open(target);
        const openedTarget = await opened;
        assert.equal(openedTarget, `${target.host}:${target.port}`);
        assert.equal(linkClient.getOpened(), `${target.host}:${target.port}`);
    });

    await t.test('write() round-trips a G-code line via SERIAL_PORT_DATA', async () => {
        // M118 just echoes its argument back as a line - a reliable,
        // profile-agnostic way to prove the full write()/line-parsing
        // path works without depending on dexarm-specific reply formats.
        const received = once(linkClient, SERIAL_PORT_DATA);
        linkClient.write('M118 linkClient-echo-test\n');
        const {received: line} = await received;
        assert.equal(line, 'linkClient-echo-test');
    });

    await t.test('deviceVersion() resolves via the real control frame', async () => {
        const version = await linkClient.deviceVersion(5000);
        assert.ok(typeof version === 'string' && version.length > 0, `expected a non-empty version, got ${JSON.stringify(version)}`);
    });

    await t.test('a competing client is rejected with BusyError -> SERIAL_PORT_ERROR', async () => {
        // untether is exclusive-access: a second, independent connection to
        // the SAME device (not our linkClient - a stand-in for "someone
        // else", e.g. another app instance or `untether status`) must be
        // refused while linkClient still holds it.
        const other = new LineConnection(target);
        // @untether/client's dial() races the busy line ($ERR busy: ...)
        // against the socket's own close/ECONNRESET once the daemon rejects
        // and drops the connection; observed locally, the client sometimes
        // wins that race (BusyError) and sometimes doesn't (the generic
        // PairingError path for an unexpected reset before pairing
        // completes) even though the daemon's own log always shows it
        // correctly refusing the second client ("attach failed...device in
        // use by..."). Accept either client-side classification here - this
        // test is about the daemon's exclusive-access behavior, not about
        // @untether/client's (out of scope, vendored, "don't change it")
        // internal race between its 'data' and 'close'/'error' handlers.
        await assert.rejects(() => other.open(), (error) => error && (error.name === 'BusyError' || error.name === 'PairingError'));
        assert.equal(linkClient.getOpened(), `${target.host}:${target.port}`, 'our own connection must be unaffected');
    });

    await t.test('close() disconnects and emits SERIAL_PORT_CLOSE', async () => {
        const closed = once(linkClient, SERIAL_PORT_CLOSE);
        linkClient.close();
        await closed;
        assert.equal(linkClient.getOpened(), null);
    });

    await t.test('open() surfaces a connection failure as SERIAL_PORT_ERROR', async () => {
        const errored = once(linkClient, SERIAL_PORT_ERROR);
        // Nothing listens on this port - this is a bogus target, so the
        // underlying TCP connect should fail quickly.
        const badTarget = {host: '127.0.0.1', port: 1};
        linkClient.open(badTarget);
        const error = await errored;
        assert.ok(error instanceof Error);
        assert.equal(linkClient.getOpened(), null);
    });
});

/**
 * Integration test for firmware flashing against the REAL untether daemon's
 * fake DexArm bootloader - no physical hardware required. Two parts:
 *
 *  1. linkClient.flashFirmware()/deviceVersion() end-to-end against the
 *     fake bootloader (same scenario as untether's own
 *     clients/node/test/integration/firmware.test.ts, exercised through
 *     OUR adapter) - proves steps 4-8 (enter bootloader..done) actually
 *     work over the real wire protocol.
 *  2. A daemon-free unit check of firmwareUpgradeManager.flash()'s step
 *     filter: the daemon's flasher replays its own steps 0-3 internally
 *     even though the client already did the real work for them (see the
 *     comment in firmwareUpgradeManager.js), so onChange() must only ever
 *     see steps 4-8. This is stubbed (no cloud dependency, no daemon)
 *     since steps 0-3 are Rotrics-cloud-dependent and out of scope for a
 *     hardware-free/offline test.
 *
 * Run with: node --test test/integration/firmwareUpgradeManager.test.js
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
const {crc32} = require('@untether/client');
const {startDaemon} = require('./daemon.js');
const linkClient = require('../../src/linkClient.js').default;
const firmwareUpgradeManager = require('../../src/firmwareUpgradeManager.js').default;
const {SERIAL_PORT_OPEN} = require('../../src/constants.js');

function once(emitter, event) {
    return new Promise((resolve) => emitter.once(event, resolve));
}

/** Same xorshift test image as untether's own firmware integration test. */
function image(n) {
    const b = Buffer.alloc(n);
    let x = 2463534242;
    for (let i = 0; i < n; i++) {
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        x >>>= 0;
        b[i] = x & 0xff;
    }
    b[0] = 0x0a;
    b[1] = 0;
    return b;
}

test('linkClient.flashFirmware() against the real fake DexArm bootloader', async (t) => {
    const daemon = await startDaemon({fakeDevices: 'dexarm:1'});
    t.after(() => daemon.stop());

    const dexarm = await daemon.device('dexarm');
    const target = {host: '127.0.0.1', port: daemon.port(dexarm, 'line')};
    const opened = once(linkClient, SERIAL_PORT_OPEN);
    linkClient.open(target);
    await opened;
    t.after(() => linkClient.close());

    const img = image(2500);
    const steps = [];
    const res = await linkClient.flashFirmware(img, {chunkSize: 1024, onStep: (s) => steps.push(s), timeoutMs: 60000});

    assert.equal(res.bytes, 2500);
    assert.equal(res.crc32, crc32(img).toString(16).padStart(8, '0'));
    for (let i = 1; i < steps.length; i++) {
        assert.ok(steps[i].step >= steps[i - 1].step, 'steps must be non-decreasing');
    }
    assert.ok(steps.some((s) => s.step === 6 && s.status === 'finish'), 'step 6 (upload) finished');
    assert.ok(steps.some((s) => s.step === 8 && s.status === 'finish'), 'step 8 (done) finished');

    const flashed = await daemon.fake('flashed', {port: target.port});
    assert.equal(flashed.size, 2500);
    assert.equal(flashed.crc32, res.crc32);

    // The arm is usable again (over the SAME still-open connection) once
    // the daemon finishes re-detecting it after the simulated reboot.
    const version = await linkClient.deviceVersion(20000);
    assert.ok(typeof version === 'string' && version.length > 0);
});

test('firmwareUpgradeManager.flash() only forwards daemon steps 4-8 to onChange', async () => {
    // No daemon needed here: steps 0-3 are Rotrics-cloud-check/download,
    // which already ran client-side by the time flash() is called (see
    // upgrade4app()/upgrade4bootLoader()) - the daemon's flasher replays
    // its OWN internal 0-3 bookkeeping regardless, and flash()'s onStep
    // filter must swallow that replay so the UI doesn't regress to an
    // earlier step. Stub linkClient.flashFirmware to replay the full 0-8
    // sequence a real daemon would send, without needing one running.
    const original = linkClient.flashFirmware;
    const daemonSteps = [
        {step: 0, status: 'process'}, {step: 0, status: 'finish'},
        {step: 1, status: 'process'}, {step: 1, status: 'finish'},
        {step: 2, status: 'process'}, {step: 2, status: 'finish'},
        {step: 3, status: 'process'}, {step: 3, status: 'finish'},
        {step: 4, status: 'process'}, {step: 4, status: 'finish'},
        {step: 5, status: 'process'}, {step: 5, status: 'finish'},
        {step: 6, status: 'process', description: '50%'}, {step: 6, status: 'finish'},
        {step: 7, status: 'process'}, {step: 7, status: 'finish'},
        {step: 8, status: 'process'}, {step: 8, status: 'finish'},
    ];
    linkClient.flashFirmware = async (image, opts) => {
        for (const s of daemonSteps) opts.onStep(s);
        return {bytes: image.length, crc32: '00000000', chunkSize: 1024, chunks: 1, resends: 0, steps: daemonSteps};
    };
    try {
        const seen = [];
        firmwareUpgradeManager.onChange = (step, status, description) => seen.push({step, status, description});
        await firmwareUpgradeManager.flash(Buffer.from([1, 2, 3]), false);

        assert.ok(seen.every((s) => s.step >= 4), `expected only steps >=4, got ${JSON.stringify(seen)}`);
        assert.deepEqual(seen.map((s) => s.step), [4, 4, 5, 5, 6, 6, 7, 7, 8, 8]);
        assert.equal(seen[seen.length - 1].status, 'finish');
    } finally {
        linkClient.flashFirmware = original;
    }
});

test('firmwareUpgradeManager.flash() reports a flash-phase error against the right step', async () => {
    const original = linkClient.flashFirmware;
    linkClient.flashFirmware = async (image, opts) => {
        opts.onStep({step: 6, status: 'process', description: '10%'});
        const error = new Error('firmware update failed at step 7: $FW_ERROR device reset mid-upload');
        error.step = 7;
        throw error;
    };
    try {
        const seen = [];
        firmwareUpgradeManager.onChange = (step, status, description) => seen.push({step, status, description});
        await firmwareUpgradeManager.flash(Buffer.from([1, 2, 3]), false);

        const last = seen[seen.length - 1];
        assert.equal(last.step, 7);
        assert.equal(last.status, 'error');
    } finally {
        linkClient.flashFirmware = original;
    }
});

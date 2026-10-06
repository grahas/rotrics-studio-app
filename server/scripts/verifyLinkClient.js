'use strict';

// Standalone (non-CI) verification script: spins up a fake TCP server that
// mimics dexarm-link's wire protocol ($PAIR_CONFIRM -> $PAIR_OK, $PING ->
// $PONG, everything else echoed back prefixed with "ok ") and exercises
// linkClient.js end-to-end (open -> write -> data received -> close) to
// prove the client logic actually works against a real socket, not just
// that it compiles.
//
// Run with: node scripts/verifyLinkClient.js   (from server/)
//
// webpack (used for the production build) handles ESM import/export
// natively, but this is a raw Node script requiring the ESM source
// directly, so it needs its own transform.
require('babel-register')({presets: ['env']});

const net = require('net');
const assert = require('assert');

const linkClient = require('../src/linkClient.js').default;
const {
    SERIAL_PORT_OPEN,
    SERIAL_PORT_CLOSE,
    SERIAL_PORT_DATA,
    SERIAL_PORT_WRITE_OK,
} = require('../src/constants.js');

function startFakeDaemon() {
    return new Promise((resolve) => {
        const server = net.createServer((socket) => {
            let buffer = '';
            socket.on('data', (chunk) => {
                buffer += chunk.toString('utf8');
                let idx;
                while ((idx = buffer.indexOf('\n')) !== -1) {
                    const line = buffer.slice(0, idx).replace(/\r$/, '');
                    buffer = buffer.slice(idx + 1);
                    if (line === '$PAIR_CONFIRM') {
                        socket.write('$PAIR_OK\n');
                    } else if (line === '$PING') {
                        socket.write('$PONG\n');
                    } else if (line.length > 0) {
                        socket.write(`ok ${line}\n`);
                    }
                }
            });
        });
        server.listen(0, '127.0.0.1', () => resolve(server));
    });
}

async function main() {
    const server = await startFakeDaemon();
    const {port} = server.address();
    const target = {host: '127.0.0.1', port};

    const openEvents = [];
    const dataEvents = [];
    const writeOkEvents = [];
    linkClient.on(SERIAL_PORT_OPEN, (p) => openEvents.push(p));
    linkClient.on(SERIAL_PORT_DATA, (d) => dataEvents.push(d));
    linkClient.on(SERIAL_PORT_WRITE_OK, (d) => writeOkEvents.push(d));

    console.log('[verify] opening connection to fake daemon...');
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timed out waiting for SERIAL_PORT_OPEN')), 3000);
        linkClient.once(SERIAL_PORT_OPEN, () => {
            clearTimeout(timeout);
            resolve();
        });
        linkClient.open(target);
    });

    assert.strictEqual(linkClient.getOpened(), `${target.host}:${target.port}`, 'getOpened() should reflect the open target');
    assert.ok(linkClient.readLineParser, 'readLineParser should be non-null once connected');
    console.log('[verify] OK: open() paired and getOpened()/readLineParser reflect the connection');

    console.log('[verify] writing a G-code line...');
    const received = await new Promise((resolve) => {
        linkClient.once(SERIAL_PORT_DATA, (d) => resolve(d));
        linkClient.write('G28\n');
    });
    assert.strictEqual(received.received, 'ok G28', 'expected the echoed line back from the fake daemon');
    assert.strictEqual(writeOkEvents.length, 1, 'SERIAL_PORT_WRITE_OK should have fired once');
    console.log('[verify] OK: write()/SERIAL_PORT_DATA round-trip through the fake daemon matches expectations');

    console.log('[verify] closing connection...');
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('timed out waiting for SERIAL_PORT_CLOSE')), 3000);
        linkClient.once(SERIAL_PORT_CLOSE, () => {
            clearTimeout(timeout);
            resolve();
        });
        linkClient.close();
    });
    assert.strictEqual(linkClient.getOpened(), null, 'getOpened() should be null after close()');
    assert.strictEqual(linkClient.readLineParser, null, 'readLineParser should be null after close()');
    console.log('[verify] OK: close() resets state and emits SERIAL_PORT_CLOSE');

    server.close();
    console.log('\n[verify] All checks passed.');
    process.exit(0);
}

main().catch((error) => {
    console.error('[verify] FAILED:', error);
    process.exit(1);
});

/**
 * Test-only helper that starts the real `untether` daemon (built from
 * source, from the commit pinned in UNTETHER_COMMIT at the repo root) with
 * its `--fake-devices` simulated backend, so linkClient.js /
 * firmwareUpgradeManager.js can be exercised end-to-end without real
 * hardware. Mirrors grahas/untether's own
 * clients/node/test/integration/daemon.ts helper (same daemon, same
 * fake-devices flag), rewritten in plain CommonJS for this repo's test
 * runner (no TypeScript toolchain here).
 */
'use strict';

const {execFileSync, spawn} = require('child_process');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const CACHE_DIR = path.join(__dirname, '.cache');
const UNTETHER_SRC = path.join(CACHE_DIR, 'untether-src');
const COMMIT_FILE = path.join(REPO_ROOT, 'UNTETHER_COMMIT');
const UNTETHER_GIT_URL = 'https://github.com/grahas/untether.git';
const EXE = process.platform === 'win32' ? '.exe' : '';

let built;

function pinnedCommit() {
    return fs.readFileSync(COMMIT_FILE, 'utf8').trim();
}

/** Path of the untether binary: $UNTETHER_BIN, or built from source and cached per process. */
function untetherBinary() {
    if (process.env.UNTETHER_BIN) return process.env.UNTETHER_BIN;
    if (built) return built;
    const commit = pinnedCommit();
    // Reuse an already-checked-out sibling clone of grahas/untether at the
    // pinned commit if one is sitting next to this repo (convenient for
    // local/dev runs); otherwise fetch just that commit into our own cache.
    const siblingSrc = path.join(REPO_ROOT, '..', 'untether-src');
    let src = UNTETHER_SRC;
    if (fs.existsSync(path.join(siblingSrc, '.git')) &&
        execFileSync('git', ['rev-parse', 'HEAD'], {cwd: siblingSrc}).toString().trim() === commit) {
        src = siblingSrc;
    } else if (!fs.existsSync(path.join(UNTETHER_SRC, '.git')) ||
        execFileSync('git', ['rev-parse', 'HEAD'], {cwd: UNTETHER_SRC}).toString().trim() !== commit) {
        fs.rmSync(UNTETHER_SRC, {recursive: true, force: true});
        fs.mkdirSync(UNTETHER_SRC, {recursive: true});
        execFileSync('git', ['init', '-q'], {cwd: UNTETHER_SRC});
        execFileSync('git', ['remote', 'add', 'origin', UNTETHER_GIT_URL], {cwd: UNTETHER_SRC});
        execFileSync('git', ['fetch', '--depth', '1', 'origin', commit], {cwd: UNTETHER_SRC, stdio: 'inherit'});
        execFileSync('git', ['checkout', '-q', 'FETCH_HEAD'], {cwd: UNTETHER_SRC});
    }
    fs.mkdirSync(CACHE_DIR, {recursive: true});
    const out = path.join(CACHE_DIR, `untether${EXE}`);
    execFileSync('go', ['build', '-o', out, './cmd/untether'], {cwd: src, stdio: 'inherit'});
    if (!fs.existsSync(out)) throw new Error(`go build did not produce ${out}`);
    built = out;
    return out;
}

function freePort() {
    return new Promise((resolve, reject) => {
        const s = net.createServer();
        s.unref();
        s.on('error', reject);
        s.listen(0, '127.0.0.1', () => {
            const p = s.address().port;
            s.close(() => resolve(p));
        });
    });
}

async function getJson(url, init) {
    const r = await fetch(url, init);
    const text = await r.text();
    if (!r.ok) throw new Error(`${(init && init.method) || 'GET'} ${url}: HTTP ${r.status} ${text}`);
    return text ? JSON.parse(text) : undefined;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(what, fn, timeoutMs = 10000) {
    const until = Date.now() + timeoutMs;
    for (;;) {
        const v = await fn();
        if (v) return v;
        if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
        await sleep(50);
    }
}

/** Starts a daemon; retries with new ports if one was taken in the meantime (exit code 3). */
async function startDaemon(opts = {}) {
    const bin = untetherBinary();
    for (let attempt = 0; ; attempt++) {
        try {
            return await startOnce(bin, opts);
        } catch (err) {
            if (attempt >= 3 || !err.retry) throw err;
        }
    }
}

async function startOnce(bin, opts) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'untether-server-test-'));
    const cfgPath = path.join(dir, 'config.json');
    const statusPort = await freePort();
    fs.writeFileSync(cfgPath, JSON.stringify(Object.assign({
        tcpPort: await freePort(),
        endpointBasePort: await freePort(),
        deviceName: `server-test-${process.pid}`,
    }, opts.config)));
    const args = ['run', '--config', cfgPath, '--fake-devices', opts.fakeDevices || 'dexarm:1,loopback:1',
        '--status-listen', `127.0.0.1:${statusPort}`, '--watch-stdin', '--no-mdns', '--log-level', 'debug'];
    const child = spawn(bin, args, {stdio: ['pipe', 'pipe', 'pipe']});
    let log = '';
    child.stdout.on('data', (d) => { log += d; });
    child.stderr.on('data', (d) => { log += d; });
    child.stdin.on('error', () => {});
    let exitCode;
    const exited = new Promise((resolve) => child.once('exit', (code) => { exitCode = code; resolve(); }));
    const statusUrl = `http://127.0.0.1:${statusPort}`;

    const stop = async () => {
        if (exitCode === undefined) {
            child.stdin.end();
            const t = setTimeout(() => child.kill(), 5000);
            await exited;
            clearTimeout(t);
        }
        fs.rmSync(dir, {recursive: true, force: true});
    };

    const deadline = Date.now() + 20000;
    for (;;) {
        if (exitCode !== undefined) {
            fs.rmSync(dir, {recursive: true, force: true});
            const err = new Error(`untether exited with code ${exitCode}:\n${log}`);
            err.retry = exitCode === 3;
            throw err;
        }
        try {
            await getJson(`${statusUrl}/health`);
            break;
        } catch (error) {
            if (Date.now() > deadline) {
                await stop();
                throw new Error(`untether did not become healthy:\n${log}`);
            }
            await sleep(100);
        }
    }

    const devices = async () => (await getJson(`${statusUrl}/api/devices`)).devices;
    return {
        statusUrl,
        log: () => log,
        devices,
        async device(profile) {
            return waitFor(`connected ${profile} device`, async () =>
                (await devices()).find((x) => x.profile === profile && x.connected && (x.endpoints || []).length > 0));
        },
        port(dev, adapter) {
            const e = (dev.endpoints || []).find((x) => x.adapter === adapter);
            if (!e) throw new Error(`device ${dev.name} has no ${adapter} endpoint`);
            return e.port;
        },
        fake(action, body) {
            const url = `${statusUrl}/api/fake/${action}`;
            return action === 'state'
                ? getJson(url)
                : getJson(url, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body || {})});
        },
        stop,
    };
}

module.exports = {untetherBinary, freePort, waitFor, sleep, startDaemon};

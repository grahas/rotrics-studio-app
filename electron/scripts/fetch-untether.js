#!/usr/bin/env node
/**
 * Builds the `untether` Go binary (https://github.com/grahas/untether) for
 * bundling into the Electron app, so "USB mode" is just an Electron-spawned
 * local untether instance (see electron/main.js).
 *
 * Primary path: build from source for the pinned commit in UNTETHER_COMMIT
 * (repo root) with the Go toolchain, cross-compiling per electron-builder's
 * ${os}-${arch} resource macros (see electron/package.json "build.extraResources").
 * Fallback: `gh release download` if a matching GitHub release exists (none
 * is tagged yet at the time of writing, so this is untested but kept as a
 * documented escape hatch for when releases start shipping).
 *
 * Usage:
 *   node electron/scripts/fetch-untether.js            # build for the current host only (dev)
 *   node electron/scripts/fetch-untether.js --all       # build every shipped target (mac-x64, win-x64)
 *   node electron/scripts/fetch-untether.js --target=win-x64,mac-arm64
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync, execSync} = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const ELECTRON_DIR = path.join(REPO_ROOT, 'electron');
const RESOURCES_DIR = path.join(ELECTRON_DIR, 'resources', 'untether');
const COMMIT_FILE = path.join(REPO_ROOT, 'UNTETHER_COMMIT');
const UNTETHER_GIT_URL = 'https://github.com/grahas/untether.git';
const CACHE_DIR = path.join(ELECTRON_DIR, '.cache', 'untether-src');
const MODULE_PATH = 'github.com/grahas/untether';

// Targets electron-builder actually ships today (see package.json's
// build:mac-x64 / build:win-x64 scripts). Extend this list (and the
// electron-builder "mac"/"win" target arrays) if more platforms ship later.
const SHIPPED_TARGETS = ['mac-x64', 'win-x64'];

// electron-builder's ${os}/${arch} macros -> Go GOOS/GOARCH.
const TARGET_MAP = {
    'mac-x64': {goos: 'darwin', goarch: 'amd64'},
    'mac-arm64': {goos: 'darwin', goarch: 'arm64'},
    'win-x64': {goos: 'windows', goarch: 'amd64'},
    'win-arm64': {goos: 'windows', goarch: 'arm64'},
    'linux-x64': {goos: 'linux', goarch: 'amd64'},
    'linux-arm64': {goos: 'linux', goarch: 'arm64'},
};

function hostTarget() {
    const goos = {darwin: 'mac', win32: 'win', linux: 'linux'}[process.platform];
    const goarch = {x64: 'x64', arm64: 'arm64'}[process.arch];
    if (!goos || !goarch || !TARGET_MAP[`${goos}-${goarch}`]) {
        throw new Error(`Unsupported host platform/arch for a dev build: ${process.platform}/${process.arch}`);
    }
    return `${goos}-${goarch}`;
}

function parseArgs() {
    const args = process.argv.slice(2);
    if (args.includes('--all')) return SHIPPED_TARGETS.slice();
    const targetArg = args.find((a) => a.startsWith('--target='));
    if (targetArg) return targetArg.slice('--target='.length).split(',').map((s) => s.trim()).filter(Boolean);
    return [hostTarget()];
}

function run(cmd, args, options) {
    console.log(`$ ${cmd} ${args.join(' ')}`);
    execFileSync(cmd, args, Object.assign({stdio: 'inherit'}, options));
}

function hasGoToolchain() {
    try {
        execSync('go version', {stdio: 'ignore'});
        return true;
    } catch (error) {
        return false;
    }
}

function ensureSource(commit) {
    if (fs.existsSync(path.join(CACHE_DIR, '.git'))) {
        const head = execSync('git rev-parse HEAD', {cwd: CACHE_DIR}).toString().trim();
        if (head === commit) {
            console.log(`Reusing cached untether source at ${CACHE_DIR} (commit ${commit}).`);
            return;
        }
    }
    console.log(`Fetching grahas/untether@${commit} into ${CACHE_DIR} ...`);
    fs.rmSync(CACHE_DIR, {recursive: true, force: true});
    fs.mkdirSync(CACHE_DIR, {recursive: true});
    run('git', ['init', '-q'], {cwd: CACHE_DIR});
    run('git', ['remote', 'add', 'origin', UNTETHER_GIT_URL], {cwd: CACHE_DIR});
    run('git', ['fetch', '--depth', '1', 'origin', commit], {cwd: CACHE_DIR});
    run('git', ['checkout', '-q', 'FETCH_HEAD'], {cwd: CACHE_DIR});
}

function buildFromSource(target, commit) {
    const {goos, goarch} = TARGET_MAP[target];
    const outDir = path.join(RESOURCES_DIR, target);
    fs.mkdirSync(outDir, {recursive: true});
    const binName = goos === 'windows' ? 'untether.exe' : 'untether';
    const outFile = path.join(outDir, binName);
    const buildDate = new Date().toISOString();
    const ldflags = [
        '-s', '-w',
        `-X ${MODULE_PATH}/internal/version.Version=0.0.0-electron`,
        `-X ${MODULE_PATH}/internal/version.Commit=${commit}`,
        `-X ${MODULE_PATH}/internal/version.Date=${buildDate}`,
    ].join(' ');
    console.log(`Building untether for ${target} (GOOS=${goos} GOARCH=${goarch}) -> ${path.relative(REPO_ROOT, outFile)}`);
    run('go', ['build', '-trimpath', '-ldflags', ldflags, '-o', outFile, './cmd/untether'], {
        cwd: CACHE_DIR,
        env: Object.assign({}, process.env, {CGO_ENABLED: '0', GOOS: goos, GOARCH: goarch}),
    });
    if (goos !== 'windows') fs.chmodSync(outFile, 0o755);
}

function tryReleaseFallback(target) {
    console.log(`Attempting "gh release download" fallback for ${target} (no Go toolchain found) ...`);
    const outDir = path.join(RESOURCES_DIR, target);
    fs.mkdirSync(outDir, {recursive: true});
    const {goos, goarch} = TARGET_MAP[target];
    // Best-effort: goreleaser's default archive naming is
    // untether_<version>_<os>_<arch>(v<arm>)?.(tar.gz|zip); no release has
    // been tagged yet so this path is untested.
    const pattern = `*${goos}_${goarch}*`;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'untether-release-'));
    try {
        run('gh', ['release', 'download', '--repo', 'grahas/untether', '--pattern', pattern, '--dir', tmp]);
        const archive = fs.readdirSync(tmp)[0];
        if (!archive) throw new Error('no matching release asset found');
        console.log(`Downloaded ${archive}; extracting ...`);
        if (archive.endsWith('.zip')) {
            run('powershell', ['-NoProfile', '-Command', `Expand-Archive -Path '${path.join(tmp, archive)}' -DestinationPath '${tmp}' -Force`]);
        } else {
            run('tar', ['-xzf', path.join(tmp, archive), '-C', tmp]);
        }
        const binName = goos === 'windows' ? 'untether.exe' : 'untether';
        fs.copyFileSync(path.join(tmp, binName), path.join(outDir, binName));
        if (goos !== 'windows') fs.chmodSync(path.join(outDir, binName), 0o755);
        return true;
    } catch (error) {
        console.error(`Release fallback failed for ${target}: ${error.message}`);
        return false;
    } finally {
        fs.rmSync(tmp, {recursive: true, force: true});
    }
}

function main() {
    const commit = fs.readFileSync(COMMIT_FILE, 'utf8').trim();
    const targets = parseArgs();
    for (const target of targets) {
        if (!TARGET_MAP[target]) {
            console.error(`Unknown target "${target}". Known targets: ${Object.keys(TARGET_MAP).join(', ')}`);
            process.exit(2);
        }
    }

    const goAvailable = hasGoToolchain();
    if (goAvailable) {
        ensureSource(commit);
    } else {
        console.warn('Go toolchain not found on PATH; falling back to GitHub releases (untested, no release tagged yet).');
    }

    let failed = false;
    for (const target of targets) {
        try {
            if (goAvailable) {
                buildFromSource(target, commit);
            } else if (!tryReleaseFallback(target)) {
                failed = true;
            }
        } catch (error) {
            console.error(`Failed to produce untether binary for ${target}: ${error.message}`);
            failed = true;
        }
    }

    if (failed) {
        console.error('\nOne or more targets failed. Install Go (https://go.dev/dl/) to build from source, which is the primary supported path until untether ships tagged releases.');
        process.exit(1);
    }
}

main();

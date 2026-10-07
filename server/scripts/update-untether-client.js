#!/usr/bin/env node
/**
 * Rebuilds the vendored `@untether/client` tarball in `server/vendor/` from
 * a pinned commit of https://github.com/grahas/untether.
 *
 * Usage:
 *   node server/scripts/update-untether-client.js [commit-sha]
 *
 * If no commit is given, the SHA in `UNTETHER_COMMIT` (repo root) is used.
 * After this script runs successfully, re-run `npm install` in `server/` so
 * the (possibly renamed) tarball is picked up, and update the
 * `@untether/client` dependency path in `server/package.json` if the
 * package version changed.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const {execFileSync} = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const VENDOR_DIR = path.join(REPO_ROOT, 'server', 'vendor');
const COMMIT_FILE = path.join(REPO_ROOT, 'UNTETHER_COMMIT');
const UNTETHER_GIT_URL = 'https://github.com/grahas/untether.git';

function readPinnedCommit() {
    return fs.readFileSync(COMMIT_FILE, 'utf8').trim();
}

function run(cmd, args, options) {
    console.log(`$ ${cmd} ${args.join(' ')}`);
    execFileSync(cmd, args, Object.assign({stdio: 'inherit'}, options));
}

function main() {
    const commit = process.argv[2] || readPinnedCommit();
    if (!commit) {
        console.error('No commit SHA given and UNTETHER_COMMIT is empty.');
        process.exit(1);
    }

    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'untether-client-'));
    const srcDir = path.join(workDir, 'untether');
    console.log(`Cloning grahas/untether@${commit} into ${srcDir} ...`);
    try {
        fs.mkdirSync(srcDir, {recursive: true});
        run('git', ['init', '-q'], {cwd: srcDir});
        run('git', ['remote', 'add', 'origin', UNTETHER_GIT_URL], {cwd: srcDir});
        run('git', ['fetch', '--depth', '1', 'origin', commit], {cwd: srcDir});
        run('git', ['checkout', '-q', 'FETCH_HEAD'], {cwd: srcDir});

        const clientDir = path.join(srcDir, 'clients', 'node');
        console.log('Installing client workspace dependencies ...');
        run('npm', ['ci'], {cwd: clientDir});
        console.log('Packing @untether/client ...');
        run('npm', ['run', 'pack'], {cwd: clientDir});

        const produced = fs.readdirSync(clientDir).filter((f) => /^untether-client-.*\.tgz$/.test(f));
        if (produced.length !== 1) {
            throw new Error(`Expected exactly one untether-client-*.tgz in ${clientDir}, found: ${produced.join(', ') || '(none)'}`);
        }

        fs.mkdirSync(VENDOR_DIR, {recursive: true});
        for (const old of fs.readdirSync(VENDOR_DIR)) {
            if (/^untether-client-.*\.tgz$/.test(old)) {
                fs.unlinkSync(path.join(VENDOR_DIR, old));
            }
        }
        const dest = path.join(VENDOR_DIR, produced[0]);
        fs.copyFileSync(path.join(clientDir, produced[0]), dest);
        console.log(`Copied ${produced[0]} -> ${path.relative(REPO_ROOT, dest)}`);

        if (commit !== readPinnedCommit()) {
            fs.writeFileSync(COMMIT_FILE, commit + '\n');
            console.log(`Updated UNTETHER_COMMIT to ${commit}`);
        }

        console.log('\nDone. Remember to:');
        console.log('  1. Update the "@untether/client" file: path in server/package.json if the tarball name changed.');
        console.log('  2. Re-run `npm install` in server/.');
        console.log('  3. Update the commit note in server/vendor/README.md if needed.');
    } finally {
        fs.rmSync(workDir, {recursive: true, force: true});
    }
}

main();

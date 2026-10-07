const {app, BrowserWindow, shell, Menu, MenuItem, globalShortcut, powerSaveBlocker, dialog} = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const {spawn} = require('child_process');

// Spawns a local untether daemon (see https://github.com/grahas/untether) as
// a child process so "USB mode" is just another untether endpoint the
// renderer discovers via mDNS / the local status API, bound to this same
// machine. It's visually distinguishable in the discovery list only by its
// deviceName/host - the server/web side never special-cases it. The binary
// is bundled per-platform via electron-builder's extraResources (see
// package.json), produced ahead of time by electron/scripts/fetch-untether.js.

// untether's documented exit codes (see grahas/untether cmd/untether/main.go).
const UNTETHER_EXIT_ALREADY_RUNNING = 3; // another instance already owns the devices - not an error
const UNTETHER_EXIT_PORT_IN_USE = 4; // status port held by some other, non-untether program

let untetherProcess = null;
const untetherLogTail = [];

function pushLogTail(line) {
    untetherLogTail.push(line);
    if (untetherLogTail.length > 50) untetherLogTail.shift();
}

// Resolves the bundled binary: packaged apps get it from extraResources,
// dev mode reads straight out of electron/resources (as produced locally by
// `node electron/scripts/fetch-untether.js`, which defaults to the host
// platform/arch).
function untetherBinaryPath() {
    const ext = process.platform === 'win32' ? '.exe' : '';
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'untether', `untether${ext}`);
    }
    const devOs = {darwin: 'mac', win32: 'win', linux: 'linux'}[process.platform];
    const devArch = {x64: 'x64', arm64: 'arm64'}[process.arch];
    return path.join(__dirname, 'resources', 'untether', `${devOs}-${devArch}`, `untether${ext}`);
}

function ensureUntetherConfig(configPath) {
    if (fs.existsSync(configPath)) return; // only written on first run, see spec
    fs.mkdirSync(path.dirname(configPath), {recursive: true});
    const config = {
        deviceName: `${os.hostname()} (This Computer)`,
        startOnBoot: false,
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function startUntether() {
    const binPath = untetherBinaryPath();
    if (!fs.existsSync(binPath)) {
        console.error(`[untether] bundled binary not found at ${binPath}.`);
        console.error('[untether] in dev mode, run `node electron/scripts/fetch-untether.js` once, or start an untether instance manually ("USB mode" will be unavailable until one is reachable).');
        return;
    }

    const configDir = path.join(app.getPath('userData'), 'untether');
    const configPath = path.join(configDir, 'config.json');
    ensureUntetherConfig(configPath);

    untetherProcess = spawn(binPath, ['run', '--config', configPath, '--watch-stdin'], {
        stdio: ['pipe', 'pipe', 'pipe'],
    });
    untetherProcess.stdout.on('data', (data) => {
        const text = data.toString();
        pushLogTail(text.trimEnd());
        console.log(`[untether] ${text}`.trimEnd());
    });
    untetherProcess.stderr.on('data', (data) => {
        const text = data.toString();
        pushLogTail(text.trimEnd());
        console.error(`[untether] ${text}`.trimEnd());
    });
    untetherProcess.on('exit', (code, signal) => {
        console.log(`[untether] local daemon exited (code=${code}, signal=${signal})`);
        untetherProcess = null;
        if (code === UNTETHER_EXIT_ALREADY_RUNNING) {
            // Not an error: an already-running instance (e.g. an installed
            // service) owns the status port and the arms - the app will use
            // it via mDNS / the local status API exactly like any other
            // reachable untether instance.
            console.log('[untether] another untether instance already owns the status port; using it instead of spawning our own.');
            return;
        }
        if (code === UNTETHER_EXIT_PORT_IN_USE) {
            dialog.showErrorBox(
                'Rotrics Studio',
                'The local untether status port (127.0.0.1:8437) is in use by another program, so this app could not start its bundled USB-connection helper. '
                + 'Network-connected arms will still work; USB arms on this computer will not be discoverable until the conflicting program is closed.'
            );
            return;
        }
        if (code !== 0 && code !== null) {
            dialog.showErrorBox(
                'Rotrics Studio',
                `The bundled untether helper exited unexpectedly (code ${code}). USB-connected arms on this computer will not be discoverable.\n\nLast log lines:\n${untetherLogTail.join('\n')}`
            );
        }
    });
}

function stopUntether() {
    if (untetherProcess) {
        try {
            untetherProcess.stdin.end();
        } catch (error) {
            // ignore - process may already be exiting
        }
        untetherProcess.kill();
        untetherProcess = null;
    }
}

function setUpMenu() {
    Menu.getApplicationMenu().items.forEach(item => {
            if (item.role === 'viewmenu') {
                let submenu = [];
                item.submenu.items.forEach(item => {
                    if (item.role === 'forcereload' || item.role === 'toggledevtools') {
                        submenu.push(new MenuItem({
                            role: item.role, type: item.type, label: item.label, click: item.click
                        }));
                    }
                });

                Menu.setApplicationMenu(Menu.buildFromTemplate([new MenuItem({
                    role: item.role, type: item.type, label: item.label, click: item.click,
                    submenu: Menu.buildFromTemplate(submenu)
                })]));
            }
        }
    );
}

function createWindow() {
    setUpMenu();
    const mainWindow = new BrowserWindow({
        width: 1280,
        height: 768,
        minWidth: 850,
        minHeight: 400,
        webPreferences: {
            preload: path.join(__dirname, './build-server/startLocalServer.js')
        },
        devTools: true,
        nodeIntegration: true,
    });
    mainWindow.loadFile('./build-web/index.html')
    // mainWindow.webContents.openDevTools();

    // Open every external link in a new window of default OS browser
    // https://github.com/electron/electron/blob/master/docs/api/web-contents.md
    mainWindow.webContents.on('new-window', (event, url) => {
        event.preventDefault();
        shell.openExternal(url);
    });

    return mainWindow
}

let mainWindow = null

//https://github.com/electron/electron/issues/18397
app.allowRendererProcessReuse = false;

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
    startUntether();
    mainWindow = createWindow();
    app.on('activate', () => {
        // On macOS it's common to re-create a window in the app when the
        // dock icon is clicked and there are no other windows open.
        if (BrowserWindow.getAllWindows().length === 0) {
            createWindow();
        }
    })
});

// Quit when all windows are closed.
app.on('window-all-closed', () => {
    // On macOS it is common for applications and their menu bar
    // to stay active until the user quits explicitly with Cmd + Q
    if (process.platform !== 'darwin') {
        app.quit()
    }
});

app.on('will-quit', () => {
    stopUntether();
});

app.on("browser-window-focus", () => {
    // console.log('focus')

    // Mac环境下注册复制粘贴快捷键
    if (process.platform !== 'darwin' || !mainWindow) return
    globalShortcut.register('CommandOrControl+C', () => {
        // console.log('复制')
        mainWindow.webContents.copy()
    })

    globalShortcut.register("CommandOrControl+V", () => {
        // console.log('粘贴')
        mainWindow.webContents.paste();
    });
    // console.log('注册')
})

app.on("browser-window-blur", () => {
    // console.log('blur')
    globalShortcut.unregisterAll()
})

// 省电拦截器
const id = powerSaveBlocker.start('prevent-app-suspension')
console.log(`是否开启省电拦截器 ${powerSaveBlocker.isStarted(id)}`)

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.

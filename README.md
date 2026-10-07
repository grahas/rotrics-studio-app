**English** | [中文](README.zh-CN.md)

# Building Rotrics Studio App from Scratch

## 1. Installation and Configuration
Install java, python2.7, node (>=14.1.0)
Configure environment variables: python, java
Configure cnpm: https://developer.aliyun.com/mirror/NPM?from=tnpm
Install git bash (not needed on mac; on windows you need a linux terminal; git bash works well)

Compiling rotrics-scratch-blocks requires python2.7

Install Go (>=1.21) if you'll be running `electron/`: it's used to build the bundled [`untether`](https://github.com/grahas/untether) binary from source (see "Connecting to a DexArm" below). `server/` and `web/` don't need Go.

## 2. Clone the code and install dependencies
```bash
# clone repository, all three repositories must be placed under the same folder (this affects the copy_files.js script execution)
git clone https://github.com/Rotrics-Dev/rotrics-studio-app.git
git clone https://github.com/Rotrics-Dev/rotrics-scratch-vm.git
git clone https://github.com/Rotrics-Dev/rotrics-scratch-blocks.git

# npm is too slow, cnpm is recommended
cd rotrics-scratch-vm
cnpm install
npm link

cd rotrics-scratch-blocks
cnpm install
npm link

cd rotrics-studio-app/server
cnpm install

cd rotrics-studio-app/web
cnpm install

cd rotrics-studio-app/electron
#electron is used for packaging, it's special and must be installed using npm; cnpm and npm are not the same;
#if installed with cnpm, the packaged app will open extremely slowly; please be patient, it may take half an hour
npm install
```

## 3. Other
Compile rotrics-scratch-blocks:
for mac: npm run prepublish-mac
for win: npm run prepublish-win

Copy files
cd rotrics-studio-app/web
Create a new folder: build-web, and copy web/index.html into build-web

## 4. Running in the development environment
```bash
cd rotrics-studio-app/server
npm start

cd rotrics-studio-app/web
npm start
##if everything is working, you should be able to see the page displayed normally at: http://localhost:8080/  
``` 
Dev-mode server/web don't bundle or spawn anything - see "Connecting to a DexArm" below for how to get a DexArm connection target while developing outside Electron.

## 5. Running in the Electron environment
```bash
cd rotrics-studio-app/server
npm run build

cd rotrics-studio-app/web
npm run build

cd rotrics-studio-app/electron
npm start
# first run (or a changed UNTETHER_COMMIT) builds the untether binary from
# source with Go; this can take a minute. See "Connecting to a DexArm" below.
```

## 6. Packaging Electron
```bash
cd rotrics-studio-app/electron
#for mac: 
#must be run on a mac computer
npm run build:mac-x64

#for win:
#must be run on a windows computer
npm run build:win-x64
```

# Project Structure Overview
Consists of three sub-projects, all of which are node projects
### web
The frontend part. After building, you get "index.html + js + resources"; when electron runs, it executes loadFile(index.html)
### server
The local server, which provides the web client with an http api and a socket connection, and then accesses the native layer
### electron
When running inside web, the local server uses a fixed address: http://localhost:9000
When running inside electron, the port is obtained dynamically, and the local server address is attached under window
so that the web client can retrieve it conveniently, since a socket connection and the http api have not been established yet
When electron executes main.js, it first starts the local server, and only after that succeeds does it load the index.html built from the web client

# Connecting to a DexArm
`server/` has no direct USB-serial code path anymore; it only ever speaks the [`untether`](https://github.com/grahas/untether) TCP protocol (`server/src/linkClient.js`), and discovers reachable arms via mDNS and untether's local status API (`server/src/discoveryManager.js`). "USB mode" is just an `untether` daemon instance that talks to the arm over serial on your behalf:

- **Packaged/Electron app**: `electron/main.js` bundles and spawns a local `untether` binary (fetched/built from source per-platform by `electron/scripts/fetch-untether.js`, run automatically before `npm start`/packaging) bound to `127.0.0.1:8437`, named `"<hostname> (This Computer)"`. It shows up in the connection dropdown like any other discovered device - there's no special-casing between a local and a remote (e.g. Raspberry Pi) instance.
- **Dev mode** (`npm start` in `server/`, outside Electron): nothing spawns `untether` for you. Run one manually against your DexArm's USB port, e.g. `untether run` (see grahas/untether's README for build/run instructions, or reuse `electron/scripts/fetch-untether.js`'s output binary) - the app will discover it the same way it discovers any other instance.
- Because `untether` is exclusive-access, only one client can hold an arm at a time; the connection dropdown shows arms already in use by another client as disabled.

## Notes
node: >=14.1.0
electron: >=9.0.0  
go: >=1.21 (electron/ only, to build the bundled untether binary)

electron and server's package.json dependencies must stay consistent
Under electron, node_modules must be installed using npm, not cnpm

Make sure the content of these two files stays consistent: server/src/constants.js and web/src/constants.js


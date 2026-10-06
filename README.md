**English** | [中文](README.zh-CN.md)

# Building Rotrics Studio App from Scratch

## 1. Installation and Configuration
Install java, python2.7, node (>=14.1.0)
Configure environment variables: python, java
Configure cnpm: https://developer.aliyun.com/mirror/NPM?from=tnpm
Install git bash (not needed on mac; on windows you need a linux terminal; git bash works well)

Compiling serialport and rotrics-scratch-blocks both require python2.7
Install the latest Visual Studio (choose the Professional edition) (required when compiling serialport)
When installing, make sure to select "Desktop development with C++" under the workload options
Otherwise you will get the error: "Visual Studio C++ core feature" missing

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
#recompile the native module (currently only serialport is used), to make sure it matches the electron node version;
#please be patient, it may take half an hour
npm run rebuild  
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

## 5. Running in the Electron environment
```bash
cd rotrics-studio-app/server
npm run build

cd rotrics-studio-app/web
npm run build

cd rotrics-studio-app/electron
npm start
# if you get a message that the serialport version does not match the electron node version, run: npm run rebuild
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

## Notes
node: >=14.1.0
electron: >=9.0.0  
serialport: >=9.0.0   

If you get a message that the serialport version does not match the electron node version, run: npm run rebuild
The serialport version that electron depends on must match the electron node version, so a rebuild is required
The dependencies in the package.json files of electron and server must stay consistent
Under electron, node_modules must be installed using npm, not cnpm

Make sure the content of these two files stays consistent: server/src/constants.js and web/src/constants.js

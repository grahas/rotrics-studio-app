[English](README.md) | **中文**

# 从零开始构建Rotrics Studio App

## 1.安装和配置
安装java，python2.7，node（>=14.1.0）     
配置环境变量：python，java      
配置cnpm：https://developer.aliyun.com/mirror/NPM?from=tnpm    
安装git bash（mac不需要安装；windows需要使用linux terminal；git bash比较好用）  

编译rotrics-scratch-blocks需要用到python2.7    

如果要运行`electron/`，请安装Go（>=1.21）：用于从源码构建内置的[`untether`](https://github.com/grahas/untether)二进制文件（见下方"连接DexArm"一节）。`server/`和`web/`不需要Go。
  
## 2.clone代码并安装依赖
```bash
# clone repository，必须三个repository都放在同一个文件夹下（影响copy_files.js脚本执行）
git clone https://github.com/Rotrics-Dev/rotrics-studio-app.git
git clone https://github.com/Rotrics-Dev/rotrics-scratch-vm.git
git clone https://github.com/Rotrics-Dev/rotrics-scratch-blocks.git

# npm太慢，推荐cnpm
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
#electron用于打包，特殊，需要使用npm安装；cnpm和npm并不相同；
#使用cnpm安装后，打包的软件打开速度特别慢；耐心等，可能需要半小时
npm install
```

## 3.其他
编译rotrics-scratch-blocks：  
for mac: npm run prepublish-mac  
for win: npm run prepublish-win  

复制文件  
cd rotrics-studio-app/web  
新建文件夹：build-web，并将web/index.html copy到build-web下  

## 4.开发环境下运行
```bash
cd rotrics-studio-app/server
npm start

cd rotrics-studio-app/web
npm start
##若一切正常，可以看到页面正常显示：http://localhost:8080/  
``` 
开发模式下server/web不会打包或启动任何进程 —— 开发时如何获得DexArm连接目标，见下方"连接DexArm"一节。

## 5.Electron环境下运行
```bash
cd rotrics-studio-app/server
npm run build

cd rotrics-studio-app/web
npm run build

cd rotrics-studio-app/electron
npm start
# 首次运行（或UNTETHER_COMMIT变更后）会用Go从源码构建untether二进制文件，
# 可能需要几分钟。见下方"连接DexArm"一节。
```

## 6.Electron打包
```bash
cd rotrics-studio-app/electron
#for mac: 
#必须在mac电脑上
npm run build:mac-x64

#for win:
#必须在windows电脑上
npm run build:win-x64
```

# 项目结构简述
包括三个子项目，都是node项目  
### web
前端部分, build后得到"index.html+js+资源"，electron运行时执行loadFile(index.html)
### server
local server, 给web端提供http api和socket connection，再访问native层  
### electron
web中运行时候，local server使用指定address：http://localhost:9000  
electron运行时，动态获取端口，并将local server address挂在window下  
方便web端获取，从未建立socket connect和使用http api  
electron执行main.js时候，先启动local server，成功后再加载web端build得到的index.html

# 连接DexArm
`server/`不再有任何直接的USB串口代码路径；它只通过[`untether`](https://github.com/grahas/untether)的TCP协议通信（`server/src/linkClient.js`），并通过mDNS和untether本地状态API发现可用的机械臂（`server/src/discoveryManager.js`）。"USB模式"其实就是一个代替你通过串口与机械臂通信的`untether`守护进程实例：

- **打包/Electron应用**：`electron/main.js`会内置并启动一个本地`untether`二进制文件（由`electron/scripts/fetch-untether.js`针对各平台从源码自动获取/构建，在`npm start`/打包前自动运行），绑定在`127.0.0.1:8437`，命名为`"<主机名> (This Computer)"`。它会像其他被发现的设备一样出现在连接下拉列表中——本地实例和远程实例（例如树莓派）之间没有任何特殊区分。
- **开发模式**（在`server/`下`npm start`，不经过Electron）：不会为你自动启动`untether`。请手动针对DexArm的USB端口运行一个实例，例如`untether run`（构建/运行说明见grahas/untether的README，或直接复用`electron/scripts/fetch-untether.js`生成的二进制文件）——应用会像发现其他实例一样发现它。
- 由于`untether`是独占访问的，同一时刻只能有一个客户端持有某个机械臂；已被其他客户端占用的机械臂会在连接下拉列表中显示为禁用状态。

## 注意事项
node: >=14.1.0
electron: >=9.0.0  
go: >=1.21（仅electron/需要，用于构建内置的untether二进制文件）

electron和server的package.json中的dependencies需要保持一致   
electron下，安装node_modules必须使用npm而不是cnpm  

要保证两个文件内容一致：server/src/constants.js和web/src/constants.js

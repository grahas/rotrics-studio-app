import fs from 'fs';
import path from 'path';
import isOnline from "is-online";
import request from 'request';
import linkClient from './linkClient.js';
import gcodeSender from "./gcode/gcodeSender.js";

/**
 * Firmware upgrade is now built on untether's dexarm-firmware plugin
 * ($FW_BEGIN/$FW_CHUNK/$FW_ACK/.../$FW_OK over the SAME already-open line
 * connection to the arm - see grahas/untether's clients/node/README.md and
 * profiles/dexarm.yaml). The daemon owns the byte-level transfer, the
 * device-side reboot into the bootloader, and re-detecting the arm as it
 * re-enumerates; this manager only still does what has to stay client-side:
 * checking preconditions (step 0), reading the current firmware/hardware
 * version (step 1), asking Rotrics' cloud API whether an upgrade is needed
 * and downloading the image if so (steps 2-3), then handing the image to
 * untether's flasher (steps 4-8).
 *
 * step/status/description keep the exact 0-8 / antd-Steps contract the web
 * firmware dialog already expects (see web/src/reducers/firmwareUpgrade.js):
 * 0 check, 1 versions, 2 cloud check, 3 download, 4 enter bootloader,
 * 5 reconnect, 6 upload (NN%), 7 execute, 8 done.
 */
class FirmwareUpgradeManager {
    constructor() {
        this.cache_dir = null;
        this.onChange = null;
    }

    /**
     * @param cache_dir 缓存目录，固件文件将下载到此目录
     * @param isInBootLoader 当前是否处于boot loader模式下（恢复模式：设备已经卡在bootloader时使用）
     * @param onChange 回调函数，onChange(step, status, description)
     * step: 和web/src/reducers/firmwareUpgrade保持一致
     * status: 和antd step保持一致 https://ant.design/components/steps-cn/
     * @returns {Promise<void>}
     */
    async start(cache_dir, isInBootLoader, onChange) {
        this.cache_dir = cache_dir;
        this.onChange = onChange;

        //step-0: Check
        //是否连接，是否正在发送gcode，网络是否可用
        this.onChange(0, 'process');
        if (!linkClient.getOpened()) {
            this.onChange(0, 'error', 'Connect DexArm first');
            return;
        }
        if (gcodeSender.curStatus !== "idle") {
            this.onChange(0, 'error', 'Stop g-code sending task first');
            return;
        }
        if (!(await isOnline())) {
            this.onChange(0, 'error', 'Network unavailable, please connect first');
            return;
        }

        if (isInBootLoader) {
            await this.upgrade4bootLoader();
        } else {
            await this.upgrade4app();
        }
    }

    async upgrade4app() {
        //step-1: Collect DexArm info
        this.onChange(1, 'process');
        const {firmwareVersion, hardwareVersion} = await this.getDeviceInfo4app();
        if (!firmwareVersion || !hardwareVersion) {
            this.onChange(1, 'error', 'Time out, please retry');
            return;
        }

        //step-2: Check need upgrade
        this.onChange(2, 'process');
        const {err: err4needUpgrade, url} = await this.isNeedUpgrade(firmwareVersion, hardwareVersion);
        if (err4needUpgrade) {
            this.onChange(2, 'error', err4needUpgrade);
            return;
        }
        if (!url) {
            this.onChange(2, 'finish', 'Firmware is up to date');
            return;
        }

        //step-3: Download firmware
        const buffer = await this.downloadAndRead(url);
        if (!buffer) return;

        //step-4..8: delegated to untether's $FW_* firmware plugin.
        await this.flash(buffer, false);
    }

    //跳过app模式下的版本探测：设备已经卡在bootloader下，不理解gcode
    async upgrade4bootLoader() {
        //step-1: Collect DexArm info
        this.onChange(1, 'process');
        const hardwareVersion = await this.getHardwareVersion4bootLoader();
        if (!hardwareVersion) {
            this.onChange(1, 'error', 'Time out, please retry');
            return;
        }
        //必须升级，因此指定firmwareVersion为老版本即可
        const firmwareVersion = "V2.1.1";

        //step-2: Check need upgrade
        this.onChange(2, 'process');
        const {err: err4needUpgrade, url} = await this.isNeedUpgrade(firmwareVersion, hardwareVersion);
        if (err4needUpgrade) {
            this.onChange(2, 'error', err4needUpgrade);
            return;
        }
        if (!url) {
            this.onChange(2, 'error', "url is null");
            return;
        }

        //step-3: Download firmware
        const buffer = await this.downloadAndRead(url);
        if (!buffer) return;

        //step-4..8: delegated to untether's $FW_* firmware plugin.
        await this.flash(buffer, true);
    }

    async downloadAndRead(url) {
        this.onChange(3, 'process');
        const {savedPath, err: err4downloadFirmware} = await this.downloadFirmware(this.cache_dir, url);
        if (err4downloadFirmware) {
            this.onChange(3, 'error', err4downloadFirmware);
            return null;
        }
        const buffer = fs.readFileSync(savedPath);
        if (buffer.length === 0) {
            this.onChange(3, 'error', 'Data is empty');
            return null;
        }
        this.onChange(3, 'finish');
        return buffer;
    }

    async flash(buffer, bootloader) {
        try {
            await linkClient.flashFirmware(buffer, {
                bootloader,
                onStep: (step) => {
                    //untether's flasher replays its own internal 0-3 steps
                    //(check/versions/cloud-check/download) for its own
                    //bookkeeping even though the client already did the
                    //real work for them above - forwarding those here would
                    //regress the UI back to an earlier step, so only steps
                    //4-8 (enter bootloader..done) come from the daemon.
                    if (step.step < 4) return;
                    this.onChange(step.step, step.status, step.description);
                },
            });
        } catch (error) {
            //BusyError/ConnectionClosedError/FirmwareError etc. - report
            //against whichever step the daemon last reported (falls back to
            //6, the long-running upload step, if it never got that far).
            const step = (error && typeof error.step === 'number' && error.step >= 4) ? error.step : 6;
            this.onChange(step, 'error', error.message);
        }
    }

    /**
     * 检查是否需要upgrade
     * @param firmwareVersion
     * @param hardwareVersion
     * @returns {err, url} 先判断err，再判断url；url为null，则表示不用升级，已经是最新版本；否则需要升级
     */
    async isNeedUpgrade(firmwareVersion, hardwareVersion) {
        const exe = () => {
            return new Promise(resolve => {
                const api = `http://api.rotrics.com/version/firmware/version?version=${firmwareVersion}&hardwareVersion=${hardwareVersion}`;
                const timerId = setTimeout(() => {
                    resolve({err: "request time out", url: null});
                }, 20000);
                request(api, (error, response, body) => {
                    clearTimeout(timerId);
                    if (error) {
                        resolve({err: "request error", url: null});
                        return;
                    }
                    if (!response) {
                        resolve({err: "response is null", url: null});
                        return;
                    }
                    if (response.statusCode !== 200) {
                        resolve({err: "response status code is not 200", url: null});
                        return;
                    }
                    //body:
                    //无新版本，则data=null
                    // {
                    //     "code": 200,
                    //     "message": "Success",
                    //     "data": {
                    //         "id": 8,
                    //         "version": "V2.1.3",
                    //         "hardwareVersion": "V3.1",
                    //         "status": 1,
                    //         "createUser": null,
                    //         "url": "https://rotrics.oss-cn-shenzhen.aliyuncs.com/frimware/69be4370-f7b5-4ca3-bec7-d12007c82989/Firmware_V2.1.3_For_Hardware_V3.1_20200521.bin",
                    //         "infos": [ ],
                    //         "createTime": 1594175130,
                    //         "updateTime": null
                    //     }
                    // }
                    const bodyJson = JSON.parse(body);
                    //已经是最新版本了
                    if (!bodyJson.data) {
                        resolve({err: null, url: null});
                        return;
                    }
                    if (!bodyJson.data.url) {
                        resolve({err: "url is null", url: null});
                        return;
                    }
                    resolve({err: null, url: bodyJson.data.url});
                });
            });
        };
        return await exe();
    }

    /**
     * 下载固件文件
     * @param url
     * @returns {err, savedPath, filename}
     */
    async downloadFirmware(cache_dir, url) {
        const exe = () => {
            return new Promise(resolve => {
                const timerId = setTimeout(() => {
                    resolve({
                        err: "time out",
                        savedPath: null,
                        filename: null
                    });
                }, 40000);
                const segments = url.split('/');
                const filename = segments[segments.length - 1];
                const savedPath = path.join(cache_dir, filename)
                let stream = fs.createWriteStream(savedPath);
                request(url).pipe(stream).on("close", (err) => {
                    clearTimeout(timerId);
                    if (err) {
                        resolve({
                            err: "download failed",
                            savedPath: null,
                            filename: null
                        });
                        return;
                    }
                    if (!fs.readFileSync(savedPath)) {
                        resolve({
                            err: "file not exist",
                            savedPath: null,
                            filename: null
                        });
                        return;
                    }
                    resolve({
                        err: null,
                        savedPath,
                        filename
                    });
                });
            });
        };
        return await exe();
    }

    //获取设备的固件，硬件版本号 (app模式)
    //firmware: untether的$DEVICE_VERSION控制帧（守护进程内部发送M2010并解析回复，见profiles/dexarm.yaml）
    //hardware: dexarm profile未提供对应的控制帧，和之前一样直接发送M2011并解析回复行
    async getDeviceInfo4app() {
        let firmwareVersion = null;
        try {
            const version = await linkClient.deviceVersion(10000); //例如"2.1.3"（控制帧的正则分组本身不含"V"前缀）
            firmwareVersion = version.startsWith('V') ? version : `V${version}`;
        } catch (error) {
            console.log("deviceVersion() failed: " + error.message);
        }

        const hardwareVersion = await this.readLine(10000, (line) => line.startsWith("Hardware "), (line) => {
            return line.replace("Hardware", "").replace("\r", "").trim();
        }, 'M2011\n');

        return {firmwareVersion, hardwareVersion};
    }

    /**
     * 发"a5"，若收到"Hardware Version:"，则表示在boot loader模式下
     * @returns {Promise<string|null>}
     */
    async getHardwareVersion4bootLoader() {
        return this.readLine(15000, (line) => line.startsWith("Hardware Version:"), (line) => {
            return line.replace("Hardware Version:", "").replace("\r", "").trim();
        }, 'a5');
    }

    //向linkClient写入data，等待匹配predicate的行并用extract提取结果；超时或连接未打开时返回null
    readLine(timeoutMs, predicate, extract, data) {
        return new Promise((resolve) => {
            const parser = linkClient.readLineParser;
            if (!parser) {
                resolve(null);
                return;
            }
            const onData = (line) => {
                console.log("readLine received line: " + line);
                if (predicate(line)) {
                    clearTimeout(timerId);
                    parser.removeListener('data', onData);
                    resolve(extract(line));
                }
            };
            const timerId = setTimeout(() => {
                parser.removeListener('data', onData);
                resolve(null);
            }, timeoutMs);
            parser.on('data', onData);
            linkClient.write(data);
        });
    }
}

const firmwareUpgradeManager = new FirmwareUpgradeManager();

export default firmwareUpgradeManager;

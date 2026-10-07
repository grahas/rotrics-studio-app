import EventEmitter from 'events';
import {Browser, fromStatusApi, mergeDevices, pickEndpoint, endpointAddress} from '@untether/client';
import {NETWORK_DEVICE_LIST_UPDATE} from "./constants.js"

// Where the Electron-bundled local untether instance listens (see
// electron/main.js / electron/scripts/fetch-untether.js). mDNS browsing
// alone can miss it (loopback/firewalled/virtual-adapter edge cases), so
// this is untether's own recommended pattern for a locally-bundled daemon:
// poll its loopback-only status API directly in addition to mDNS.
const LOCAL_STATUS_API_URL = 'http://127.0.0.1:8437';

// How long to wait before retrying the local status API after it couldn't
// be reached (daemon not started yet, or dev-mode without Electron - see
// README "Development" section).
const STATUS_API_RETRY_MS = 5000;

const toPayload = (device) => {
    const endpoint = pickEndpoint(device, 'line');
    return {
        id: device.id,
        // Always the TXT `deviceName`/status-API `name`, never the mDNS
        // instance label (which is capped at 63 bytes and may be
        // truncated) - see clients/node/README.md "Discovery".
        deviceName: device.name,
        host: endpoint ? endpointAddress(endpoint) : undefined,
        port: endpoint ? endpoint.port : undefined,
        model: device.profile,
        connected: device.connected,
        inUse: device.inUse,
        compatible: device.compatible,
        features: device.features,
    };
};

/**
 * Finds untether daemons (formerly dexarm-link) on the local network - the
 * ONLY way the app finds connection targets, whether that's the
 * Electron-bundled local instance or a remote Raspberry Pi one. Merges two
 * sources into one list, keyed by device id (armId/deviceId), emitting
 * NETWORK_DEVICE_LIST_UPDATE whenever either source changes:
 *  - mDNS/DNS-SD browsing (`_untether._tcp` and the legacy
 *    `_dexarm-link._tcp`), for remote devices.
 *  - the local status API (loopback-only), for the Electron-bundled
 *    instance, since mDNS may be blocked/unreliable on the same machine.
 */
class DiscoveryManager extends EventEmitter {
    constructor() {
        super();
        this.browser = null;
        this.statusApiWatcher = null;
        this.statusApiRetryTimer = null;
        this.mdnsDevices = new Map(); // id -> Device
        this.statusApiDevices = new Map(); // id -> Device
    }

    start() {
        if (this.browser) return; //already started

        this.browser = new Browser(); // defaults to _untether._tcp + _dexarm-link._tcp
        this.browser.on('up', (device) => this._updateFrom(this.mdnsDevices, device));
        this.browser.on('update', (device) => this._updateFrom(this.mdnsDevices, device));
        this.browser.on('down', (device) => this._removeFrom(this.mdnsDevices, device.id));
        this.browser.on('error', (error) => console.warn(`[discovery] mdns error: ${error.message}`));
        this.browser.start().catch((error) => console.warn(`[discovery] failed to start mDNS browser: ${error.message}`));

        this._connectStatusApi();
    }

    stop() {
        if (this.browser) {
            this.browser.close();
            this.browser = null;
        }
        if (this.statusApiWatcher) {
            this.statusApiWatcher.close();
            this.statusApiWatcher = null;
        }
        if (this.statusApiRetryTimer) {
            clearTimeout(this.statusApiRetryTimer);
            this.statusApiRetryTimer = null;
        }
        this.mdnsDevices.clear();
        this.statusApiDevices.clear();
    }

    _connectStatusApi() {
        fromStatusApi(LOCAL_STATUS_API_URL)
            .then((watcher) => {
                this.statusApiWatcher = watcher;
                for (const device of watcher.devices()) this._updateFrom(this.statusApiDevices, device);
                watcher.on('up', (device) => this._updateFrom(this.statusApiDevices, device));
                watcher.on('update', (device) => this._updateFrom(this.statusApiDevices, device));
                watcher.on('down', (device) => this._removeFrom(this.statusApiDevices, device.id));
                watcher.on('error', (error) => console.warn(`[discovery] status api error: ${error.message}`));
                watcher.on('offline', () => {
                    // the local instance stopped answering (quit/crash/not
                    // spawned yet) - drop whatever we only knew about
                    // through it; it reconnects forever on its own and
                    // will repopulate via the 'up' events above.
                    for (const id of [...this.statusApiDevices.keys()]) this._removeFrom(this.statusApiDevices, id);
                });
            })
            .catch(() => {
                // No local untether instance reachable yet - expected in
                // dev mode without Electron, or before the Electron child
                // process has finished starting up. Not an error; retry.
                this.statusApiRetryTimer = setTimeout(() => this._connectStatusApi(), STATUS_API_RETRY_MS);
            });
    }

    _updateFrom(map, device) {
        map.set(device.id, device);
        this._emitUpdate();
    }

    _removeFrom(map, id) {
        map.delete(id);
        this._emitUpdate();
    }

    _merged() {
        const byId = new Map();
        for (const device of this.mdnsDevices.values()) byId.set(device.id, device);
        for (const device of this.statusApiDevices.values()) {
            const existing = byId.get(device.id);
            byId.set(device.id, existing ? mergeDevices(existing, device) : device);
        }
        return [...byId.values()];
    }

    _emitUpdate() {
        this.emit(NETWORK_DEVICE_LIST_UPDATE, this._merged().map(toPayload));
    }

    getDevices() {
        return this._merged().map(toPayload);
    }
}

const discoveryManager = new DiscoveryManager();
discoveryManager.start();

export default discoveryManager;

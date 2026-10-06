import EventEmitter from 'events';
import {Bonjour} from 'bonjour-service';
import {NETWORK_DEVICE_LIST_UPDATE} from "./constants.js"

const SERVICE_TYPE = 'dexarm-link'; // bonjour-service browses this as _dexarm-link._tcp, matching dexarm-link's discovery.js

/**
 * Browses mDNS/DNS-SD for dexarm-link daemons advertising themselves on the
 * local network (see grahas/dexarm-link src/discovery.js) and keeps a live
 * list of currently-visible devices, emitting NETWORK_DEVICE_LIST_UPDATE
 * whenever a device appears or disappears.
 */
class DiscoveryManager extends EventEmitter {
    constructor() {
        super();
        this.bonjour = null;
        this.browser = null;
        this.devices = new Map(); // id -> {id, deviceName, host, port, model}
    }

    start() {
        if (this.bonjour) return; //already started

        this.bonjour = new Bonjour();
        this.browser = this.bonjour.find({type: SERVICE_TYPE});
        this.browser.on('up', (service) => this._onUp(service));
        this.browser.on('down', (service) => this._onDown(service));
    }

    stop() {
        if (this.browser) {
            this.browser.stop();
            this.browser = null;
        }
        if (this.bonjour) {
            this.bonjour.destroy();
            this.bonjour = null;
        }
        this.devices.clear();
    }

    _host(service) {
        return (service.addresses && service.addresses[0]) || service.host;
    }

    _id(service) {
        return `${this._host(service)}:${service.port}`;
    }

    _onUp(service) {
        const id = this._id(service);
        const txt = service.txt || {};
        this.devices.set(id, {
            id,
            deviceName: txt.deviceName || service.name,
            host: this._host(service),
            port: service.port,
            model: txt.model,
        });
        console.log(`[discovery] device up: ${id} (${txt.deviceName || service.name})`);
        this._emitUpdate();
    }

    _onDown(service) {
        const id = this._id(service);
        console.log(`[discovery] device down: ${id}`);
        this.devices.delete(id);
        this._emitUpdate();
    }

    _emitUpdate() {
        this.emit(NETWORK_DEVICE_LIST_UPDATE, Array.from(this.devices.values()));
    }

    getDevices() {
        return Array.from(this.devices.values());
    }
}

const discoveryManager = new DiscoveryManager();
discoveryManager.start();

export default discoveryManager;

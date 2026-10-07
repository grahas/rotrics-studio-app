import EventEmitter from 'events';
import {LineConnection, BusyError} from '@untether/client';
import {
    SERIAL_PORT_OPEN,
    SERIAL_PORT_CLOSE,
    SERIAL_PORT_ERROR,
    SERIAL_PORT_WRITE_ERROR,
    SERIAL_PORT_WRITE_OK,
    SERIAL_PORT_DATA,
} from "./constants.js"

/**
 * The app's only connection path to a DexArm: a TCP client to an untether
 * daemon (see grahas/untether, formerly dexarm-link). There is no direct
 * USB-serial code path in server/ anymore - "USB mode" is just an untether
 * instance bundled with the Electron app and spawned as a local child
 * process talking to 127.0.0.1 (see electron/main.js); from here it's
 * indistinguishable from a remote Raspberry-Pi instance.
 *
 * Same public interface the old serialPortManager.js exposed
 * (open/close/write/getOpened, same SERIAL_PORT_* events), so downstream
 * consumers (gcodeSender.js, gcodeSender2.js, deviceStateMonitor.js,
 * frontEndPositionMonitor.js) need no changes beyond the import path.
 *
 * This is a thin adapter over @untether/client's LineConnection, which
 * speaks the daemon's newline-framed wire protocol (lines starting with
 * '$' are control frames, e.g. $PAIR_CONFIRM/$PAIR_OK, $PING/$PONG;
 * everything else is raw G-code passed through verbatim) - see
 * grahas/untether's README and clients/node/README.md for the exact
 * wire/API details this adapter is built against.
 */
class LinkClient extends EventEmitter {
    constructor() {
        super();
        this.conn = null; // current LineConnection, non-null for the lifetime of one open() target
        this.target = null; // {host, port}

        // gcodeSender.js historically reached into serialPortManager's raw
        // node-serialport ReadlineParser (`.readLineParser.on('data', ...)`)
        // instead of the public SERIAL_PORT_DATA event. There's no real
        // serialport parser here anymore, so this is a thin proxy
        // EventEmitter that re-emits the same trimmed-line `data` payload
        // whenever we emit SERIAL_PORT_DATA, kept non-null only while
        // connected to match the `!linkClient.readLineParser` falsy check.
        this._readLineParserProxy = new EventEmitter();
        this.on(SERIAL_PORT_DATA, ({received}) => {
            this._readLineParserProxy.emit('data', received);
        });
    }

    get readLineParser() {
        return (this.conn && this.conn.isOpen) ? this._readLineParserProxy : null;
    }

    getOpened() {
        return (this.conn && this.conn.isOpen) ? `${this.conn.host}:${this.conn.port}` : null;
    }

    /**
     * @param target {{host: string, port: number}}
     */
    open(target) {
        //already connected/connecting to the same target
        if (this.conn && this.target && this.target.host === target.host && this.target.port === target.port) {
            if (this.conn.isOpen) {
                console.log(`The untether endpoint ${target.host}:${target.port} has been opened`);
                this.emit(SERIAL_PORT_OPEN, this.getOpened());
            }
            return;
        }

        //switching targets: close the previous connection first
        if (this.conn) {
            this.close();
        }

        this._openNew(target);
    }

    _openNew(target) {
        this.target = target;

        // reconnect:true replaces the hand-rolled TCP reconnection concerns
        // the old dexarm-link client had to manage itself (wifi roam/NAT
        // timeouts etc.): LineConnection retries with exponential backoff
        // on an unexpected drop and silently resumes on the SAME instance
        // (re-emitting 'connect') instead of forcing a brand-new open().
        // SERIAL_PORT_CLOSE is only emitted for an explicit close() or once
        // reconnection gives up for good - see the 'close' handler below.
        const conn = new LineConnection(target, {reconnect: true});
        this.conn = conn;

        conn.on('line', (line) => {
            this.emit(SERIAL_PORT_DATA, {received: line.trim()});
        });

        conn.on('connect', () => {
            console.log(`link client -> open: ${conn.host}:${conn.port}`);
            this.emit(SERIAL_PORT_OPEN, this.getOpened());
        });

        conn.on('disconnect', (error) => {
            // transient drop; LineConnection is attempting to reconnect
            // (reconnect:true) - nothing to do here beyond logging, a
            // successful reconnect re-fires 'connect' above.
            console.log(`link client -> disconnect: ${conn.host}:${conn.port}${error ? ': ' + error.message : ''}`);
        });

        conn.on('reconnecting', (attempt, delayMs) => {
            console.log(`link client -> reconnecting to ${conn.host}:${conn.port} (attempt ${attempt}, in ${delayMs}ms)`);
        });

        conn.on('close', (error) => {
            console.log(`link client -> close: ${conn.host}:${conn.port}${error ? ': ' + error.message : ''}`);
            if (this.conn === conn) {
                this.conn = null;
                this.target = null;
            }
            this.emit(SERIAL_PORT_CLOSE, `${conn.host}:${conn.port}`);
        });

        conn.on('error', (error) => {
            console.log(`link client -> error: ${conn.host}:${conn.port}: ${error.message}`);
            this.emit(SERIAL_PORT_ERROR, error);
        });

        conn.open().catch((error) => {
            if (this.conn === conn) {
                this.conn = null;
                this.target = null;
            }
            const message = error instanceof BusyError
                ? `Arm is in use by ${error.holder || 'another client'}`
                : error.message;
            console.log(`link client -> failed to open ${target.host}:${target.port}: ${message}`);
            this.emit(SERIAL_PORT_ERROR, new Error(message));
        });
    }

    close() {
        //don't reset this.conn/this.target here - let the 'close' listener
        //do it once the connection actually closes.
        if (this.conn) {
            this.conn.close();
        }
    }

    //data: string (one or more newline-separated G-code lines, with or without a trailing newline)
    write(data) {
        if (!this.conn || !this.conn.isOpen) {
            console.warn("Link client is closed");
            return;
        }
        try {
            const lines = String(data).split(/\r?\n/).filter((line) => line.length > 0);
            for (const line of lines) {
                this.conn.send(line);
            }
            this.emit(SERIAL_PORT_WRITE_OK, data);
        } catch (error) {
            console.error("write error: " + data);
            this.emit(SERIAL_PORT_WRITE_ERROR, error);
        }
    }

    /**
     * Delegate used by firmwareUpgradeManager.js to flash firmware over the
     * SAME already-open LineConnection (untether is exclusive-access, so
     * there's no separate "disconnect and reconnect the manager" dance
     * needed anymore - the daemon handles the arm-side reboot/
     * re-enumeration transparently while this TCP connection stays up).
     * @returns {Promise<import('@untether/client').FlashFirmwareResult>}
     */
    flashFirmware(image, opts) {
        if (!this.conn || !this.conn.isOpen) {
            return Promise.reject(new Error('Link client is closed'));
        }
        return this.conn.flashFirmware(image, opts);
    }

    /**
     * Delegate used by firmwareUpgradeManager.js: the DexArm firmware
     * version, reported by untether's $DEVICE_VERSION control frame (the
     * dexarm profile maps this to M2010 on the arm, see
     * grahas/untether/profiles/dexarm.yaml). Resolves to just the version
     * digits (e.g. "2.1.3"), without the "Firmware "/"V" prefixes the old
     * YMODEM code used to strip off the raw M2010 reply itself.
     * @returns {Promise<string>}
     */
    deviceVersion(timeoutMs) {
        if (!this.conn || !this.conn.isOpen) {
            return Promise.reject(new Error('Link client is closed'));
        }
        return this.conn.deviceVersion(timeoutMs);
    }
}

const linkClient = new LinkClient();

export default linkClient;

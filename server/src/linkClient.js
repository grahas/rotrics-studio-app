import EventEmitter from 'events';
import net from 'net';
import {
    SERIAL_PORT_OPEN,
    SERIAL_PORT_CLOSE,
    SERIAL_PORT_ERROR,
    SERIAL_PORT_WRITE_ERROR,
    SERIAL_PORT_WRITE_OK,
    SERIAL_PORT_DATA,
} from "./constants.js"

const PAIRING_TIMEOUT_MS = 5000;
// Periodic keepalive so a silently-dropped TCP connection (e.g. wifi roam,
// router NAT timeout) is detected instead of looking "open" forever. The
// daemon just replies $PONG and we don't do anything with it other than
// logging - this is purely a liveness probe.
const PING_INTERVAL_MS = 10000;

/**
 * The app's only connection path to a DexArm: a TCP client to a dexarm-link
 * daemon (see grahas/dexarm-link). There is no direct USB-serial code path
 * in server/ anymore - "USB mode" is just a dexarm-link instance bundled
 * with the Electron app and spawned as a local child process talking to
 * 127.0.0.1 (see electron/main.js); from here it's indistinguishable from
 * a remote Raspberry-Pi instance.
 *
 * Same public interface the old serialPortManager.js exposed
 * (open/close/write/getOpened, same SERIAL_PORT_* events), so downstream
 * consumers (gcodeSender.js, gcodeSender2.js, deviceStateMonitor.js,
 * frontEndPositionMonitor.js) need no changes beyond the import path.
 *
 * Wire protocol (see grahas/dexarm-link src/tcpServer.js):
 * - newline-delimited lines
 * - lines starting with '$' are control frames handled by the daemon
 *   ($PAIR_CONFIRM -> $PAIR_OK, $PING -> $PONG); everything else is raw
 *   G-code passed through verbatim to the serial port on the daemon side.
 */
class LinkClient extends EventEmitter {
    constructor() {
        super();
        this.socket = null;
        this.target = null; // {host, port}
        this.buffer = '';
        this.paired = false;
        this.pairingTimer = null;
        this.pingTimer = null;

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
        return (this.socket && this.paired) ? this._readLineParserProxy : null;
    }

    getOpened() {
        if (this.socket && this.paired) {
            return `${this.target.host}:${this.target.port}`;
        } else {
            return null;
        }
    }

    _clearTimers() {
        if (this.pairingTimer) {
            clearTimeout(this.pairingTimer);
            this.pairingTimer = null;
        }
        if (this.pingTimer) {
            clearInterval(this.pingTimer);
            this.pingTimer = null;
        }
    }

    _reset() {
        this._clearTimers();
        this.socket = null;
        this.target = null;
        this.buffer = '';
        this.paired = false;
    }

    /**
     * @param target {{host: string, port: number}}
     */
    open(target) {
        //already connected/connecting to the same target
        if (this.socket && this.target && this.target.host === target.host && this.target.port === target.port) {
            if (this.paired) {
                console.log(`The dexarm-link endpoint ${target.host}:${target.port} has been opened`);
                this.emit(SERIAL_PORT_OPEN, this.getOpened());
            }
            return;
        }

        //switching targets: close the previous connection first
        if (this.socket) {
            this.close();
        }

        this._openNew(target);
    }

    _openNew(target) {
        this.target = target;
        this.buffer = '';
        this.paired = false;

        const socket = new net.Socket();
        this.socket = socket;

        this.pairingTimer = setTimeout(() => {
            console.log(`link client -> pairing timeout: ${target.host}:${target.port}`);
            this.emit(SERIAL_PORT_ERROR, new Error('Pairing with dexarm-link timed out'));
            socket.destroy();
        }, PAIRING_TIMEOUT_MS);

        socket.on('connect', () => {
            console.log(`link client -> connected: ${target.host}:${target.port}, sending $PAIR_CONFIRM`);
            socket.write('$PAIR_CONFIRM\n');
        });

        socket.on('data', (chunk) => this._handleData(chunk));

        socket.on('close', () => {
            const wasPaired = this.paired;
            console.log(`link client -> close: ${target.host}:${target.port}`);
            this._reset();
            if (wasPaired) {
                this.emit(SERIAL_PORT_CLOSE, `${target.host}:${target.port}`);
            }
        });

        socket.on('error', (error) => {
            console.log(`link client -> error: ${target.host}:${target.port}: ${error.message}`);
            this.emit(SERIAL_PORT_ERROR, error);
        });

        socket.connect(target.port, target.host);
    }

    _handleData(chunk) {
        this.buffer += chunk.toString('utf8');

        let newlineIndex;
        // eslint-disable-next-line no-cond-assign
        while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) {
            const line = this.buffer.slice(0, newlineIndex).replace(/\r$/, '');
            this.buffer = this.buffer.slice(newlineIndex + 1);
            this._handleLine(line);
        }
    }

    _handleLine(line) {
        if (line.length === 0) return;

        if (line.startsWith('$')) {
            this._handleControlFrame(line);
            return;
        }

        this.emit(SERIAL_PORT_DATA, {received: line.trim()});
    }

    _handleControlFrame(line) {
        const [command] = line.split(/\s+/);
        switch (command) {
            case '$PAIR_OK':
                if (!this.paired) {
                    this.paired = true;
                    if (this.pairingTimer) {
                        clearTimeout(this.pairingTimer);
                        this.pairingTimer = null;
                    }
                    console.log(`link client -> open: ${this.target.host}:${this.target.port}`);
                    this.emit(SERIAL_PORT_OPEN, this.getOpened());
                    this.pingTimer = setInterval(() => {
                        if (this.socket && !this.socket.destroyed) {
                            this.socket.write('$PING\n');
                        }
                    }, PING_INTERVAL_MS);
                }
                break;
            case '$PONG':
                // keepalive response, nothing to do
                break;
            default:
                console.warn(`link client -> unknown control frame: ${line}`);
        }
    }

    close() {
        if (this.socket) {
            //don't reset state here - let the 'close' listener do it once the
            //socket actually closes, so it can still tell whether we were
            //paired (open) and emit SERIAL_PORT_CLOSE accordingly.
            this.socket.destroy();
        }
    }

    //data: string|Buffer|Array<number>
    write(data) {
        if (this.socket && this.paired) {
            this.socket.write(data, (error) => {
                if (error) {
                    console.error("write error: " + data);
                    this.emit(SERIAL_PORT_WRITE_ERROR, error);
                } else {
                    this.emit(SERIAL_PORT_WRITE_OK, data);
                }
            });
        } else {
            console.warn("Link client is closed");
        }
    }
}

const linkClient = new LinkClient();

export default linkClient;

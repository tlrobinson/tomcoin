
const BaseTransport = require("./base");

const jsonlines = require("jsonlines");
const { PassThrough } = require("stream");

const SERVERS = new Map;
let id = 0;

class StreamTransport extends BaseTransport {
  constructor(options, node) {
    super(options, node);
    this.address = options.address || id++;
  }

  connect(address) {
    return new Promise(resolve => {
      const peer = {
        input: new PassThrough({ objectMode: true }),
        output: new PassThrough({ objectMode: true }),
        address: address
      };
      SERVERS.get(address).emit("connect", {
        output: peer.input,
        input: peer.output,
        address: this.address
      });
      this._initOutgoingPeer(peer);
      // give time to exchange initial messages
      setTimeout(() => resolve(peer), 0);
    });
  }

  disconnect(peer) {
    return new Promise(resolve => {
      this._teardownPeer(peer);
      peer.input.on("end", resolve);
      peer.input.end();
      peer.output.end();
    });
  }

  start() {
    return new Promise(resolve => {
      SERVERS.set(this.address, this)
      this.on("connect", this._initIncomingPeer);
      resolve();
    });
  }

  stop() {
    return new Promise(resolve => {
      this.removeListener("connect", this._initIncomingPeer);
      resolve();
    });
  }
}

module.exports = StreamTransport;

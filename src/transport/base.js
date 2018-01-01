const EventEmitter = require("events");

class BaseTransport extends EventEmitter {
  constructor(options = {}, node = null) {
    super();
    this.options = options;
    this.node = node;
    this.peers = [];
  }

  send(message, peer) {
    return new Promise(resolve => {
      peer.output.write(message, resolve);
    });
  }

  _initIncomingPeer(peer) {
    this._initPeer(peer);
    peer.input.on("end", () => this.emit("client-disconnected", peer));
    this.emit("client-connected", peer);
  }

  _initOutgoingPeer(peer) {
    this._initPeer(peer);
    peer.input.on("end", () => this.emit("disconnected", peer));
    this.emit("connected", peer);
  }

  _initPeer(peer) {
    this.peers.push(peer);

    peer.input.on("end", () => {
      this._teardownPeer(peer);
    });
    peer.input.on("data", message => {
      this.emit("message", { message, peer });
    });
    peer.input.on("error", err => {
      console.log("SOCKET ERROR", err);
    });
    peer.output.on("error", err => {
      console.log("SOCKET ERROR", err);
    });
  }

  _teardownPeer(peer) {
    this.peers.splice(this.peers.indexOf(peer), 1);
  }
}

module.exports = BaseTransport;

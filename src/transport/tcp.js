
const BaseTransport = require("./base");

const net = require("net");
const url = require("url");
const jsonlines = require("jsonlines");

class TCPTransport extends BaseTransport {
  constructor(options, node) {
    super(options, node);
    this.address = `net:${options.host || "localhost"}:${options.port}`;
  }

  connect(address) {
    return new Promise(resolve => {
      const { hostname, port } = url.parse(address);
      const socket = net.createConnection(port, hostname, () => {
        const peer = { socket };
        this._initOutgoingPeer(peer);
        resolve(peer);
      });
    });
  }

  disconnect(peer) {
    return new Promise(resolve => {
      this._teardownPeer(peer);
      peer.socket.on("end", resolve);
      peer.socket.end();
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = net
        .createServer(socket => {
          this._initIncomingPeer({ socket });
        })
        .on("error", err => {
          console.log("SERVER ERROR", error);
        })
        .listen(this.options.port, resolve);
    });
  }

  stop() {
    return new Promise((resolve, reject) => {
      this.server.close(err => (err ? reject(err) : resolve()));
      return Promise.all(
        this.peers.map(
          peer =>
            new Promise(resolve => {
              peer.socket.on("close", resolve);
              peer.socket.end();
            })
        )
      );
    });
  }

  _initPeer(peer) {
    peer.input = peer.socket.pipe(jsonlines.parse());
    peer.output = jsonlines.stringify();
    peer.output.pipe(peer.socket);

    super._initPeer(peer);
  }
}

module.exports = TCPTransport;

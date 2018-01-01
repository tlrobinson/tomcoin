const BaseTransport = require("./base");

const websocket = require("websocket-stream");
const jsonlines = require("jsonlines");

class WebSocketTransport extends BaseTransport {
  constructor(options, node) {
    super(options, node);
    this.address = `ws:${options.host || "localhost"}:${options.port}`;
    this.options = options.server
      ? { server: options.server }
      : { port: options.port };
  }

  connect(address) {
    return new Promise((resolve, reject) => {
      const socket = websocket(address)
        .on("connect", () => {
          const peer = { socket, address };
          this._initOutgoingPeer(peer);
          resolve(peer);
        })
        .on("error", error => {
          reject(error);
        });
    });
  }

  disconnect(peer) {
    return new Promise(resolve => {
      peer.socket.on("close", resolve);
      peer.socket.end();
    });
  }

  start() {
    return new Promise((resolve, reject) => {
      this.server = websocket
        .createServer(this.options, (socket, request) => {
          this._initIncomingPeer({ socket, address: socket.url });
        })
        .on("error", error => {
          console.log("SERVER ERROR", error);
        })
        .on("listening", resolve);
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

    // https://github.com/websockets/ws/issues/1256
    peer.socket.on("error", error => {
      // console.log(error + "")
    });

    super._initPeer(peer);
  }
}

module.exports = WebSocketTransport;

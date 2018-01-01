import "babel-polyfill";

import React from "react";
import ReactDOM from "react-dom";

import "./index.css";
import registerServiceWorker from "./registerServiceWorker";

import Node from "./tomcoin/lib/node";
import WebSocketTransport from "./tomcoin/lib/transport/websocket";
import { generatePrivateKey } from "./tomcoin/lib/util";
Node.TRANSPORT = WebSocketTransport;

class Wallet extends React.Component {
  componentWillMount() {
    setInterval(() => {
      this.forceUpdate();
    }, 100);
  }

  _transfer() {
    try {
      this.props.node.transfer(
        { publicKey: this._pubKeyInput.value },
        Math.round(parseInt(this._amountInput.value, 10) * 100000000)
      );
      this._pubKeyInput.value = "";
      this._amountInput.value = "";
    } catch (e) {
      alert(e);
    }
  }

  render() {
    const { node } = this.props;
    const current = node.blocks.get(node.tip);
    return (
      <div style={{ margin: 10, padding: 10, border: "1px solid black" }}>
        <div>height={current && current.height}</div>
        <div>hash={current && current.hash}</div>
        <div>publicKey={node.publicKey}</div>
        <div>balance={node.balance() / 100000000}</div>
        <div style={{ margin: 10 }}>
          <div>
            publicKey: <input ref={i => (this._pubKeyInput = i)} />
          </div>
          <div>
            amount: <input ref={i => (this._amountInput = i)} />
          </div>
          <button onClick={() => this._transfer()}>Transfer</button>
        </div>
        <div>peers={node.transport.peers.map(({ address }) => address).join(", ")}</div>
        {node._mining == null ? (
          <button onClick={() => node.startMining()}>Start Mining</button>
        ) : (
          <button onClick={() => node.stopMining()}>Stop Mining</button>
        )}
      </div>
    );
  }
}

if (!window.localStorage["tomcoin-private-key"]) {
  window.localStorage["tomcoin-private-key"] = generatePrivateKey();
}

const node = window.node = new Node({
  privateKey: window.localStorage["tomcoin-private-key"],
  addnode: [
    (window.location.protocol === "https:" ? "wss:" : "ws:") + window.location.host
  ]
});
node.start();

ReactDOM.render(
  <div>
    <Wallet node={node} />
  </div>,
  document.getElementById("root")
);

// registerServiceWorker();

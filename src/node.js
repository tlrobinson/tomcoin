const {
  mine,
  sign,
  verify,
  hash,
  validateProofOfWork,
  stripTxSignatures,
  generatePrivateKey,
  getPublicKey
} = require("./util");

const bigInt = require("big-integer");
const Immutable = require("immutable");

const BLOCK_REWARD_INITIAL = 50 * 10 ** 8; // 5000000000 satoshis... or toms?
const BLOCK_REWARD_ERA_LENGTH = 210000; // 210000 blocks

const TARGET_BLOCK_TIME = 10000; // 10 seconds
const TARGET_PERIOD = 10; // 10 blocks
const TARGET_MAX_FACTOR = 4; // at most 4x or 0.25x

const MAX_CONNECTIONS = 8;

const SEED_ADDRESSES = [
  "wss:tomcoin.herokuapp.com",
  "wss:tomcoin1.herokuapp.com",
  "wss:tomcoin2.herokuapp.com",
  "wss:tomcoin3.herokuapp.com"
];

const GENESIS_BLOCK = {
  time: 1516127819161,
  nonce: 33862,
  previousblockhash: null,
  target: "0000800000000000000000000000000000000000000000000000000000000000",
  txs: [
    {
      inputs: [
        {
          coinbase:
            "The Times 03/Jan/2009 Chancellor on brink of second bailout for banks"
        }
      ],
      outputs: [
        {
          value: BLOCK_REWARD_INITIAL,
          scriptPubKey:
            "042ac6551267639e7f8c5abf2e2fe28eff5df022c2220c82ae3100b1a411b65058178112fc4eb6210a5fe9fc0dc7aa3a69e8118b197d4e7eb0bf69770696c34cc0"
        }
      ]
    }
  ]
};

if (GENESIS_BLOCK.nonce == null) {
  mine(GENESIS_BLOCK);
  console.log("genesis block:");
  console.log(JSON.stringify(GENESIS_BLOCK, null, 2));
}

if (
  !validateBlock(
    GENESIS_BLOCK,
    new Map(),
    GENESIS_BLOCK.target,
    GENESIS_BLOCK.txs[0].outputs[0].value
  )
) {
  console.log("genesis block invalid!");
}

class Node {
  constructor(options = {}) {
    this.options = options;

    this.privateKey = options.privateKey || generatePrivateKey();
    this.publicKey = options.publicKey || getPublicKey(this.privateKey);

    this.tip = null;
    this.blocks = new Map();

    this.mempool = new Map();
    this.utxos = new Immutable.Map();
    this.orphans = {};

    const addresses = options.connect || SEED_ADDRESSES.concat(options.addnode || [])
    // console.log("addresses", addresses)
    this.peers = new Map(addresses.map(address => [address, Date.now()]))

    this._addBlock(GENESIS_BLOCK);

    this.transport = new Node.TRANSPORT(options, this);
    this.transport.on("message", ({ message, peer }) => {
      this.log(peer.address + " sent \"" + message[0] + "\"")
      this.receive(message, peer)
    });
    this.transport.on("connected", peer => {
      this.log("connected to " + peer.address);
      this.send(["version", { address: options.address }], peer)
      this.send(["getaddr"], peer);
      this.send(["getblocks", this._getBlockLocator()], peer);
    });
    this.transport.on("client-connected", peer => {
      this.log(peer.address + " connected");
      this.send(["version", { address: options.address }], peer)
      this.send(["getblocks", this._getBlockLocator()], peer);
    });
    this.transport.on("disconnected", peer => {
      this.log("disconnected from " + peer.address);
    });
    this.transport.on("client-disconnected", peer => {
      this.log(peer.address + " disconnected");
    });
  }

  // mining methods

  mine(maxTries = Infinity) {
    const current = this.blocks.get(this.tip);
    const block = {
      nonce: null,
      target: this._getNextTarget(current),
      previousblockhash: this.tip,
      txs: [
        {
          inputs: [{ coinbase: [current.height + 1, "¯\\_(ツ)_/¯"] }],
          outputs: [
            {
              value: this._getNextReward(current),
              scriptPubKey: this.publicKey
            }
          ]
        },
        ...this.mempool.values()
      ]
    };
    if (mine(block, maxTries)) {
      if (this._addBlock(block)) {
        this.log("mined", hash(block).toString("hex"))
        this.broadcast(["block", block]);
        return block;
      } else {
        console.warn("mined invalid block?!", block);
      }
    }
    return null;
  }

  startMining() {
    if (this._mining == null) {
      this._mining = setInterval(() => {
        this.mine(1000);
      }, 0);
    }
  }

  stopMining() {
    if (this._mining != null) {
      clearInterval(this._mining);
      delete this._mining;
    }
  }

  // wallet methods

  balance() {
    return this.unspentOutputs().reduce(
      (balance, [outpoint, uxto]) => balance + uxto.value,
      0
    );
  }

  unspentOutputs() {
    return Array.from(this.utxos.entries()).filter(
      ([outpoint, uxto]) => this.publicKey === uxto.scriptPubKey
    );
  }

  transfer({ publicKey }, value) {
    const tx = {
      inputs: [],
      outputs: [{ value: value, scriptPubKey: publicKey }]
    };
    for (const [outpoint, utxo] of this.unspentOutputs()) {
      tx.inputs.push({
        outpoint: outpoint
      });
      value -= utxo.value;
      if (value === 0) {
        break;
      } else if (value < 0) {
        // change output
        tx.outputs.push({
          value: -value,
          scriptPubKey: this.publicKey
        });
        break;
      }
    }
    if (value > 0) {
      throw new Error("Insufficient funds");
    }
    // compute the signatures
    const signatures = tx.inputs.map(({ outpoint }) => {
      const uxto = this.utxos.get(outpoint);
      if (uxto.scriptPubKey !== this.publicKey) {
        throw new Error("Unknown public key");
      }
      return sign(tx, this.privateKey);
    });
    // add them to the inputs
    for (const [index, signature] of signatures.entries()) {
      tx.inputs[index].scriptSig = signature;
    }
    // add to our own mempool then broadcast to all peers
    if (this._addTransactionToMempool(tx)) {
      this.broadcast(["tx", tx]);
    } else {
      this.log("trying to send invalid tx", tx);
    }
  }

  // p2p methods

  start() {
    this._timer = setInterval(() => {
      // this.log("peers", this.options.address, this.transport.peers.length, "of", this.peers.size)
      this._connect()
    }, 10000)
    this._connect()
    return this.transport.start();
  }

  stop() {
    clearInterval(this._timer);
    this.stopMining();
    return this.transport.stop();
  }

  connect(peer) {
    return this.transport.connect(peer);
  }

  disconnect(peer) {
    return this.transport.disconnect(peer);
  }

  send(message, peer) {
    return this.transport.send(message, peer);
  }

  broadcast(message, excludePeer = null) {
    return Promise.all(
      this.transport.peers
        .filter(peer => peer !== excludePeer)
        .map(peer => this.send(message, peer))
    );
  }

  receive(message, peer) {
    const [type, ...args] = message;
    if (typeof this["receive_" + type] === "function") {
      this["receive_" + type](peer, ...args);
    } else {
      console.warn("received unknown message", message);
    }
  }

  _addAddress(address, time) {
    if (!this.options.connect) {
      this.peers.set(address, time);
    }
  }

  async _connect() {
    const available = new Set;
    for (const [address, time] of this.peers.entries()) {
      if (time - Date.now() < 60 * 60 * 1000) {
        available.add(address);
      }
    }
    for (const peer of this.transport.peers) {
      available.delete(peer.address);
    }
    for (const address of available) {
      if (this.transport.peers.length >= MAX_CONNECTIONS) {
        return;
      }
      try {
        await this.connect(address);
      } catch (e) {
        console.error("connect failed", address)
      }
    }
  }

  // incoming message handlers

  receive_version(peer, version) {
    this.send(["verack"], peer);
    if (version.address) {
      peer.address = version.address;
      this._addAddress(peer.address, Date.now)
      this.broadcast(["addr", [{ address: version.address, time: Date.now() }]], peer);
    }
  }
  receive_verack(peer) {
  }
  receive_addr(peer, addresses) {
    for (const { address, time } of addresses) {
      this._addAddress(address, time);
    }
  }
  receive_getaddr(peer) {
    const addresses = Array.from(this.peers).map(([address, time]) => ({ address, time }));
    this.send(["addr", addresses], peer);
  }

  receive_block(peer, block) {
    if (this._addBlock(block)) {
      this.log("block", hash(block).toString("hex"));
      this.broadcast(["block", block], peer);
    }
  }

  receive_tx(peer, tx) {
    if (this._addTransactionToMempool(tx)) {
      this.log("tx", hash(tx).toString("hex"));
      this.broadcast(["tx", tx], peer);
    }
  }

  async receive_getblocks(peer, locator) {
    // find the first block in the locator that's on our main chain
    let current;
    do {
      current = this.blocks.get(locator.shift());
    } while (locator.length > 0 && (!current || !current.main));
    // send every block after that
    while (current && current.next && current.next.main) {
      current = current.next;
      await this.send(["block", current.block], peer);
    }
  }

  // utilities

  log(...args) {
    console.log("[" + (this.transport && this.transport.address) + "]", ...args);
  }

  _addBlock(block) {
    const blockHash = hash(block).toString("hex");

    // don't process blocks we've already processed
    if (this.blocks.has(blockHash)) {
      return false;
    }

    const current = this.blocks.get(this.tip);
    const previous = this.blocks.get(block.previousblockhash);

    // if the block is an orphan (we don't know about its parent yet) keep track
    // of it and abort adding it for now
    if (block.previousblockhash != null && !previous) {
      this.orphans[block.previousblockhash] =
        this.orphans[block.previousblockhash] || [];
      this.orphans[block.previousblockhash].push(block);
      return false;
    }

    const previousUTXOs = previous ? previous.utxos : new Immutable.Map();
    if (
      !validateBlock(
        block,
        previousUTXOs,
        this._getNextTarget(previous),
        this._getNextReward(previous)
      )
    ) {
      delete this.orphans[blockHash];
      return false;
    }

    const next = {
      block: block,
      hash: blockHash,
      previous: previous,
      height: previous ? previous.height + 1 : 0,
      // HACK: this is insanely inefficient, to make reorgs easy just store a
      // snapshot of the utxos for each
      utxos: previousUTXOs.withMutations(utxos =>
        addBlock(block, utxos)
      )
    };
    this.blocks.set(next.hash, next);

    // process orphans that have this block as its previous block
    for (const orphan of this.orphans[next.hash] || []) {
      this._addBlock(orphan);
    }
    delete this.orphans[next.hash];

    if (!current || next.height > current.height) {
      if (next.previous !== current) {
        this.log("reorg");

        // mark reorg'd blocks main = true and set `next` pointer
        let ancestor = next.previous;
        while (!ancestor.main) {
          ancestor.main = true;
          ancestor.previous.next = ancestor;
          ancestor = ancestor.previous;
        }

        // mark abandoned blocks main = false
        let abandoned = current;
        while (abandoned && abandoned !== ancestor) {
          abandoned.main = false;
          abandoned = abandoned.previous;
        }

        // broadcast reorg'd blocks
        while (ancestor = ancestor.next) {
          this.broadcast(["block", ancestor.block]);
        }
      }

      // update the tip and UTXOs
      this.tip = next.hash;
      this.utxos = next.utxos;

      // set `main` to true and previous' `next` pointer
      next.main = true;
      if (next.previous) {
        next.previous.next = next;
      }

      cleanupMempool(this.mempool, this.utxos);

      return true;
    }

    return false;
  }

  _addTransactionToMempool(tx) {
    const txId = hash(tx).toString("hex");
    if (!this.mempool.has(txId)) {
      if (validateTransaction(tx, this.utxos)) {
        // FIXME: make sure this tx doesn't conflict with other txs in mempool
        this.mempool.set(txId, tx);
        return true;
      } else {
        this.log("received invalid tx", tx);
      }
    }
    return false;
  }

  _getNextTarget(current) {
    const PRECISION = 1000000;
    if (!current) {
      return GENESIS_BLOCK.target;
    } else if ((current.height + 1) % TARGET_PERIOD === 0) {
      // cache the target on the current block
      if (!current.nextTarget) {
        let start = current;
        for (let i = 0; i < TARGET_PERIOD - 1; i++) {
          start = start.previous;
        }
        const blockTime =
          (current.block.time - start.block.time) / TARGET_PERIOD;
        const adjustment = Math.min(
          TARGET_MAX_FACTOR,
          Math.max(1 / TARGET_MAX_FACTOR, TARGET_BLOCK_TIME / blockTime)
        );
        current.nextTarget = bigInt(current.block.target, 16)
          .multiply(PRECISION)
          .divide(Math.round(adjustment * PRECISION))
          .toString(16);
        this.log("retarget", current.height + 1, blockTime, "ms", adjustment);
      }
      return current.nextTarget;
    } else {
      return current.block.target;
    }
  }

  _getNextReward(current) {
    const height = current ? current.height + 1 : 0;
    const era = Math.floor(height / BLOCK_REWARD_ERA_LENGTH);
    return Math.round(BLOCK_REWARD_INITIAL / 2 ** era);
  }

  _getBlockLocator() {
    const hashes = [];
    let current = this.blocks.get(this.tip);
    let step = 1;
    while (current) {
      if (hashes.length >= 10) {
        step *= 2;
      }
      hashes.push(current.hash);
      for (let i = 0; i < step && current; i++) {
        current = current.previous;
      }
    }
    const genesisBlockHash = hash(Node.GENESIS_BLOCK).toString("hex");
    if (hashes[hashes.length - 1] !== genesisBlockHash) {
      hashes.push(genesisBlockHash);
    }
    return hashes;
  }
}

function validateTransaction(tx, utxos, maxCoinbaseOutput = null) {
  let value = 0;
  for (const output of tx.outputs) {
    value -= output.value;
  }

  if (maxCoinbaseOutput != null) {
    if (value > maxCoinbaseOutput) {
      console.log(
        "tx invalid: coinbase tx outputs should not be greater than 50"
      );
      return false;
    } else {
      return true;
    }
  }

  const txNoSignatures = stripTxSignatures(tx);
  for (const input of tx.inputs) {
    const utxo = utxos.get(input.outpoint);
    if (!utxo) {
      // console.log("tx invalid: missing utxo", input.outpoint, this.utxos);
      return false;
    }
    if (!verify(txNoSignatures, utxo.scriptPubKey, input.scriptSig)) {
      console.log("tx invalid: invalid signature");
      return false;
    }
    value += utxo.value;
  }

  if (value < 0) {
    console.log("tx invalid: outputs spend too much");
    return false;
  }

  return true;
}

function validateBlock(block, uxtos, target, reward) {
  if (!validateProofOfWork(hash(block), target)) {
    console.log("block invalid: insufficient proof of work");
    return false;
  }

  // coinbase transaction
  if (!validateTransaction(block.txs[0], uxtos, reward)) {
    console.log("block invalid: invalid coinbase tx");
    return false;
  }

  // other transactions
  for (const tx of block.txs.slice(1)) {
    if (!validateTransaction(tx, uxtos)) {
      console.log("block invalid: invalid tx");
      return false;
    }
  }

  return true;
}

function addBlock(block, utxos) {
  for (const [txIndex, tx] of block.txs.entries()) {
    const txId = hash(tx).toString("hex");
    // remove consumed utxos
    for (const [index, input] of tx.inputs.entries()) {
      utxos.delete(input.outpoint);
    }
    // add new utxos
    for (const [index, output] of tx.outputs.entries()) {
      utxos.set(txId + ":" + index, output);
    }
  }
  return utxos;
}

function cleanupMempool(mempool, utxos) {
  // remove other invalid transactions from mempool
  for (const [txId, tx] of mempool.entries()) {
    if (!validateTransaction(tx, utxos)) {
      mempool.delete(txId);
    }
  }
}

Node.GENESIS_BLOCK = GENESIS_BLOCK;

module.exports = Node;

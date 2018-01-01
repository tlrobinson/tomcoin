const Node = require("../src/node");
const { mine, hash, stripTxSignatures } = require("../src/util");

// function to add delay to methods
function addDelay(object, method, milliseconds = 10) {
  const original = object[method];
  object[method] = async function() {
    let result = await original.apply(this, arguments);
    await delay(milliseconds);
    return result;
  };
}

// add small delays to some methods to allow messages to propagate
addDelay(Node.prototype, "connect");
addDelay(Node.prototype, "mine");
addDelay(Node.prototype, "transfer");

// set the transport to use in-process streams
Node.TRANSPORT = require("../src/transport/stream");
// Node.TRANSPORT = require("../src/transport/websocket");
// Node.TRANSPORT = require("../src/transport/tcp");

// disable logging
Node.prototype.log = () => {};

// set the target much lower to make tests run faster
Node.GENESIS_BLOCK.target =
  "1000000000000000000000000000000000000000000000000000000000000000";
Node.GENESIS_BLOCK.time = 1516161788000;
Node.GENESIS_BLOCK.nonce = 38;
// mine(Node.GENESIS_BLOCK);

const GENESIS_BLOCK_HASH = hash(Node.GENESIS_BLOCK).toString("hex");

describe("Node", () => {
  let satoshi, hal, nick;

  beforeEach(async () => {
    satoshi = new Node({
      address: "satoshi",
      // if only this was actually satoshi's private key...
      privateKey:
        "6502f1762919a16f18309d5f2359294643e5c03aa8fd6620f40e1256b8799cf3",
      connect: []
    });
    hal = new Node({
      address: "hal",
      connect: []
    });
    nick = new Node({
      address: "nick",
      connect: []
    });
    await Promise.all([satoshi.start(), hal.start(), nick.start()]);
    await hal.connect(satoshi.transport.address);
  });

  afterEach(async () => {
    checkChain(satoshi);
    checkChain(hal);
    checkChain(nick);
    expect(satoshi.tip).toBe(hal.tip);
    await Promise.all([satoshi.stop(), hal.stop(), nick.stop()]);
  });

  it("should report correct initial balances", () => {
    expect(satoshi.balance()).toBe(5000000000);
    expect(hal.balance()).toBe(0);
  });

  it("should not mine duplicate (unspendable) coinbase tx ids", async () => {
    expect(satoshi.balance()).toBe(5000000000);
    await satoshi.mine();
    expect(satoshi.balance()).toBe(10000000000);
    await satoshi.mine();
    expect(satoshi.balance()).toBe(15000000000);
  });

  it("should mine", async () => {
    await satoshi.mine();
    expect(satoshi.balance()).toBe(10000000000);
    await hal.mine();
    expect(hal.balance()).toBe(5000000000);
    expect(satoshi.tip).not.toBe(GENESIS_BLOCK_HASH);
    expect(satoshi.tip).toBe(hal.tip);
    expect(satoshi.utxos.size).toEqual(3);
    expect(hal.utxos.size).toEqual(3);
  });

  it("should broadcast and mine a transaction", async () => {
    expect(satoshi.balance()).toBe(5000000000);
    expect(hal.balance()).toBe(0);
    expect(satoshi.mempool.size).toEqual(0);
    expect(hal.mempool.size).toEqual(0);
    expect(satoshi.utxos.size).toEqual(1);
    expect(hal.utxos.size).toEqual(1);
    await satoshi.transfer(hal, 1000000000);
    expect(satoshi.mempool.size).toEqual(1);
    expect(hal.mempool.size).toEqual(1);
    const tx = stripTxSignatures(hal.mempool.values().next().value);
    expect(tx).toEqual({
      inputs: [{ outpoint: satoshi.utxos.keys().next().value }],
      outputs: [
        { scriptPubKey: hal.publicKey, value: 1000000000 },
        { scriptPubKey: satoshi.publicKey, value: 4000000000 }
      ]
    });
    await satoshi.mine();
    expect(satoshi.balance()).toBe(9000000000);
    expect(hal.balance()).toBe(1000000000);
    expect(satoshi.mempool.size).toEqual(0);
    expect(hal.mempool.size).toEqual(0);
    expect(satoshi.utxos.size).toEqual(3);
    expect(hal.utxos.size).toEqual(3);
  });

  it("should reorg", async () => {
    await satoshi.mine();
    expect(satoshi.tip).toEqual(hal.tip);
    // simulate network delay
    satoshi.transport.peers[0].output.pause();
    // both mine a block at the same time
    await satoshi.mine();
    await hal.mine();
    // results in a temporary fork
    expect(satoshi.tip).not.toEqual(hal.tip);
    const abandoned = hal.tip;
    satoshi.transport.peers[0].output.resume();
    // still forked since both at same height
    expect(satoshi.tip).not.toEqual(hal.tip);
    // then one pulls ahead
    await satoshi.mine();
    // reorg
    expect(satoshi.tip).toEqual(hal.tip);
    // make sure correct blocks are marked as main chain
    expect(satoshi.blocks.get(satoshi.tip).main).toEqual(true);
    expect(hal.blocks.get(hal.tip).main).toEqual(true);
    expect(hal.blocks.get(abandoned).main).toEqual(false);
  });

  it("should do initial sync", async () => {
    await satoshi.disconnect(satoshi.transport.peers[0]);

    await satoshi.mine();
    expect(satoshi.tip).not.toEqual(GENESIS_BLOCK_HASH);
    expect(hal.tip).toEqual(GENESIS_BLOCK_HASH);

    await hal.connect(satoshi.transport.address);
    expect(hal.tip).toEqual(satoshi.tip);
  });

  it("should do initial sync between 3 nodes", async () => {
    satoshi.disconnect(satoshi.transport.peers[0]);

    await satoshi.mine();
    await satoshi.mine();
    await satoshi.mine();
    await hal.mine();
    await hal.mine();

    await nick.connect(hal.transport.address);
    await nick.connect(satoshi.transport.address);

    expect(satoshi.tip).toEqual(nick.tip);
    expect(hal.tip).toEqual(nick.tip);
  });

  it("should catch up after reconnecting", async () => {
    await satoshi.mine();
    expect(satoshi.tip).not.toEqual(GENESIS_BLOCK_HASH);
    expect(hal.tip).toEqual(satoshi.tip);

    await satoshi.disconnect(satoshi.transport.peers[0]);

    await satoshi.mine();
    expect(hal.tip).not.toEqual(satoshi.tip);

    await hal.connect(satoshi.transport.address);
    expect(hal.tip).toEqual(satoshi.tip);
  });

  it("should push new blocks after reconnecting", async () => {
    await satoshi.mine();
    expect(satoshi.tip).not.toEqual(GENESIS_BLOCK_HASH);
    expect(hal.tip).toEqual(satoshi.tip);

    await satoshi.disconnect(satoshi.transport.peers[0]);

    await satoshi.mine();
    expect(hal.tip).not.toEqual(satoshi.tip);

    await satoshi.connect(hal.transport.address);
    expect(hal.tip).toEqual(satoshi.tip);
  });

  it("should catch up after partition", async () => {
    await satoshi.mine();
    expect(satoshi.tip).not.toEqual(GENESIS_BLOCK_HASH);
    expect(hal.tip).toEqual(satoshi.tip);

    await satoshi.disconnect(satoshi.transport.peers[0]);

    await hal.mine();
    await hal.mine();
    await satoshi.mine();
    await satoshi.mine();
    await satoshi.mine();
    expect(satoshi.tip).not.toEqual(hal.tip);

    await hal.connect(satoshi.transport.address);
    await delay(10);

    expect(hal.tip).toEqual(satoshi.tip);

    // check previous/next links
    let current;
    current = satoshi.blocks.get(GENESIS_BLOCK_HASH);
    do {
      current = current.next;
    } while (current.next);
    expect(current.hash).toEqual(satoshi.tip);

    current = hal.blocks.get(GENESIS_BLOCK_HASH);
    do {
      current = current.next;
    } while (current.next);
    expect(current.hash).toEqual(hal.tip);

    current = satoshi.blocks.get(satoshi.tip);
    do {
      current = current.previous;
    } while (current.previous);
    expect(current.hash).toEqual(GENESIS_BLOCK_HASH);

    current = hal.blocks.get(hal.tip);
    do {
      current = current.previous;
    } while (current.previous);
    expect(current.hash).toEqual(GENESIS_BLOCK_HASH);
  });
});

// return a promise that resolves after some time
const delay = ms => new Promise(r => setTimeout(r, ms));

// returns an array of blocks for the node's current chain
const chain = node => {
  let current = node.blocks.get(node.tip);
  const chain = [];
  do {
    chain.unshift(current);
  } while ((current = node.blocks.get(current.block.previousblockhash)));
  return chain;
};

const dumpChain = node => {
  let c = chain(node);
  let debug = node.transport.address + ":\n";
  for (let i = 0; i < c.length; i++) {
    debug +=
      i +
      " (" +
      c[i].main +
      "): " +
      c[i].hash +
      " next=" +
      (c[i].next && c[i].next.hash) +
      " prev=" +
      (c[i].previous && c[i].previous.hash) +
      "\n";
  }
  return debug;
};

const checkChain = node => {
  let c = chain(node);

  expect(c[0].hash).toBe(GENESIS_BLOCK_HASH);
  expect(c[c.length - 1].hash).toBe(node.tip);
  for (let i = 0; i < c.length; i++) {
    expect(c[i].height).toBe(i);
    expect(c[i].main).toBe(true);
    if (i > 0) {
      expect(c[i].previous).toBe(c[i - 1]);
    }
    if (i < c.length - 1) {
      expect(c[i].next).toBe(c[i + 1]);
    }
  }
};

// workaround for brorand issue in jest
require("brorand").Rand.prototype._rand = function _rand(n) {
  return require("crypto").randomBytes(n);
};

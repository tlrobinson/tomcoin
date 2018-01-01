const crypto = require("crypto");
const EC = require("elliptic").ec;
const ec = new EC("secp256k1");
const bigInt = require("big-integer");

const sha256 = (exports.sha256 = data =>
  crypto
    .createHash("sha256")
    .update(data)
    .digest());

const hash = (exports.hash = object => sha256(sha256(JSON.stringify(object))));

const merkleHash = (exports.merkleHash = list => {
  if (list.length === 1) {
    return hash([list[0], list[0]]);
  } else if (list.length === 2) {
    return hash([list[0], list[1]]);
  } else {
    const center = Math.floor(list.length / 2);
    return hash([
      merkleHash(list.slice(0, center)),
      merkleHash(list.slice(center))
    ]);
  }
});

exports.sign = (data, privateKey) => {
  const key = ec.keyFromPrivate(privateKey, "hex");
  return key.sign(hash(data)).toDER();
};

exports.verify = (data, publicKey, signature) => {
  const key = ec.keyFromPublic(publicKey, "hex");
  return key.verify(hash(data), signature);
};

exports.generatePrivateKey = () => {
  return ec
    .genKeyPair()
    .getPrivate()
    .toString("hex");
};

exports.getPublicKey = privateKey => {
  return ec
    .keyFromPrivate(privateKey)
    .getPublic()
    .encode("hex");
};

const validateProofOfWork = (exports.validateProofOfWork = (hash, target) => {
  if (typeof target === "string") {
    target = bigInt(target, 16);
  }
  return bigInt(hash.toString("hex"), 16).lt(target);
});

exports.mine = function(block, maxTries = Infinity) {
  block.nonce = 0;
  while (maxTries--) {
    block.time = Date.now();
    block.nonce = (block.nonce + 1) % Number.MAX_SAFE_INTEGER;
    if (validateProofOfWork(hash(block), block.target)) {
      return block;
    }
  }
  return null;
};

exports.stripTxSignatures = function(tx) {
  tx = JSON.parse(JSON.stringify(tx)); // HACK: deep clone
  for (const input of tx.inputs) {
    delete input.scriptSig;
  }
  return tx;
};

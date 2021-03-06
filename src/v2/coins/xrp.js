const BaseCoin = require('../baseCoin');
const BigNumber = require('bignumber.js');
const crypto = require('crypto');
const querystring = require('querystring');
const ripple = require('../../ripple');
const rippleAddressCodec = require('ripple-address-codec');
const rippleBinaryCodec = require('ripple-binary-codec');
const rippleHashes = require('ripple-hashes');
const rippleKeypairs = require('ripple-keypairs');
const url = require('url');
const prova = require('../../prova');
const Q = require('q');
const common = require('../../common');
const _ = require('lodash');

const Xrp = function() {
  // this function is called externally from BaseCoin
  // replace the BaseCoin prototype with the local override prototype, which inherits from BaseCoin
  // effectively, move the BaseCoin prototype one level away
  this.__proto__ = Xrp.prototype;
  // TODO: replace dependency with platform IMS
};

Xrp.prototype.__proto__ = BaseCoin.prototype;

/**
 * Returns the factor between the base unit and its smallest subdivison
 * @return {number}
 */
Xrp.prototype.getBaseFactor = function() {
  return 1e6;
};

Xrp.prototype.getChain = function() {
  return 'xrp';
};
Xrp.prototype.getFamily = function() {
  return 'xrp';
};

/**
 * Evaluates whether an address string is valid for this coin
 * @param address
 */
Xrp.prototype.isValidAddress = function(address) {
  const destinationDetails = url.parse(address);
  const queryDetails = querystring.parse(destinationDetails.query);
  const destinationAddress = destinationDetails.pathname;
  if (!rippleAddressCodec.isValidAddress(destinationAddress)) {
    return false;
  }

  // there are no other properties like destination tags
  if (destinationDetails.pathname === address) {
    return true;
  }

  if (!queryDetails.dt) {
    // if there are more properties, the query details need to contain the destination tag property
    return false;
  }

  const parsedTag = parseInt(queryDetails.dt);
  if (!Number.isSafeInteger(parsedTag)) {
    return false;
  }

  if (parsedTag > 0xFFFFFFFF || parsedTag < 0) {
    return false;
  }

  // the simplest form, reconstruction after the deconstruction, should be deterministic
  const normalizedAddress = `${destinationAddress}?dt=${parsedTag}`;
  return normalizedAddress === address;
};

/**
 * Get fee info from server
 * @param params
 * @param callback
 * @returns {*}
 */
Xrp.prototype.getFeeInfo = function(params, callback) {
  return this.bitgo.get(this.url('/public/feeinfo'))
  .result()
  .nodeify(callback);
};

/**
 * Assemble keychain and half-sign prebuilt transaction
 * @param params
 * - txPrebuild
 * - prv
 * @returns {{txHex}}
 */
Xrp.prototype.signTransaction = function(params) {
  const txPrebuild = params.txPrebuild;
  const userPrv = params.prv;
  const userKey = prova.HDNode.fromBase58(userPrv).getKey();
  const userPrivateKey = userKey.getPrivateKeyBuffer();
  const userAddress = rippleKeypairs.deriveAddress(userKey.getPublicKeyBuffer().toString('hex'));

  const rippleLib = ripple();
  const halfSigned = rippleLib.signWithPrivateKey(txPrebuild.txHex, userPrivateKey.toString('hex'), { signAs: userAddress });
  return { halfSigned: { txHex: halfSigned.signedTransaction } };
};

/**
 * Ripple requires additional parameters for wallet generation to be sent to the server. The additional parameters are
 * the root public key, which is the basis of the root address, two signed, and one half-signed initialization txs
 * @param walletParams
 * - rootPrivateKey: optional hex-encoded Ripple private key
 * @param keychains
 * @return {*|Request|Promise.<TResult>|{anyOf}}
 */
Xrp.prototype.supplementGenerateWallet = function(walletParams, keychains) {
  const { userKeychain, backupKeychain, bitgoKeychain } = keychains;

  const userKey = prova.HDNode.fromBase58(userKeychain.pub).getKey();
  const userAddress = rippleKeypairs.deriveAddress(userKey.getPublicKeyBuffer().toString('hex'));

  const backupKey = prova.HDNode.fromBase58(backupKeychain.pub).getKey();
  const backupAddress = rippleKeypairs.deriveAddress(backupKey.getPublicKeyBuffer().toString('hex'));

  const bitgoKey = prova.HDNode.fromBase58(bitgoKeychain.pub).getKey();
  const bitgoAddress = rippleKeypairs.deriveAddress(bitgoKey.getPublicKeyBuffer().toString('hex'));

  // initially, we need to generate a random root address which has to be distinct from all three keychains
  let keyPair = prova.ECPair.makeRandom();
  if (walletParams.rootPrivateKey) {
    const rootPrivateKey = walletParams.rootPrivateKey;
    if (typeof rootPrivateKey !== 'string' || rootPrivateKey.length !== 64) {
      throw new Error('rootPrivateKey needs to be a hexadecimal private key string');
    }
    keyPair = prova.ECPair.fromPrivateKeyBuffer(Buffer.from(walletParams.rootPrivateKey, 'hex'));
  }
  const privateKey = keyPair.getPrivateKeyBuffer();
  const publicKey = keyPair.getPublicKeyBuffer();
  const rootAddress = rippleKeypairs.deriveAddress(publicKey.toString('hex'));

  let signedMultisigAssignmentTx;
  let signedMasterDeactivationTx;
  let signedDestinationTagTx;

  const self = this;
  const rippleLib = ripple();

  return self.getFeeInfo()
  .then(function(feeInfo) {
    // TODO: get recommended fee from server instead of doing number magic
    const fee = new BigNumber(feeInfo.xrpOpenLedgerFee).times(1.5).toFixed(0);
    const ledgerVersion = feeInfo.height;

    // configure multisigners
    const multisigAssignmentTx = {
      TransactionType: 'SignerListSet',
      Account: rootAddress,
      SignerQuorum: 2,
      SignerEntries: [
        {
          SignerEntry: {
            Account: userAddress,
            SignerWeight: 1
          }
        },
        {
          SignerEntry: {
            Account: backupAddress,
            SignerWeight: 1
          }
        },
        {
          SignerEntry: {
            Account: bitgoAddress,
            SignerWeight: 1
          }
        }
      ],
      Flags: 2147483648,
      // LastLedgerSequence: ledgerVersion + 10,
      Fee: fee,
      Sequence: 1
    };
    signedMultisigAssignmentTx = rippleLib.signWithPrivateKey(JSON.stringify(multisigAssignmentTx), privateKey.toString('hex'));

    // enforce destination tags
    const destinationTagTx = {
      TransactionType: 'AccountSet',
      Account: rootAddress,
      SetFlag: 1,
      Flags: 2147483648,
      // LastLedgerSequence: ledgerVersion + 10,
      Fee: fee,
      Sequence: 2
    };
    signedDestinationTagTx = rippleLib.signWithPrivateKey(JSON.stringify(destinationTagTx), privateKey.toString('hex'));

    // disable master key
    const masterDeactivationTx = {
      TransactionType: 'AccountSet',
      Account: rootAddress,
      SetFlag: 4,
      Flags: 2147483648,
      // LastLedgerSequence: ledgerVersion + 10,
      Fee: fee,
      Sequence: 3
    };
    signedMasterDeactivationTx = rippleLib.signWithPrivateKey(JSON.stringify(masterDeactivationTx), privateKey.toString('hex'));

    // extend the wallet initialization params
    walletParams.rootPub = publicKey.toString('hex');
    walletParams.initializationTxs = {
      setMultisig: signedMultisigAssignmentTx.signedTransaction,
      disableMasterKey: signedMasterDeactivationTx.signedTransaction,
      forceDestinationTag: signedDestinationTagTx.signedTransaction
    };
    return walletParams;
  });
};

/**
 * Explain/parse transaction
 * @param params
 * - txHex: hexadecimal representation of transaction
 * @returns {{displayOrder: [string,string,string,string,string], id: *, outputs: Array, changeOutputs: Array}}
 */
Xrp.prototype.explainTransaction = function(params) {
  let transaction;
  try {
    transaction = rippleBinaryCodec.decode(params.txHex);
  } catch (e) {
    try {
      transaction = JSON.parse(params.txHex);
    } catch (e) {
      throw new Error('txHex needs to be either hex or JSON string for XRP');
    }
  }
  var id = rippleHashes.computeBinaryTransactionHash(params.txHex);
  var changeAmount = 0;
  var explanation = {
    displayOrder: ['id', 'outputAmount', 'changeAmount', 'outputs', 'changeOutputs', 'fee'],
    id: id,
    outputs: [],
    changeOutputs: []
  };
  explanation.outputs = [{
    address: transaction.Destination + ((transaction.DestinationTag >= 0) ? '?dt=' + transaction.DestinationTag : ''),
    amount: transaction.Amount
  }];
  const spendAmount = transaction.Amount;
  explanation.outputAmount = spendAmount;
  explanation.changeAmount = changeAmount;

  explanation.fee = {
    miner: transaction.Fee
  };
  return explanation;
};

Xrp.prototype.getRippledUrl = function() {
  return 'https://s1.ripple.com:51234';
};

/**
 * Builds a funds recovery transaction without BitGo
 * @param params
 * - rootAddress: root XRP wallet address to recover funds from
 * - userKey: [encrypted] xprv
 * - backupKey: [encrypted] xrpv
 * - walletPassphrase: necessary if one of the xprvs is encrypted
 * - bitgoKey: xpub
 * - recoveryDestination: target address to send recovered funds to
 * @param callback
 * @returns {Function|*}
 */
Xrp.prototype.recover = function(params, callback) {
  const rippledUrl = this.getRippledUrl();
  const self = this;
  return this.initiateRecovery(params)
  .then(function(keys) {
    const addressDetailsPromise = self.bitgo.post(rippledUrl)
    .send({
      method: 'account_info',
      params: [{
        account: params.rootAddress,
        strict: true,
        ledger_index: 'current',
        queue: true,
        signer_lists: true
      }]
    });
    const feeDetailsPromise = self.bitgo.post(rippledUrl).send({ method: 'fee' });
    const serverDetailsPromise = self.bitgo.post(rippledUrl).send({ method: 'server_info' });
    return [addressDetailsPromise, feeDetailsPromise, serverDetailsPromise, keys];
  })
  .spread(function(addressDetails, feeDetails, serverDetails, keys) {
    const openLedgerFee = new BigNumber(feeDetails.body.result.drops.open_ledger_fee);
    const baseReserve = new BigNumber(serverDetails.body.result.info.validated_ledger.reserve_base_xrp).times(self.getBaseFactor());
    const reserveDelta = new BigNumber(serverDetails.body.result.info.validated_ledger.reserve_inc_xrp).times(self.getBaseFactor());
    const currentLedger = serverDetails.body.result.info.validated_ledger.seq;
    const sequenceId = addressDetails.body.result.account_data.Sequence;
    const balance = new BigNumber(addressDetails.body.result.account_data.Balance);
    const signerLists = addressDetails.body.result.account_data.signer_lists;
    const accountFlags = addressDetails.body.result.account_data.Flags;

    // make sure there is only one signer list set
    if (signerLists.length !== 1) {
      throw new Error('unexpected set of signer lists');
    }

    // make sure the signers are user, backup, bitgo
    const userAddress = rippleKeypairs.deriveAddress(keys[0].getPublicKeyBuffer().toString('hex'));
    const backupAddress = rippleKeypairs.deriveAddress(keys[1].getPublicKeyBuffer().toString('hex'));

    const signerList = signerLists[0];
    if (signerList.SignerQuorum !== 2) {
      throw new Error('invalid minimum signature count');
    }
    const foundAddresses = {};

    const signerEntries = signerList.SignerEntries;
    if (signerEntries.length !== 3) {
      throw new Error('invalid signer list length');
    }
    for (const { SignerEntry } of signerEntries) {
      const weight = SignerEntry.SignerWeight;
      const address = SignerEntry.Account;
      if (weight !== 1) {
        throw new Error('invalid signer weight');
      }

      // if it's a dupe of an address we already know, block
      if (foundAddresses[address] >= 1) {
        throw new Error('duplicate signer address');
      }
      foundAddresses[address] = (foundAddresses[address] || 0) + 1;
    }

    if (foundAddresses[userAddress] !== 1) {
      throw new Error('unexpected incidence frequency of user signer address');
    }
    if (foundAddresses[backupAddress] !== 1) {
      throw new Error('unexpected incidence frequency of user signer address');
    }

    // make sure the flags disable the master key and enforce destination tags
    const USER_KEY_SETTING_FLAG = 65536;
    const MASTER_KEY_DEACTIVATION_FLAG = 1048576;
    const REQUIRE_DESTINATION_TAG_FLAG = 131072;
    if ((accountFlags & USER_KEY_SETTING_FLAG) !== 0) {
      throw new Error('a custom user key has been set');
    }
    if ((accountFlags & MASTER_KEY_DEACTIVATION_FLAG) !== MASTER_KEY_DEACTIVATION_FLAG) {
      throw new Error('the master key has not been deactivated');
    }
    if ((accountFlags & REQUIRE_DESTINATION_TAG_FLAG) !== REQUIRE_DESTINATION_TAG_FLAG) {
      throw new Error('the destination flag requirement has not been activated');
    }

    // recover the funds
    const reserve = baseReserve.plus(reserveDelta.times(5));
    const recoverableBalance = balance.minus(reserve);

    const rawDestination = params.recoveryDestination;
    const destinationDetails = url.parse(rawDestination);
    const queryDetails = querystring.parse(destinationDetails.query);
    const destinationAddress = destinationDetails.pathname;
    let destinationTag = undefined;
    const parsedTag = parseInt(queryDetails.dt);
    if (Number.isInteger(parsedTag)) {
      destinationTag = parsedTag;
    }

    const transaction = {
      TransactionType: 'Payment',
      Account: params.rootAddress, // source address
      Destination: destinationAddress,
      DestinationTag: destinationTag,
      Amount: recoverableBalance.toFixed(0),
      Flags: 2147483648,
      LastLedgerSequence: currentLedger + 100, // give it 100 ledgers' time
      Fee: openLedgerFee.times(3).toFixed(0), // the factor three is for the multisigning
      Sequence: sequenceId
    };
    const txJSON = JSON.stringify(transaction);

    const userKey = keys[0].getKey().getPrivateKeyBuffer().toString('hex');
    const backupKey = keys[1].getKey().getPrivateKeyBuffer().toString('hex');

    const rippleLib = ripple();
    const userSignature = rippleLib.signWithPrivateKey(txJSON, userKey, { signAs: userAddress });
    const backupSignature = rippleLib.signWithPrivateKey(txJSON, backupKey, { signAs: backupAddress });
    const signedTransaction = rippleLib.combine([userSignature.signedTransaction, backupSignature.signedTransaction]);

    const transactionExplanation = self.explainTransaction({ txHex: signedTransaction.signedTransaction });
    transactionExplanation.txHex = signedTransaction.signedTransaction;
    return transactionExplanation;
  })
  .nodeify(callback);
};

module.exports = Xrp;

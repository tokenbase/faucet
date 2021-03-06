var express = require('express');
var compression = require('compression');
var session = require('express-session');
var fileStore = require('session-file-store')(session);
var bodyParser = require('body-parser');
var request = require('request');
var app = express();

var fs = require('fs');
var Web3 = require('web3');
var Tx = require('ethereumjs-tx');
var CronJob = require('cron').CronJob;
var rskUtil = require('rskjs-util');
const cookieParser = require('cookie-parser')

function shouldCompress (req, res) {
  if (req.headers['x-no-compression']) {
    // don't compress responses with this request header
    return false
  }

  // fallback to standard filter function
  return compression.filter(req, res)
}

// compress all responses
app.use(compression({filter: shouldCompress}))
app.use('/css', express.static('css'));
app.use('/img', express.static('img'));
app.use('/lib', express.static('lib'));
app.use('/fonts', express.static('fonts'));
app.use(express.static('public'));

app.use(function(req, res, next) {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
  next();
});

app.use( bodyParser.json() );                           // to support JSON-encoded bodies
app.use( bodyParser.urlencoded({ extended: true }) );   // to support URL-encoded bodies

const captchaUrl = '/captcha.jpg'
const captchaId = 'captcha'
const captchaFieldName = 'captcha' 

app.use(cookieParser())
const captcha = require('captcha').create({ cookie: captchaId, codeLength: 6,
                                            color: 'rgb(0,100,100)', background: 'rgb(255,200,150)',
                                            lineWidth: 2,      fontSize: 55,
                                            canvasWidth: 170,  canvasHeight: 100 })
var port;
var rskNode;
var faucetAddress;
var valueToSend;
var gasPrice;
var gas;
var captchaSecret;
var faucetPrivateKey;
var faucetHistory = {};

function readConfig(){
  const obj=JSON.parse(fs.readFileSync('./config.json', 'utf8'));
  port = obj.port;
  rskNode = obj.rskNode;
  faucetAddress = obj.faucetAddress;
  faucetPrivateKey = new Buffer(obj.faucetPrivateKey, 'hex');
  valueToSend = obj.valueToSend;
  captchaSecret = obj.captchaSecret;
  gas = obj.gas;
}

readConfig();

app.set('trust proxy', 1) // trust first proxy
app.use(session({
  secret: captchaSecret,
  proxy: true,
  key: 'session.sid',
  resave: false,
  saveUninitialized: true,
  cookie: { secure: true },
  store: new fileStore()
}))

var job = new CronJob({
  cronTime: '* */59 * * * *',
  onTick: function() {
    for (var storeAddress in faucetHistory) {
      if ( faucetHistory.hasOwnProperty(storeAddress) ) {
        var now = new Date().getTime();
        //86400000 = 1 day
        if(now - faucetHistory[storeAddress].timestamp >= 86400000) {
          delete faucetHistory[storeAddress];
        }
      }
    }
  }, start: false, timeZone: 'America/Los_Angeles'});
job.start();

function getWeb3() {
  if (web3)
    return web3;

  console.log('using web3', rskNode);
  web3 = new Web3();
  web3.setProvider(new web3.providers.HttpProvider('http://' + rskNode));

  return web3;
}

var web3;

getWeb3();

function executeTransfer(destinationAddress) {
  var rawTx = buildTx(destinationAddress, getNonce(), getGasPrice());
  var result = web3.eth.sendRawTransaction(rawTx.toString('hex'), function(err, hash){
    if (!err)
      console.log('transaction hash', hash);
  });
}

function buildTx(account, nonce, gasPrice) {
  var rawTx = {
    nonce: nonce,
    gasPrice: gasPrice,
    gas: gas,
    value: valueToSend,
    to: account
  }
    
  var tx = new Tx(rawTx);
  tx.sign(faucetPrivateKey);
  var serializedTx = tx.serialize();
  return serializedTx;
}

function getNonce(){
  var result = web3.eth.getTransactionCount(faucetAddress, "pending");
  return result;
}

function getGasPrice(){
  var block = web3.eth.getBlock("latest")
  if (block.minimumGasPrice <= 1) {
    return 1;
  } else {
    return block.minimumGasPrice;
  }
}

function accountAlreadyUsed(account) {
    var acc = account.toLowerCase(); 
    return acc in faucetHistory;
}

function isValidRSKAddress(address, chainId) {
  if (address === '0x0000000000000000000000000000000000000000') {
    return false;
  }
  if (address.substring(0, 2) !== '0x') {
    return false;
  } else if (!/^(0x)?[0-9a-f]{40}$/i.test(address)) {
    return false;
  } else if (/^(0x)?[0-9a-f]{40}$/.test(address) || /^(0x)?[0-9A-F]{40}$/.test(address)) {
    return true;
  } else {
    return rskUtil.isValidChecksumAddress(address, chainId);
  }
}

app.get('/*', function (req, res, next) {

  if (   req.url.indexOf("/img/") === 0
      || req.url.indexOf("/lib/") === 0
      || req.url.indexOf("/fonts/") === 0
      || req.url.indexOf("/css/font-awesome/css/") === 0
      || req.url.indexOf("/css/font-awesome/fonts/") === 0
      || req.url.indexOf("/css/") === 0
      ) {
    res.setHeader("Cache-Control", "public, max-age=300000");
    res.setHeader("Expires", new Date(Date.now() + 300000).toUTCString());
  }
  next();
});

app.get(captchaUrl, captcha.image());

app.get('/balance', function (req, res) {
  var balance = web3.eth.getBalance(faucetAddress);

  balance = web3.fromWei(balance, "ether");
  
  return res.status(200).send(balance);  
});

app.post('/', function (req, res) {
  if (!isValidRSKAddress(req.body.rskAddress, 31)) {
    console.log('Invalid RSK address format ', req.body.rskAddress);
    return res.status(400).send('Invalid RSK address format.');
  }

  if (accountAlreadyUsed(req.body.rskAddress)) {
    console.log('Address already used today:', req.body.rskAddress);
    return res.status(400).send('Address already used today.');
  }

  if(req.body[captchaFieldName] === undefined || req.body[captchaFieldName] === '' || req.body[captchaFieldName] === null) {
    console.log('No req.body.' + captchaFieldName);
    return res.status(400).send("Please complete captcha.");
  }

  var isSyncing = web3.eth.syncing;
  if(!isSyncing) {
    // Success will be true or false depending upon captcha validation.
    var valid = captcha.check(req, req.body[captchaFieldName])
    if(valid !== undefined && !valid) {
      console.log('Invalid captcha ', req.body[captchaFieldName]);
      return res.status(400).send("Failed captcha verification.");
    }
    console.log('Sending RSKs to ' + req.body.rskAddress);
    console.log('Captcha ' + req.body[captchaFieldName]);
    executeTransfer(req.body.rskAddress)

    faucetHistory[req.body.rskAddress.toLowerCase()] = {timestamp: new Date().getTime()};
    res.send('Successfully sent some SBTCs to ' + req.body.rskAddress + '.');
  } else {
    res.status(400).send('We can not tranfer any amount right now. Try again later.' + req.body.rskAddress + '.');
  }
});

app.listen(port, function () {
  console.log('RSK Faucet started on port ' + port);
});

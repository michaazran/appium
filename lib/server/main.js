"use strict";
var parser = require('./parser.js')()
  , logFactory = require('./logger.js')
  , logger = null
  , args = null
  , fs = require('fs')
  , path = require('path')
  , _ = require('underscore')
  , noPermsCheck = false
  , colors = require('colors');

process.chdir(path.resolve(__dirname, '../..'));

if (require.main === module) {
  args = parser.parseArgs();
  noPermsCheck = args.noPermsCheck;
  logFactory.init(args);
}

logger = logFactory.get('appium');

if (!noPermsCheck) {
  var appiumPermStat = fs.statSync(path.resolve(__dirname,
                                                '../../package.json'));
  var launchCmd = (process.env.SUDO_COMMAND || "").toLowerCase();
  var isWindows = require('../helpers.js').isWindows();

  if (
    !isWindows &&
    (!_(process.env.SUDO_UID).isUndefined() ||
     appiumPermStat.uid !== process.getuid()) &&
    !launchCmd.match(/authorize/)
  ) {
    logger.error("Appium will not work if used or installed with sudo. " +
                 "Please rerun/install as a non-root user. If you had to " +
                 "install Appium using `sudo npm install -g appium`, the " +
                 "solution is to reinstall Node using a method (Homebrew, " +
                 "for example) that doesn't require sudo to install global " +
                 "npm packages.");
    process.exit(1);
  }
}

var http = require('http')
  , express = require('express')
  , favicon = require('serve-favicon')
  , bodyParser = require('body-parser')
  , methodOverride = require('method-override')
  , morgan = require('morgan') // logger
  , routing = require('./routing.js')
  , path = require('path')
  , appium = require('../appium.js')
  , parserWrap = require('./middleware').parserWrap
  , appiumVer = require('../../package.json').version
  , appiumRev = null
  , async = require('async')
  , helpers = require('./helpers.js')
  , logFinalWarning = require('../helpers.js').logFinalDeprecationWarning
  , getConfig = require('../helpers.js').getAppiumConfig
  , allowCrossDomain = helpers.allowCrossDomain
  , catchAllHandler = helpers.catchAllHandler
  , checkArgs = helpers.checkArgs
  , winstonStream = helpers.winstonStream
  , configureServer = helpers.configureServer
  , startListening = helpers.startListening
  , conditionallyPreLaunch = helpers.conditionallyPreLaunch
  , prepareTmpDir = helpers.prepareTmpDir
  , noColorLogger = helpers.noColorLogger;

var main = function (args, readyCb, doneCb) {

  if (args.showConfig) {
    try {
      console.log(JSON.stringify(getConfig()));
    } catch (e) {
      process.exit(1);
    }
    process.exit(0);
  }

  checkArgs(args);
  if (typeof doneCb === "undefined") {
    doneCb = function () {};
  }

  var rest = express()
    , server = http.createServer(rest);

  rest.use(favicon(path.join(__dirname, 'static/favicon.ico')));
  rest.use(express.static(path.join(__dirname, 'static')));
  rest.use(allowCrossDomain);
  if (!args.quiet) {
    if (args.logNoColors) {
      rest.use(morgan(noColorLogger));
    } else {
      rest.use(morgan('dev'));
    }
  }
  if (args.log || args.webhook) {
    rest.use(morgan({stream: winstonStream}));
  }
  if (args.logNoColors || args.log) {
    colors.mode = "none";
  }
  rest.use(parserWrap);
  rest.use(bodyParser.urlencoded({extended: true}));
  rest.use(bodyParser.json());
  rest.use(methodOverride());

  // Instantiate the appium instance
  var appiumServer = appium(args);
  // Hook up REST http interface
  appiumServer.attachTo(rest);

  routing(appiumServer);
  rest.use(catchAllHandler);

  async.series([
    function (cb) {
      configureServer(getConfig(), appiumVer, appiumServer, function (err, rev) {
        if (err) return cb(err);
        appiumRev = rev;
        cb();
      });
    },
    function (cb) {
      prepareTmpDir(args, cb);
    },
    function (cb) {
      conditionallyPreLaunch(args, appiumServer, cb);
    },
    function (cb) {
      startListening(server, args, parser, appiumVer, appiumRev, appiumServer, cb);
    }
  ], function (err) {
    if (err) {
      process.exit(1);
    } else if (typeof readyCb === "function") {
      readyCb(appiumServer);
    }
  });

  server.on('close', function () {
    logFinalWarning();
    doneCb();
  });

};

if (require.main === module) {
  main(args);
}

module.exports.run = main;

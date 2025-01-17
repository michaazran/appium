"use strict";

var logger = require('../../server/logger.js').get('appium')
  , _ = require('underscore')
  , status = require("../../server/status.js")
  , fs = require('fs')
  , path = require('path')
  , exec = require('child_process').exec
  , md5 = require('md5calculator')
  , async = require('async')
  , errors = require('../../server/errors.js')
  , Device = require('../device.js')
  , ADB = require('appium-adb')
  , NotYetImplementedError = errors.NotYetImplementedError;

var logTypesSupported = {
  'logcat' : 'Logs for Android applications on real device and emulators ' +
             'via ADB'
};

var androidCommon = {};

androidCommon.configure = function (args, caps, cb) {
  this._deviceConfigure(args, caps);
  this.setAndroidArgs();
  if (!this.args.androidActivity) {
    logger.debug("No appActivity desired capability or server param. " +
                "Parsing from apk.");
  }
  if (!this.args.androidPackage) {
    logger.debug("No appPackage desired capability or server param. " +
                "Parsing from apk.");
  }

  if (this.args.app) {
    this.configureApp(cb);
  } else if (this.args.androidPackage) {
    this.args.app = null;
    logger.debug("Didn't get app but did get Android package, will attempt " +
                "to launch it on the device");
    cb(null);
  } else {
    var msg = "No app set; either start appium with --app or pass in an " +
              "'app' value in desired capabilities, or set androidPackage " +
              "to launch pre-existing app on device";
    logger.error(msg);
    cb(new Error(msg));
  }
};

androidCommon.configureApp = function (cb) {
  var _cb = cb;
  cb = function (err) {
    if (err) {
      err = new Error("Bad app: " + this.args.app + ". App paths need to be " +
                      "absolute, or relative to the appium server install " +
                      "dir, or a URL to compressed file, or a special app " +
                      "name. cause: " + err);
    }
    _cb(err);
  }.bind(this);

  if (this.appIsPackageOrBundle(this.args.app)) {
    // we have a package instead of app
    this.args.appPackage = this.args.app;
    this.args.app = null;
    logger.debug("App is an Android package, will attempt to run on device");
    cb();
  } else {
    Device.prototype.configureApp.call(this, cb);
  }
};

androidCommon.setAndroidArgs = function () {
  this.setArgFromCap("androidPackage", "appPackage");
  this.setArgFromCap("androidActivity", "appActivity");
  this.setArgFromCap("androidWaitPackage", "appWaitPackage");
  this.setArgFromCap("androidWaitActivity", "appWaitActivity");
  this.setArgFromCap("androidDeviceReadyTimeout", "deviceReadyTimeout");
  this.setArgFromCap("androidCoverage", "androidCoverage");
  this.args.systemPort = this.args.bootstrapPort;
  this.args.appPackage = this.args.androidPackage;
  this.args.appActivity = this.args.androidActivity;
  this.args.appWaitPackage = this.args.androidWaitPackage ||
                             this.args.appPackage;
  this.args.appWaitActivity = this.args.androidWaitActivity ||
                              this.args.appActivity;
  this.appProcess = this.args.appPackage;
  this.args.appDeviceReadyTimeout = this.args.androidDeviceReadyTimeout;
  this.args.avdLaunchTimeout = this.args.avdLaunchTimeout || 120000;
  this.args.avdReadyTimeout = this.args.avdReadyTimeout || 120000;
};

androidCommon.background = function (secs, cb) {
  this.adb.getFocusedPackageAndActivity(function (err, pack, activity) {
    if (err) return cb(err);

    this.adb.keyevent("3", function (err) {
      if (err) return cb(err);

      setTimeout(function () {
        var onStart = function (err) {
          if (err) return cb(err);
          cb(null,{
            status: status.codes.Success.code,
            value: null
          });
        };
        this.adb.startApp({
          pkg: this.args.appPackage,
          activity: this.args.appActivity,
          action: this.args.intentAction,
          category: this.args.intentCategory,
          flags: this.args.intentFlags,
          waitPkg: pack,
          waitActivity: activity,
          optionalIntentArguments: this.args.optionalIntentArguments,
          retry: true,
          stopApp: false
        }, onStart);
      }.bind(this), secs * 1000);
    }.bind(this));
  }.bind(this));
};

androidCommon.openSettingsActivity = function (setting, cb) {
  this.adb.getFocusedPackageAndActivity(function (err, foundPackage,
                                                 foundActivity) {
    var cmd = 'am start -a android.settings.' + setting;
    this.adb.shell(cmd, function (err) {
      if (err) {
        cb(err);
      } else {
        this.adb.waitForNotActivity(foundPackage, foundActivity, 5000, cb);
      }
    }.bind(this));
  }.bind(this));
};

androidCommon.toggleSetting = function (setting, preKeySeq, ocb) {
  var doKey = function (key) {
    return function (cb) {
      setTimeout(function () {
        this.adb.keyevent(key, cb);
      }.bind(this), 2000);
    }.bind(this);
  }.bind(this);

  var settPkg, settAct;

  var back = function (cb) {
    this.adb.back(function (err) {
      if (err) {
        cb(err);
      } else {
        this.adb.waitForNotActivity(settPkg, settAct, 5000, cb);
      }
    }.bind(this));
  }.bind(this);

  /*
   * preKeySeq is the keyevent sequence to send over ADB in order
   * to position the cursor on the right option.
   * By default it's [up, up, down] because we usually target the 1st item in
   * the screen, and sometimes when opening settings activities the cursor is
   * already positionned on the 1st item, but we can't know for sure
   */
  if (preKeySeq === null) preKeySeq = [19, 19, 20]; // up, up, down

  var sequence = [
    function (cb) {
      this.openSettingsActivity(setting, cb);
    }.bind(this)
  ];
  var len = preKeySeq.length;

  for (var i = 0; i < len; i++) {
    sequence.push(doKey(preKeySeq[i]));
  }

  sequence.push(
    function (cb) {
      this.adb.getFocusedPackageAndActivity(function (err, foundPackage,
                                                     foundActivity) {
        settPkg = foundPackage;
        settAct = foundActivity;
        cb(err);
      }.bind(this));
    }.bind(this)
    , function (cb) {
      /*
       * Click and handle potential ADB disconnect that occurs on official
       * emulator when the network connection is disabled
       */
      this.wrapActionAndHandleADBDisconnect(doKey(23), cb);
    }.bind(this)
    , function (cb) {
      /*
       * In one particular case (enable Location Services), a pop-up is
       * displayed on some platforms so the user accepts or refuses that Google
       * collects location data. So we wait for that pop-up to open, if it
       * doesn't then proceed
       */
      this.adb.waitForNotActivity(settPkg, settAct, 5000, function (err) {
        if (err) {
          cb(null);
        } else {
          // Click on right button, "Accept"
          async.series([
            doKey(22)     // right
            , doKey(23)   // click
            , function (cb) {
              // Wait for pop-up to close
              this.adb.waitForActivity(settPkg, settAct, 5000, cb);
            }.bind(this)
          ], function (err) {
            cb(err);
          }.bind(this));
        }
      }.bind(this));
    }.bind(this)
    , back
  );

  async.series(sequence, function (err) {
    if (err) return ocb(err);
    ocb(null, { status: status.codes.Success.code });
  }.bind(this));
};

androidCommon.toggleData = function (ocb) {
  // up, up, down
  this.toggleSetting('DATA_ROAMING_SETTINGS', [19, 19, 20], ocb);
};

androidCommon.toggleFlightMode = function (ocb) {
  this.adb.getApiLevel(function (err, api) {
    var seq = [19, 19]; // up, up
    /*
     * On Android 4.0 there's no "parent" button in the action bar, so we don't
     * need to go down, the cursor is already at the top of the list
     */
    if (api > 15) {
      seq.push(20);     // down
    }
    this.toggleSetting('AIRPLANE_MODE_SETTINGS', seq, ocb);
  }.bind(this));
};

androidCommon.toggleWiFi = function (ocb) {
  // right, right
  this.toggleSetting('WIFI_SETTINGS', [22, 22], ocb);
};

androidCommon.toggleLocationServices = function (ocb) {
  this.adb.getApiLevel(function (err, api) {
    if (api > 15) {
      var seq = [19, 19];   // up, up
      if (api === 16) {
        // This version of Android has a "parent" button in its action bar
        seq.push(20);       // down
      } else if (api >= 19) {
        // Newer versions of Android have the toggle in the Action bar
        seq = [22, 22];     // right, right
        /*
         * Once the Location services switch is OFF, it won't receive focus
         * when going back to the Location Services settings screen unless we
         * send a dummy keyevent (UP) *before* opening the settings screen
         */
        this.adb.keyevent(19, function (/*err*/) {
          this.toggleSetting('LOCATION_SOURCE_SETTINGS', seq, ocb);
        }.bind(this));
        return;
      }
      this.toggleSetting('LOCATION_SOURCE_SETTINGS', seq, ocb);
    } else {
      // There's no global location services toggle on older Android versions
      ocb(new NotYetImplementedError(), null);
    }
  }.bind(this));
};

androidCommon.prepareDevice = function (onReady) {
  logger.debug("Preparing device for session");
  async.series([
    function (cb) { this.checkAppPresent(cb); }.bind(this),
    function (cb) { this.adb.checkAdbPresent(cb); }.bind(this),
    function (cb) { this.prepareEmulator(cb); }.bind(this),
    function (cb) { this.prepareActiveDevice(cb); }.bind(this),
    function (cb) { this.adb.waitForDevice(cb); }.bind(this),
    function (cb) { this.adb.startLogcat(cb); }.bind(this)
  ], onReady);
};

androidCommon.checkAppPresent = function (cb) {
  if (this.args.app === null) {
    logger.debug("Not checking whether app is present since we are assuming " +
                "it's already on the device");
    cb();
  } else {
    logger.debug("Checking whether app is actually present");
    fs.stat(this.args.app, function (err) {
      if (err) {
        logger.error("Could not find app apk at " + this.args.app);
        cb(err);
      } else {
        cb();
      }
    }.bind(this));
  }
};

androidCommon.prepareEmulator = function (cb) {
  if (this.args.avd !== null) {
    var avdName = this.args.avd.replace('@', '');
    this.adb.getRunningAVD(avdName, function (err, runningAVD) {
      if (err && err.message.indexOf('No devices') === -1 &&
          err.message.indexOf('No emulators') === -1) return cb(err);
      if (runningAVD !== null) {
        logger.debug("Did not launch AVD because it was already running.");
        return cb();
      }
      this.adb.launchAVD(this.args.avd, this.args.avdArgs, this.args.language, this.args.locale,
        this.args.avdLaunchTimeout, this.args.avdReadyTimeout, cb);
    }.bind(this));
  } else if (typeof this.args.language === "string" || typeof this.args.locale === "string") {
    var adbCmd = "";
    if (this.args.language && typeof this.args.language === "string") {
      logger.debug("Setting Android Device Language to " + this.args.language);
      adbCmd += "setprop persist.sys.language " +this.args.language.toLowerCase() + ";";
    }
    if (this.args.locale && typeof this.args.locale === "string") {
      logger.debug("Setting Android Device Country to " + this.args.locale);
      adbCmd += "setprop persist.sys.country " +this.args.locale.toUpperCase() + ";";
    }
    adbCmd += " stop; sleep 5; start";
    this.adb.shell(adbCmd, cb);
  } else {
    cb();
  }
};

androidCommon.prepareActiveDevice = function (cb) {
  if (this.adb.curDeviceId) {
    // deviceId is already setted
    return cb();
  }
  this.adb.getDevicesWithRetry(function (err, devices) {
    if (err) return cb(err);
    var deviceId = null;
    if (this.adb.udid) {
      if (!_.contains(_.pluck(devices, 'udid'), this.adb.udid)) {
        return cb(new Error("Device " + this.adb.udid + " was not in the list " +
                            "of connected devices"));
      }
      deviceId = this.adb.udid;
    } else {
      deviceId = devices[0].udid;
      var emPort = this.adb.getPortFromEmulatorString(deviceId);
      this.adb.setEmulatorPort(emPort);
    }
    this.adb.setDeviceId(deviceId);
    cb();
  }.bind(this));
};

androidCommon.resetApp = function (cb) {
  if (this.args.fastReset) {
    logger.debug("Running fast reset (stop and clear)");
    this.adb.stopAndClear(this.args.appPackage, cb);
  } else {
    logger.debug("Running old fashion reset (reinstall)");
    this.remoteApkExists(function (err, remoteApk) {
      if (err) return cb(err);
      if (!remoteApk) {
        return cb(new Error("Can't run reset if remote apk doesn't exist"));
      }
      this.adb.uninstallApk(this.args.appPackage, function (err) {
        if (err) return cb(err);
        this.adb.installRemote(remoteApk, cb);
      }.bind(this));
    }.bind(this));
  }
};

androidCommon.getRemoteApk = function (cb) {
  var next = function () {
    cb(null, this.remoteTempPath() + this.appMd5Hash + '.apk', this.appMd5Hash);
  }.bind(this);

  if (this.appMd5Hash) {
    next();
  } else {
    this.getAppMd5(function (err, md5Hash) {
      if (err) return cb(err);
      this.appMd5Hash = md5Hash;
      next();
    }.bind(this));
  }
};

androidCommon.remoteApkExists = function (cb) {
  this.getRemoteApk(function (err, remoteApk) {
    if (err) return cb(err);
    this.adb.shell("ls " + remoteApk, function (err, stdout) {
      if (err) return cb(err);
      if (stdout.indexOf("No such file") !== -1) {
        return cb(new Error("remote apk did not exist"));
      }
      cb(null, stdout.trim());
    });
  }.bind(this));
};
androidCommon.uninstallApp = function (cb) {
  var next = function () {
    this.adb.uninstallApk(this.args.appPackage, function (err) {
      if (err) return cb(err);
      cb(null);
    }.bind(this));
  }.bind(this);

  if (this.args.skipUninstall) {
    logger.debug("Not uninstalling app since server not started with " +
      "--full-reset");
    cb();
  } else {
    next();
  }
};

androidCommon.installApp = function (cb) {
  if (this.args.app === null) {
    logger.debug("Skipping install since we launched with a package instead " +
                "of an app path");
    return cb();
  }

  this.adb.checkAndSignApk(this.args.app, this.args.appPackage, function (err) {
    if (err) return cb(err);
    this.remoteApkExists(function (err, remoteApk) {
      // err is set if the remote apk doesn't exist so don't check it.
      this.adb.isAppInstalled(this.args.appPackage, function (err, installed) {
        if (installed && this.args.fastReset && remoteApk) {
          this.resetApp(cb);
        } else if (!installed || (this.args.fastReset && !remoteApk)) {
          this.adb.mkdir(this.remoteTempPath(), function (err) {
            if (err) return cb(err);
            this.getRemoteApk(function (err, remoteApk, md5Hash) {
              if (err) return cb(err);
              this.removeTempApks([md5Hash], function (err, appExists) {
                if (err) return cb(err);
                var install = function (err) {
                  if (err) return cb(err);
                  this.installRemoteWithRetry(remoteApk, cb);
                }.bind(this);
                if (appExists) {
                  install();
                } else {
                  this.adb.push(this.args.app, remoteApk, install);
                }
              }.bind(this));
            }.bind(this));
          }.bind(this));
        } else {
          cb();
        }
      }.bind(this));
    }.bind(this));
  }.bind(this));
};

androidCommon.installRemoteWithRetry = function (remoteApk, cb) {
  this.adb.uninstallApk(this.args.appPackage, function (err) {
    if (err) logger.warn("Uninstalling apk failed, continuing");
    this.adb.installRemote(remoteApk, function (err) {
      if (err) {
        logger.warn("Installing remote apk failed, going to uninstall and try " +
                    "again");
        this.removeTempApks([], function () {
          this.adb.push(this.args.app, remoteApk, function (err) {
            if (err) return cb(err);
            logger.debug("Attempting to install again for the last time");
            this.adb.installRemote(remoteApk, cb);
          }.bind(this));
        }.bind(this));
      } else {
        cb();
      }
    }.bind(this));
  }.bind(this));
};

androidCommon.getAppMd5 = function (cb) {
  try {
    md5(this.args.app, function (err, md5Hash) {
      if (err) return cb(err);
      logger.debug("MD5 for app is " + md5Hash);
      cb(null, md5Hash);
    }.bind(this));
  } catch (e) {
    logger.error("Problem calculating md5: " + e);
    return cb(e);
  }
};

androidCommon.remoteTempPath = function () {
  return "/data/local/tmp/";
};

androidCommon.removeTempApks = function (exceptMd5s, cb) {
  logger.debug("Removing any old apks");
  if (typeof exceptMd5s === "function") {
    cb = exceptMd5s;
    exceptMd5s = [];
  }

  var listApks = function (cb) {
    var cmd = 'ls /data/local/tmp/*.apk';
    this.adb.shell(cmd, function (err, stdout) {
      if (err || stdout.indexOf("No such file") !== -1) {
        return cb(null, []);
      }
      var apks = stdout.split("\n");
      cb(null, apks);
    });
  }.bind(this);

  var removeApks = function (apks, cb) {
    if (apks.length < 1) {
      logger.debug("No apks to examine");
      return cb();
    }
    var matchingApkFound = false;
    var noMd5Matched = true;
    var removes = [];
    _.each(apks, function (path) {
      path = path.trim();
      if (path !== "") {
        noMd5Matched = true;
        _.each(exceptMd5s, function (md5Hash) {
          if (path.indexOf(md5Hash) !== -1) {
            noMd5Matched = false;
          }
        });
        if (noMd5Matched) {
          removes.push('rm "' + path + '"');
        } else {
          logger.debug("Found an apk we want to keep at " + path);
          matchingApkFound = true;
        }
      }
    });

    // Invoking adb shell with an empty string will open a shell console
    // so return here if there's nothing to remove.
    if (removes.length < 1) {
      logger.debug("Couldn't find any apks to remove");
      return cb(null, matchingApkFound);
    }

    var cmd = removes.join(" && ");
    this.adb.shell(cmd, function () {
      cb(null, matchingApkFound);
    });
  }.bind(this);

  async.waterfall([
    function (cb) { listApks(cb); },
    function (apks, cb) { removeApks(apks, cb); }
  ], function (err, matchingApkFound) { cb(null, matchingApkFound); });
};

androidCommon.forwardPort = function (cb) {
  this.adb.forwardPort(this.args.systemPort, this.args.devicePort, cb);
};

androidCommon.pushUnicodeIME = function (cb) {
  logger.debug("Pushing unicode ime to device...");
  var imePath = path.resolve(__dirname, "..", "..", "..", "build",
      "unicode_ime_apk", "UnicodeIME-debug.apk");
  fs.stat(imePath, function (err) {
    if (err) {
      cb(new Error("Could not find Unicode IME apk; please run " +
                   "'reset.sh --android' to build it."));
    } else {
      this.adb.install(imePath, false, cb);
    }
  }.bind(this));
};

androidCommon.pushUnlock = function (cb) {
  logger.debug("Pushing unlock helper app to device...");
  var unlockPath = path.resolve(__dirname, "..", "..", "..", "build",
      "unlock_apk", "unlock_apk-debug.apk");
  fs.stat(unlockPath, function (err) {
    if (err) {
      cb(new Error("Could not find unlock.apk; please run " +
                   "'reset.sh --android' to build it."));
    } else {
      this.adb.install(unlockPath, false, cb);
    }
  }.bind(this));
};

androidCommon.unlockScreen = function (cb) {
  this.adb.isScreenLocked(function (err, isLocked) {
    if (err) return cb(err);
    if (isLocked) {
      var timeoutMs = 10000;
      var start = Date.now();
      var unlockAndCheck = function () {
        logger.debug("Screen is locked, trying to unlock");
        var onStart = function (err) {
          if (err) return cb(err);
          this.adb.isScreenLocked(function (err, isLocked) {
            if (err) return cb(err);
            if (!isLocked) {
              logger.debug("Screen is unlocked, continuing");
              return cb();
            }
            if ((Date.now() - timeoutMs) > start) {
              return cb(new Error("Screen did not unlock"));
            } else {
              setTimeout(unlockAndCheck, 1000);
            }
          }.bind(this));
        }.bind(this);
        this.adb.startApp({
          pkg: "io.appium.unlock",
          activity: ".Unlock",
          action: "android.intent.action.MAIN",
          category: "android.intent.category.LAUNCHER",
          flags: "0x10200000"
        }, onStart);
      }.bind(this);
      unlockAndCheck();
    } else {
      logger.debug('Screen already unlocked, continuing.');
      cb();
    }
  }.bind(this));
};

androidCommon.packageAndLaunchActivityFromManifest = function (cb) {
  if (!this.args.app) {
    logger.info("No app capability, can't parse package/activity");
    return cb();
  }
  if (this.args.appPackage && this.args.appActivity) return cb();

  logger.info("Parsing package and activity from app manifest");
  this.adb.packageAndLaunchActivityFromManifest(this.args.app, function (err, pkg, act) {
    if (err) {
      logger.error("Problem parsing package and activity from manifest: " +
                   err);
      return cb(err);
    }
    if (pkg && !this.args.appPackage) this.args.appPackage = pkg;
    if (act && !this.args.appActivity) this.args.appActivity = act;
    if (!this.args.appWaitPackage) this.args.appWaitPackage = this.args.appPackage;
    if (!this.args.appWaitActivity) this.args.appWaitActivity = this.args.appActivity;
    logger.info("Parsed package and activity are: " + pkg + "/" + act);
    cb();
  }.bind(this));
};

androidCommon.getLog = function (logType, cb) {
  // Check if passed logType is supported
  if (!_.has(logTypesSupported, logType)) {
    return cb(null, {
      status: status.codes.UnknownError.code
    , value: "Unsupported log type '" + logType + "', supported types : " + JSON.stringify(logTypesSupported)
    });
  }
  var logs;
  // Check that current logType and instance is compatible
  if (logType === 'logcat') {
    try {
      logs = this.adb.getLogcatLogs();
    } catch (e) {
      return cb(e);
    }
  }
  // If logs captured sucessfully send response with data, else send error
  if (logs) {
    return cb(null, {
      status: status.codes.Success.code
    , value: logs
    });
  } else {
    return cb(null, {
      status: status.codes.UnknownError.code
    , value: "Incompatible logType for this device"
    });
  }
};

androidCommon.getLogTypes = function (cb) {
  return cb(null, {
    status: status.codes.Success.code
  , value: _.keys(logTypesSupported)
  });
};

androidCommon.getCurrentActivity = function (cb) {
  this.adb.getFocusedPackageAndActivity(function (err, curPackage, activity) {
    if (err) {
      return cb(null, {
        status: status.codes.UnknownError.code
      , value: err.message
      });
    }
    cb(null, {
      status: status.codes.Success.code
    , value: activity
    });
  });
};

androidCommon.getDeviceLanguage = function (cb) {
  this.adb.shell("getprop persist.sys.language", function (err, stdout) {
    if (err) {
      logger.warn("Error getting device language: " + err);
      cb(err, null);
    } else {
      logger.debug("Current device language: " + stdout.trim());
      cb(null, stdout.trim());
    }
  }.bind(this));
};

androidCommon.extractLocalizedStrings = function (language, outputPath, cb) {
  var stringsFromApkJarPath = ADB.jars['strings_from_apk.jar'];
  if (!this.args.appPackage) {
    return cb(new Error("Parameter 'appPackage' is required for launching application"));
  }
  var makeStrings = ['java -jar "', stringsFromApkJarPath,
                     '" "', this.args.app, '" "', outputPath, '"'].join('');

  if (language) {
    this.extractStringsFromApk(makeStrings, language, cb);
  } else {
    // If language is not set, use device language
    this.getDeviceLanguage(function (err, language) {
      this.extractStringsFromApk(makeStrings, language, cb);
    }.bind(this));
  }
};

androidCommon.extractStringsFromApk = function (makeStrings, language, cb) {
  var makeLanguageStrings = makeStrings;
  if (language !== null) makeLanguageStrings = [makeStrings, language].join(' ');
  logger.debug(makeLanguageStrings);
  exec(makeLanguageStrings, { maxBuffer: 524288 }, function (err, stdout, stderr) {
    if (err && language !== null) {
      logger.debug("No strings.xml for language '" + language + "', getting default strings.xml");
      this.extractStringsFromApk(makeStrings, null, cb);
    } else {
      cb(err, stdout, stderr);
    }
  }.bind(this));
};

androidCommon.extractStrings = function (cb, language) {
  var outputPath = path.resolve(this.args.tmpDir, this.args.appPackage);
  var stringsJson = 'strings.json';
  if (!fs.existsSync(this.args.app)) {
    logger.debug("Apk doesn't exist locally");
    this.apkStrings = {};
    this.language = null;
    return cb(new Error("Apk doesn't exist locally"));
  } else {
    this.extractLocalizedStrings(language, outputPath, function (err, stdout, stderr) {
      if (err) {
        logger.warn("Error getting strings.xml from apk");
        logger.debug(stderr);
        this.apkStrings = {};
        this.language = null;
        return cb(err);
      }
      var file = fs.readFileSync(path.join(outputPath, stringsJson), 'utf8');
      this.apkStrings = JSON.parse(file);
      this.language = language;
      cb();
    }.bind(this));
  }
};

androidCommon.initUnicode = function (cb) {
  if (this.args.unicodeKeyboard) {
    logger.debug('Enabling Unicode keyboard support');
    this.pushUnicodeIME(function (err) {
      if (err) return cb(err);
      this.adb.enableIME('io.appium.android.ime/.UnicodeIME', function (err) {
        if (err) return cb(err);
        this.adb.setIME('io.appium.android.ime/.UnicodeIME', cb);
      }.bind(this));
    }.bind(this));
  } else {
    cb();
  }
};

module.exports = androidCommon;

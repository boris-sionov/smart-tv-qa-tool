const TauriLauncher = /** @class */ (function () {

  function TauriLauncher(baseBrowserDecorator, name, logger) {
    baseBrowserDecorator(this);
    let tauriCommand = ['dev'];
    const isAndroid = name === 'TauriAndroid';
    if (isAndroid) {
      tauriCommand = ['android', 'dev'];
    }
    this._getOptions = function (url) {
      const tauriConfOverride = {
        build: {
          // Only Android needs the port forwarded to reach Karma on the host. On desktop this
          // command fails whenever no phone happens to be attached, which aborts the launch.
          beforeDevCommand: isAndroid ? 'adb reverse tcp:9876 tcp:9876' : '',
          devUrl: url
        },
        app: {
          windows: [
            {
              url: url
            }
          ]
        }
      };
      return ['scripts/tauri-wrapper.js', ...tauriCommand, '-c', JSON.stringify(tauriConfOverride), '-f', 'karma'];
    };
    let log = logger.create('tauri');
    this._onStdout = function (data) {
      log.debug(data.toString().trimEnd());
    };
    this._onStderr = function (data) {
      log.debug(data.toString().trimEnd());
    };
  }

  TauriLauncher.prototype = {
    name: 'Tauri',
    DEFAULT_CMD: new Proxy({}, {
      get: () => process.execPath,
    }),
  };

  TauriLauncher.$inject = ['baseBrowserDecorator', 'name', 'logger'];

  return TauriLauncher;
}());

module.exports = {
  'launcher:TauriDesktop': ['type', TauriLauncher],
  'launcher:TauriAndroid': ['type', TauriLauncher],
};

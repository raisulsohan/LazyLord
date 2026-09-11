/*
 * Minimal CSInterface shim for LazyLord.
 * -----------------------------------
 * Implements the small subset of Adobe's CSInterface that the LazyLord panel
 * uses, on top of the CEP `window.__adobe_cep__` bridge. You may drop in
 * Adobe's official CSInterface.js (from the CEP-Resources repo) to replace it.
 */
(function () {
  "use strict";

  var SystemPath = {
    EXTENSION: "extension",
    USER_DATA: "userData",
    COMMON_FILES: "commonFiles",
    MY_DOCUMENTS: "myDocuments",
    HOST_APPLICATION: "hostApplication"
  };

  function CSInterface() {}

  CSInterface.prototype.getHostEnvironment = function () {
    try {
      return JSON.parse(window.__adobe_cep__.getHostEnvironment());
    } catch (e) {
      return { appName: "UNKN", appVersion: "0", appId: "UNKN" };
    }
  };

  CSInterface.prototype.getApplicationID = function () {
    return this.getHostEnvironment().appName;
  };

  CSInterface.prototype.evalScript = function (script, callback) {
    if (typeof callback !== "function") callback = function () {};
    window.__adobe_cep__.evalScript(script, callback);
  };

  CSInterface.prototype.getSystemPath = function (pathType) {
    var path = decodeURIComponent(window.__adobe_cep__.getSystemPath(pathType));
    // Normalise the file:// prefix that some hosts return.
    path = path.replace(/^file:\/\/\/?/, "");
    if (/^[A-Za-z]:/.test(path) === false && path.charAt(0) !== "/") {
      // leave as-is
    }
    return path;
  };

  CSInterface.prototype.getExtensionID = function () {
    return window.__adobe_cep__.getExtensionId ? window.__adobe_cep__.getExtensionId() : "com.lazylord.panel";
  };

  window.CSInterface = CSInterface;
  window.SystemPath = SystemPath;
})();

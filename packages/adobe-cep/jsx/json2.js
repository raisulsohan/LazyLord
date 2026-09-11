/*
 * Minimal JSON for ExtendScript (ES3).
 * Public-domain implementation after Douglas Crockford's json2, trimmed to
 * JSON.parse / JSON.stringify which is all LazyLord needs.
 *
 * Kept strictly ES3 — no trailing commas — and deliberately ASCII-only: the
 * format-character ranges are built with new RegExp from escaped strings so
 * nothing depends on how the host decodes this file.
 */
if (typeof JSON !== "object") { JSON = {}; }
(function () {
  "use strict";

  // Unicode format characters that must be escaped inside JSON strings.
  var FORMAT_RANGES =
    "\\u00ad\\u0600-\\u0604\\u070f\\u17b4\\u17b5\\u200c-\\u200f" +
    "\\u2028-\\u202f\\u2060-\\u206f\\ufeff\\ufff0-\\uffff";

  var cx = new RegExp("[\\u0000" + FORMAT_RANGES + "]", "g");
  var escapable = new RegExp("[\\\\\\\"\\x00-\\x1f\\x7f-\\x9f" + FORMAT_RANGES + "]", "g");

  var gap;
  var indent;
  var rep;
  var meta = {
    "\b": "\\b",
    "\t": "\\t",
    "\n": "\\n",
    "\f": "\\f",
    "\r": "\\r",
    "\"": "\\\"",
    "\\": "\\\\"
  };

  function quote(string) {
    escapable.lastIndex = 0;
    if (!escapable.test(string)) return "\"" + string + "\"";
    return "\"" + string.replace(escapable, function (a) {
      var c = meta[a];
      if (typeof c === "string") return c;
      return "\\u" + ("0000" + a.charCodeAt(0).toString(16)).slice(-4);
    }) + "\"";
  }

  function str(key, holder) {
    var i, k, v, length, partial;
    var mind = gap;
    var value = holder[key];

    if (value && typeof value === "object" && typeof value.toJSON === "function") {
      value = value.toJSON(key);
    }
    if (typeof rep === "function") value = rep.call(holder, key, value);

    switch (typeof value) {
      case "string":
        return quote(value);
      case "number":
        return isFinite(value) ? String(value) : "null";
      case "boolean":
      case "null":
        return String(value);
      case "object":
        if (!value) return "null";
        gap += indent;
        partial = [];

        if (Object.prototype.toString.apply(value) === "[object Array]") {
          length = value.length;
          for (i = 0; i < length; i += 1) partial[i] = str(i, value) || "null";
          v = partial.length === 0
            ? "[]"
            : gap
              ? "[\n" + gap + partial.join(",\n" + gap) + "\n" + mind + "]"
              : "[" + partial.join(",") + "]";
          gap = mind;
          return v;
        }

        if (rep && typeof rep === "object") {
          length = rep.length;
          for (i = 0; i < length; i += 1) {
            if (typeof rep[i] === "string") {
              k = rep[i];
              v = str(k, value);
              if (v) partial.push(quote(k) + (gap ? ": " : ":") + v);
            }
          }
        } else {
          for (k in value) {
            if (Object.prototype.hasOwnProperty.call(value, k)) {
              v = str(k, value);
              if (v) partial.push(quote(k) + (gap ? ": " : ":") + v);
            }
          }
        }

        v = partial.length === 0
          ? "{}"
          : gap
            ? "{\n" + gap + partial.join(",\n" + gap) + "\n" + mind + "}"
            : "{" + partial.join(",") + "}";
        gap = mind;
        return v;
    }
    return undefined;
  }

  if (typeof JSON.stringify !== "function") {
    JSON.stringify = function (value, replacer, space) {
      var i;
      gap = "";
      indent = "";
      if (typeof space === "number") {
        for (i = 0; i < space; i += 1) indent += " ";
      } else if (typeof space === "string") {
        indent = space;
      }
      rep = replacer;
      return str("", { "": value });
    };
  }

  if (typeof JSON.parse !== "function") {
    JSON.parse = function (text, reviver) {
      var j;

      function walk(holder, key) {
        var k, v;
        var value = holder[key];
        if (value && typeof value === "object") {
          for (k in value) {
            if (Object.prototype.hasOwnProperty.call(value, k)) {
              v = walk(value, k);
              if (v !== undefined) value[k] = v;
              else delete value[k];
            }
          }
        }
        return reviver.call(holder, key, value);
      }

      text = String(text);
      cx.lastIndex = 0;
      if (cx.test(text)) {
        text = text.replace(cx, function (a) {
          return "\\u" + ("0000" + a.charCodeAt(0).toString(16)).slice(-4);
        });
      }

      var probe = text
        .replace(/\\(?:["\\\/bfnrt]|u[0-9a-fA-F]{4})/g, "@")
        .replace(/"[^"\\\n\r]*"|true|false|null|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?/g, "]")
        .replace(/(?:^|:|,)(?:\s*\[)+/g, "");

      if (/^[\],:{}\s]*$/.test(probe)) {
        j = eval("(" + text + ")");
        return typeof reviver === "function" ? walk({ "": j }, "") : j;
      }
      throw new SyntaxError("JSON.parse");
    };
  }
})();

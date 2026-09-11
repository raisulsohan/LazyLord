/*
 * LazyLord — the dropdowns.
 *
 * A native <select> opens the system's own list, which neither host lets a
 * stylesheet reach: in a CEP panel it is a small, cramped Chromium popup. So
 * each select is given a button and a menu drawn like the rest of the UI,
 * while the select itself stays in the page, hidden: the code keeps reading
 * and writing select.value and listening for "change" exactly as before.
 *
 * Shared by both front ends: the Figma plugin inlines this file ahead of its
 * UI script, and the CEP panel loads a copy synced into js/ by
 * tools/sync-ui-css.mjs. Written as ES3 syntax, since the panel's files are
 * checked with the ExtendScript parser.
 *
 * Usage: LazyLordSelect.enhance(document) once the page is built.
 */
(function (global) {
  "use strict";

  var open = null;     // the one menu that is open
  var listening = false;

  function enhance(doc) {
    if (!doc || !doc.body || !doc.querySelectorAll || !global.getComputedStyle) return;
    var list = doc.querySelectorAll("select.a-place, .a-opt select");
    for (var i = 0; i < list.length; i++) {
      if (!list[i].lazySelect) wrap(list[i]);
    }
    if (listening) return;
    listening = true;
    // A press anywhere else, a resize or a scroll outside the menu closes it.
    doc.addEventListener("mousedown", function (e) {
      if (open && !open.owns(e.target)) open.close(false);
    }, true);
    doc.addEventListener("scroll", function (e) {
      if (open && e.target !== open.menu && !open.menu.contains(e.target)) open.close(false);
    }, true);
    global.addEventListener("resize", function () { if (open) open.close(false); });
    global.addEventListener("blur", function () { if (open) open.close(false); });
  }

  function chevron(doc) {
    var ns = "http://www.w3.org/2000/svg";
    var svg = doc.createElementNS(ns, "svg");
    svg.setAttribute("width", "12");
    svg.setAttribute("height", "12");
    svg.setAttribute("viewBox", "0 0 12 12");
    svg.setAttribute("fill", "none");
    svg.setAttribute("aria-hidden", "true");
    svg.setAttribute("class", "a-select-chev");
    var path = doc.createElementNS(ns, "path");
    path.setAttribute("d", "M3 4.5L6 7.5L9 4.5");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", "1.5");
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.appendChild(path);
    return svg;
  }

  function fireChange(sel) {
    var ev;
    try {
      ev = new Event("change", { bubbles: true });
    } catch (e) {
      ev = sel.ownerDocument.createEvent("HTMLEvents");
      ev.initEvent("change", true, false);
    }
    sel.dispatchEvent(ev);
  }

  function wrap(sel) {
    var doc = sel.ownerDocument;
    var box = doc.createElement("span");
    box.className = "a-select";
    sel.parentNode.insertBefore(box, sel);
    box.appendChild(sel);
    sel.className = (sel.className ? sel.className + " " : "") + "a-select-native";
    sel.tabIndex = -1;
    sel.setAttribute("aria-hidden", "true");

    var btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "a-select-btn" + (/\ba-place\b/.test(sel.className) ? " is-place" : "");
    if (sel.title) btn.title = sel.title;
    if (sel.id) btn.id = sel.id + "-button";
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", "false");
    var text = doc.createElement("span");
    text.className = "a-select-text";
    btn.appendChild(text);
    btn.appendChild(chevron(doc));
    box.appendChild(btn);

    var menu = doc.createElement("div");
    menu.className = "a-menu";
    menu.setAttribute("role", "listbox");
    menu.hidden = true;
    doc.body.appendChild(menu);

    var self = {
      sel: sel,
      btn: btn,
      menu: menu,
      focus: -1,
      owns: function (node) { return box.contains(node) || menu.contains(node); },
      render: render,
      close: close
    };
    sel.lazySelect = self;

    function render() {
      var o = sel.options[sel.selectedIndex];
      text.textContent = o ? o.text : "";
      btn.disabled = !!sel.disabled;
      if (open === self) build();
    }

    function build() {
      menu.textContent = "";
      for (var i = 0; i < sel.options.length; i++) {
        var o = sel.options[i];
        var item = doc.createElement("div");
        item.className = "a-menu-item" + (i === sel.selectedIndex ? " is-selected" : "") +
          (o.disabled ? " is-disabled" : "") + (i === self.focus ? " is-focus" : "");
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", i === sel.selectedIndex ? "true" : "false");
        item.textContent = o.text;
        item.lazyIndex = i;
        menu.appendChild(item);
      }
    }

    function place() {
      var r = btn.getBoundingClientRect();
      var vw = global.innerWidth, vh = global.innerHeight;
      menu.style.minWidth = Math.round(r.width) + "px";
      menu.style.maxHeight = "";
      menu.style.visibility = "hidden";
      menu.hidden = false;
      var h = menu.offsetHeight, w = menu.offsetWidth;
      var below = vh - r.bottom - 8, above = r.top - 8;
      var up = h > below && above > below;
      var room = Math.max(80, Math.min(up ? above : below, 320));
      if (h > room) { menu.style.maxHeight = room + "px"; h = room; }
      menu.style.top = Math.round(up ? r.top - 4 - h : r.bottom + 4) + "px";
      menu.style.left = Math.round(Math.max(8, Math.min(r.left, vw - 8 - w))) + "px";
      menu.style.visibility = "";
    }

    function show() {
      if (sel.disabled) return;
      if (open && open !== self) open.close(false);
      self.focus = sel.selectedIndex;
      build();
      place();
      open = self;
      btn.setAttribute("aria-expanded", "true");
      box.className = "a-select is-open";
      // Next frame, so the menu fades in from where it starts.
      global.setTimeout(function () { if (open === self) menu.className = "a-menu is-open"; }, 0);
      scrollTo(self.focus);
    }

    function close(refocus) {
      if (open === self) open = null;
      menu.className = "a-menu";
      menu.hidden = true;
      btn.setAttribute("aria-expanded", "false");
      box.className = "a-select";
      if (refocus) btn.focus();
    }

    function choose(i) {
      var o = sel.options[i];
      if (!o || o.disabled) return;
      var changed = sel.selectedIndex !== i;
      sel.selectedIndex = i;
      render();
      close(true);
      if (changed) fireChange(sel);
    }

    function scrollTo(i) {
      var item = menu.children[i];
      if (!item) return;
      if (item.offsetTop < menu.scrollTop) menu.scrollTop = item.offsetTop;
      else if (item.offsetTop + item.offsetHeight > menu.scrollTop + menu.clientHeight) {
        menu.scrollTop = item.offsetTop + item.offsetHeight - menu.clientHeight;
      }
    }

    function move(step) {
      var n = sel.options.length, i = self.focus;
      for (var k = 0; k < n; k++) {
        i = (i + step + n) % n;
        if (!sel.options[i].disabled) break;
      }
      self.focus = i;
      build();
      scrollTo(i);
    }

    btn.addEventListener("click", function () {
      if (open === self) close(false);
      else show();
    });

    btn.addEventListener("keydown", function (e) {
      var k = e.key;
      if (open !== self) {
        if (k === "ArrowDown" || k === "ArrowUp" || k === "Enter" || k === " ") { e.preventDefault(); show(); }
        return;
      }
      if (k === "ArrowDown") { e.preventDefault(); move(1); }
      else if (k === "ArrowUp") { e.preventDefault(); move(-1); }
      else if (k === "Home") { e.preventDefault(); self.focus = 0; move(0); }
      else if (k === "End") { e.preventDefault(); self.focus = sel.options.length - 1; move(0); }
      else if (k === "Enter" || k === " ") { e.preventDefault(); choose(self.focus); }
      else if (k === "Escape") { e.preventDefault(); close(true); }
      else if (k === "Tab") close(false);
    });

    menu.addEventListener("mousemove", function (e) {
      var t = e.target;
      if (t && typeof t.lazyIndex === "number" && t.lazyIndex !== self.focus) {
        self.focus = t.lazyIndex;
        build();
      }
    });
    menu.addEventListener("mousedown", function (e) { e.preventDefault(); }); // keep focus on the button
    menu.addEventListener("click", function (e) {
      var t = e.target;
      if (t && typeof t.lazyIndex === "number") choose(t.lazyIndex);
    });

    // A label's click lands on the hidden select: pass it on.
    sel.addEventListener("focus", function () { btn.focus(); });
    sel.addEventListener("change", render);

    // The code sets select.value (and selectedIndex) without any event, and
    // rebuilds option lists: both are watched so the button always agrees.
    watch(sel, "value", render);
    watch(sel, "selectedIndex", render);
    if (global.MutationObserver) {
      new global.MutationObserver(render).observe(sel, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled"] });
    }

    render();
  }

  /** Call `after` whenever the select's `prop` is assigned, keeping the native behaviour. */
  function watch(sel, prop, after) {
    var proto = global.HTMLSelectElement && global.HTMLSelectElement.prototype;
    var d = proto && Object.getOwnPropertyDescriptor(proto, prop);
    if (!d || !d.set || !d.get) return;
    Object.defineProperty(sel, prop, {
      configurable: true,
      enumerable: true,
      get: function () { return d.get.call(this); },
      set: function (v) { d.set.call(this, v); after(); }
    });
  }

  global.LazyLordSelect = { enhance: enhance };
})(typeof window !== "undefined" ? window : this);

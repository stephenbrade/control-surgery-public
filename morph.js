/* ---------------------------------------------------------------------------
 * morph.js — alpha-slider morph players for the Control Surgery site.
 *
 * Renders one player per (example, method) pair from data/examples.json.
 * Audio is decoded into AudioBuffers so moving the slider mid-playback swaps
 * morph steps gaplessly (short equal-power crossfade) at the same playhead.
 *
 * Nothing here needs editing to add examples — edit data/examples.json.
 * ------------------------------------------------------------------------- */

(function () {
  "use strict";

  var SRC_COLOR = [30, 64, 175];    // alpha = 0
  var TGT_COLOR = [194, 65, 12];    // alpha = 1
  var XFADE = 0.018;                // seconds
  var ENV_POINTS = 240;

  /* ------------------------------------------------------------ utilities */

  function lerpColor(a, b, t) {
    return "rgb(" +
      Math.round(a[0] + (b[0] - a[0]) * t) + "," +
      Math.round(a[1] + (b[1] - a[1]) * t) + "," +
      Math.round(a[2] + (b[2] - a[2]) * t) + ")";
  }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  function pad2(n) { return (n < 10 ? "0" : "") + n; }

  var _ctx = null;
  function audioCtx() {
    if (!_ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      _ctx = new AC();
    }
    if (_ctx.state === "suspended") _ctx.resume();
    return _ctx;
  }

  var bufferCache = Object.create(null);
  function loadBuffer(url) {
    if (bufferCache[url]) return bufferCache[url];
    bufferCache[url] = fetch(url)
      .then(function (r) {
        if (!r.ok) throw new Error(r.status + " " + url);
        return r.arrayBuffer();
      })
      .then(function (ab) {
        return new Promise(function (res, rej) {
          audioCtx().decodeAudioData(ab, res, rej);
        });
      })
      .catch(function () { return null; });   // missing audio is not fatal
    return bufferCache[url];
  }

  /* --------------------------------------------------- analysis (cached) */

  function monoData(buf) {
    if (buf._mono) return buf._mono;
    var n = buf.length;
    var out = new Float32Array(n);
    for (var c = 0; c < buf.numberOfChannels; c++) {
      var d = buf.getChannelData(c);
      for (var i = 0; i < n; i++) out[i] += d[i];
    }
    var inv = 1 / buf.numberOfChannels;
    for (var j = 0; j < n; j++) out[j] *= inv;
    buf._mono = out;
    return out;
  }

  function peaks(buf, cols) {
    buf._peaks = buf._peaks || {};
    if (buf._peaks[cols]) return buf._peaks[cols];
    var d = monoData(buf);
    var step = d.length / cols;
    var mins = new Float32Array(cols);
    var maxs = new Float32Array(cols);
    for (var c = 0; c < cols; c++) {
      var s = Math.floor(c * step);
      var e = Math.min(d.length, Math.floor((c + 1) * step));
      var mn = 0, mx = 0;
      for (var i = s; i < e; i++) {
        var v = d[i];
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
      mins[c] = mn; maxs[c] = mx;
    }
    var p = { min: mins, max: maxs };
    buf._peaks[cols] = p;
    return p;
  }

  function envelope(buf) {
    if (buf._env) return buf._env;
    var d = monoData(buf);
    var out = new Float32Array(ENV_POINTS);
    var step = d.length / ENV_POINTS;
    for (var k = 0; k < ENV_POINTS; k++) {
      var s = Math.floor(k * step);
      var e = Math.min(d.length, Math.floor((k + 1) * step));
      var acc = 0;
      for (var i = s; i < e; i++) acc += d[i] * d[i];
      out[k] = Math.sqrt(acc / Math.max(1, e - s));
    }
    buf._env = out;
    return out;
  }

  function fitCanvas(cv) {
    var dpr = window.devicePixelRatio || 1;
    var w = cv.clientWidth, h = cv.clientHeight;
    if (!w || !h) return null;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(h * dpr);
    }
    var ctx = cv.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx: ctx, w: w, h: h };
  }

  /* -------------------------------------------------------------- player */

  function MorphPlayer(root, example, methodKey, manifest, opts) {
    opts = opts || {};
    this.root = root;
    this.ex = example;
    this.methodKeys = (opts.methodKeys && opts.methodKeys.length)
      ? opts.methodKeys : [methodKey];
    this.methodKey = methodKey;
    this.method = example.methods[methodKey];
    this.manifest = manifest;
    this.methodBtns = [];
    this.compact = !!opts.compact;
    this.steps = this.method.steps || example.steps || manifest.steps || 11;
    this.buffers = new Array(this.steps).fill(undefined);
    this.idx = 0;
    this.playing = false;
    this.loop = true;
    this.offset = 0;
    this.startedAt = 0;
    this.src = null;
    this.gain = null;
    this.loaded = false;
    this.loading = false;
    this.stripView = "steps";
    this.build();
  }

  MorphPlayer.prototype.url = function (i) {
    var pattern = this.method.pattern || this.manifest.pattern || "step_{i}.wav";
    return this.method.dir.replace(/\/$/, "") + "/" +
      pattern.replace("{i}", pad2(i)).replace("{n}", String(i));
  };

  MorphPlayer.prototype.build = function () {
    var self = this;
    var ex = this.ex;
    var r = this.root;
    r.classList.add("morph");
    if (this.compact) r.classList.add("morph--compact");

    var head = el("div", "morph__head");
    var h = el("strong", null, this.labelFor(this.methodKey));
    this.headLabel = h;
    head.appendChild(h);
    if (ex.tier) head.appendChild(el("span", "morph__tag", ex.tier));
    if (ex.id) head.appendChild(el("span", "morph__id", ex.id));
    r.appendChild(head);

    if (!this.compact) {
      var dl = el("dl", "morph__prompts");
      var dt1 = el("dt", "is-src", "Source");
      dl.appendChild(dt1);
      dl.appendChild(el("dd", null, ex.source_prompt || "—"));
      var dt2 = el("dt", "is-tgt", "Target");
      dl.appendChild(dt2);
      dl.appendChild(el("dd", null, ex.target_prompt || "—"));
      r.appendChild(dl);

      if (ex.ops && ex.ops.length) {
        var ul = el("ul", "morph__ops");
        ex.ops.forEach(function (o) {
          var txt = typeof o === "string" ? o : (o.op + "(" + o.arg + ")");
          ul.appendChild(el("li", null, txt));
        });
        r.appendChild(ul);
      }
    }

    if (this.methodKeys.length > 1) {
      var mrow = el("div", "morph__methods");
      mrow.setAttribute("role", "group");
      mrow.setAttribute("aria-label", "Method");
      this.methodKeys.forEach(function (k) {
        var b = el("button", "morph__methodtab", self.labelFor(k));
        b.type = "button";
        b.setAttribute("aria-pressed", String(k === self.methodKey));
        b.addEventListener("click", function () { self.setMethod(k); });
        self.methodBtns.push({ key: k, node: b });
        mrow.appendChild(b);
      });
      r.appendChild(mrow);
    }

    var wrap = el("div", "morph__canvas-wrap");
    this.canvas = el("canvas", "morph__canvas");
    wrap.appendChild(this.canvas);
    r.appendChild(wrap);

    this.strip = el("canvas", "morph__strip");
    r.appendChild(this.strip);

    var tabs = el("div", "morph__viewtabs");
    this.tabSteps = el("button", "morph__viewtab", "All steps");
    this.tabEnv = el("button", "morph__viewtab", "Envelopes");
    this.tabSteps.type = "button";
    this.tabEnv.type = "button";
    tabs.appendChild(this.tabSteps);
    tabs.appendChild(this.tabEnv);
    r.appendChild(tabs);

    var ctr = el("div", "morph__controls");
    this.playBtn = el("button", "morph__play", "▶");
    this.playBtn.type = "button";
    this.playBtn.setAttribute("aria-label", "Play");
    ctr.appendChild(this.playBtn);

    var sw = el("div", "morph__slider-wrap");
    this.slider = document.createElement("input");
    this.slider.type = "range";
    this.slider.min = "0";
    this.slider.max = String(this.steps - 1);
    this.slider.step = "1";
    this.slider.value = "0";
    this.slider.className = "morph__slider";
    this.slider.setAttribute("aria-label", "Morph amount alpha");
    sw.appendChild(this.slider);
    var scale = el("div", "morph__scale");
    scale.appendChild(el("span", null, "source  α=0"));
    scale.appendChild(el("span", null, "0.5"));
    scale.appendChild(el("span", null, "α=1  target"));
    sw.appendChild(scale);
    ctr.appendChild(sw);

    this.alphaOut = el("span", "morph__alpha", "α = 0.00");
    ctr.appendChild(this.alphaOut);

    var lt = el("label", "morph__toggle");
    this.loopBox = document.createElement("input");
    this.loopBox.type = "checkbox";
    this.loopBox.checked = true;
    lt.appendChild(this.loopBox);
    lt.appendChild(document.createTextNode("loop"));
    ctr.appendChild(lt);

    r.appendChild(ctr);

    this.status = el("div", "morph__status", "");
    r.appendChild(this.status);

    /* events */
    this.slider.addEventListener("input", function () {
      self.setStep(parseInt(self.slider.value, 10));
    });
    this.playBtn.addEventListener("click", function () {
      self.toggle();
    });
    this.loopBox.addEventListener("change", function () {
      self.loop = self.loopBox.checked;
      if (self.src) self.src.loop = self.loop;
    });
    this.canvas.addEventListener("click", function (e) {
      var b = self.canvas.getBoundingClientRect();
      self.seek(((e.clientX - b.left) / b.width) * self.duration());
    });
    this.strip.addEventListener("click", function (e) {
      if (self.stripView !== "steps") return;
      var b = self.strip.getBoundingClientRect();
      var i = Math.floor(((e.clientX - b.left) / b.width) * self.steps);
      i = Math.max(0, Math.min(self.steps - 1, i));
      self.slider.value = String(i);
      self.setStep(i);
    });
    this.tabSteps.addEventListener("click", function () { self.setStripView("steps"); });
    this.tabEnv.addEventListener("click", function () { self.setStripView("env"); });
    window.addEventListener("resize", function () { self.draw(); });

    this.setStripView("steps");
    this.updateAlphaLabel();
    this.draw();

    /* lazy load when scrolled near */
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
          if (en.isIntersecting) { io.disconnect(); self.load(); }
        });
      }, { rootMargin: "300px" });
      io.observe(r);
    } else {
      this.load();
    }
  };

  MorphPlayer.prototype.labelFor = function (key) {
    var m = this.ex.methods[key] || {};
    return m.label ||
      (this.manifest.methods && this.manifest.methods[key]) || key;
  };

  MorphPlayer.prototype.setMethod = function (key) {
    if (key === this.methodKey || !this.ex.methods[key]) return;
    var self = this;
    var wasPlaying = this.playing;
    var pos = this.position();
    if (this.playing) this.stop();
    this.offset = pos;

    this.methodKey = key;
    this.method = this.ex.methods[key];
    this.steps = this.method.steps || this.ex.steps || this.manifest.steps || 11;
    if (this.idx > this.steps - 1) this.idx = this.steps - 1;
    this.slider.max = String(this.steps - 1);
    this.slider.value = String(this.idx);
    this.buffers = new Array(this.steps).fill(undefined);
    this.loaded = false;
    this.loading = false;
    this.playBtn.disabled = false;
    this.status.classList.remove("is-error");
    this.status.textContent = "";
    if (this.headLabel) this.headLabel.textContent = this.labelFor(key);
    this.methodBtns.forEach(function (b) {
      b.node.setAttribute("aria-pressed", String(b.key === key));
    });
    this.updateAlphaLabel();
    this.draw();
    this.load().then(function () { if (wasPlaying) self.play(); });
  };

  MorphPlayer.prototype.setStripView = function (v) {
    this.stripView = v;
    this.tabSteps.setAttribute("aria-pressed", String(v === "steps"));
    this.tabEnv.setAttribute("aria-pressed", String(v === "env"));
    this.strip.style.cursor = v === "steps" ? "pointer" : "default";
    this.drawStrip();
  };

  MorphPlayer.prototype.alpha = function () {
    return this.steps > 1 ? this.idx / (this.steps - 1) : 0;
  };

  MorphPlayer.prototype.updateAlphaLabel = function () {
    this.alphaOut.textContent = "α = " + this.alpha().toFixed(2);
  };

  MorphPlayer.prototype.load = function () {
    var self = this;
    if (this.loaded || this.loading) return Promise.resolve();
    this.loading = true;
    this.status.textContent = "Loading morph steps…";
    var urls = [];
    for (var i = 0; i < this.steps; i++) urls.push(this.url(i));
    var done = 0;
    return Promise.all(urls.map(function (u, i) {
      return loadBuffer(u).then(function (b) {
        self.buffers[i] = b;
        done++;
        self.status.textContent = "Loading morph steps… " + done + "/" + self.steps;
        if (i === self.idx || i === 0) self.draw();
        return b;
      });
    })).then(function (all) {
      self.loading = false;
      self.loaded = true;
      var missing = all.filter(function (b) { return !b; }).length;
      if (missing === all.length) {
        self.status.classList.add("is-error");
        self.status.textContent =
          "Audio pending — drop " + self.steps + " files into " +
          self.method.dir + "/ (" +
          (self.method.pattern || self.manifest.pattern || "step_{i}.wav") + ").";
        self.playBtn.disabled = true;
      } else if (missing) {
        self.status.textContent = missing + " of " + self.steps + " steps missing.";
      } else {
        self.status.textContent = "";
      }
      self.draw();
    });
  };

  MorphPlayer.prototype.buffer = function () { return this.buffers[this.idx] || null; };

  MorphPlayer.prototype.duration = function () {
    for (var i = 0; i < this.steps; i++) {
      if (this.buffers[i]) return this.buffers[i].duration;
    }
    return 0;
  };

  MorphPlayer.prototype.position = function () {
    var d = this.duration();
    if (!d) return 0;
    if (!this.playing) return Math.min(this.offset, d);
    var t = audioCtx().currentTime - this.startedAt;
    return this.loop ? (t % d) : Math.min(t, d);
  };

  MorphPlayer.prototype.setStep = function (i) {
    if (i === this.idx) return;
    this.idx = i;
    this.updateAlphaLabel();
    if (this.playing) this.swap();
    this.draw();
  };

  MorphPlayer.prototype.startSource = function (offset, fadeIn) {
    var buf = this.buffer();
    if (!buf) return null;
    var ctx = audioCtx();
    var s = ctx.createBufferSource();
    s.buffer = buf;
    s.loop = this.loop;
    var g = ctx.createGain();
    var t0 = ctx.currentTime;
    if (fadeIn) {
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(1, t0 + XFADE);
    } else {
      g.gain.setValueAtTime(1, t0);
    }
    s.connect(g).connect(ctx.destination);
    s.start(0, Math.max(0, Math.min(offset, buf.duration - 0.001)));
    this.startedAt = t0 - offset;
    var self = this;
    s.onended = function () {
      if (self.src === s && !self.loop) self.stop();
    };
    this.src = s;
    this.gain = g;
    return s;
  };

  MorphPlayer.prototype.fadeOut = function (s, g) {
    if (!s) return;
    var ctx = audioCtx();
    var t0 = ctx.currentTime;
    try {
      g.gain.cancelScheduledValues(t0);
      g.gain.setValueAtTime(g.gain.value, t0);
      g.gain.linearRampToValueAtTime(0, t0 + XFADE);
      s.onended = null;
      s.stop(t0 + XFADE + 0.005);
    } catch (e) { /* already stopped */ }
  };

  MorphPlayer.prototype.swap = function () {
    var pos = this.position();
    var old = this.src, oldG = this.gain;
    this.startSource(pos, true);
    this.fadeOut(old, oldG);
  };

  MorphPlayer.prototype.play = function () {
    var self = this;
    if (this.playing) return;
    var go = function () {
      if (!self.buffer() && !self.duration()) return;
      self.playing = true;
      self.playBtn.textContent = "❚❚";
      self.playBtn.setAttribute("aria-label", "Pause");
      self.startSource(self.offset % (self.duration() || 1), false);
      self.tick();
    };
    if (!this.loaded) this.load().then(go); else go();
  };

  MorphPlayer.prototype.pause = function () {
    this.offset = this.position();
    this.stop();
  };

  MorphPlayer.prototype.stop = function () {
    if (this.src) {
      try { this.src.onended = null; this.src.stop(); } catch (e) {}
    }
    this.src = null;
    this.gain = null;
    this.playing = false;
    this.playBtn.textContent = "▶";
    this.playBtn.setAttribute("aria-label", "Play");
    this.draw();
  };

  MorphPlayer.prototype.toggle = function () {
    if (this.playing) this.pause(); else this.play();
  };

  MorphPlayer.prototype.seek = function (t) {
    var d = this.duration();
    if (!d) return;
    t = Math.max(0, Math.min(t, d - 0.001));
    this.offset = t;
    if (this.playing) {
      var old = this.src, oldG = this.gain;
      this.startSource(t, true);
      this.fadeOut(old, oldG);
    } else {
      this.draw();
    }
  };

  MorphPlayer.prototype.tick = function () {
    var self = this;
    if (!this.playing) return;
    this.draw();
    requestAnimationFrame(function () { self.tick(); });
  };

  /* ------------------------------------------------------------ drawing */

  MorphPlayer.prototype.draw = function () {
    this.drawMain();
    this.drawStrip();
  };

  MorphPlayer.prototype.drawMain = function () {
    var f = fitCanvas(this.canvas);
    if (!f) return;
    var ctx = f.ctx, w = f.w, h = f.h, mid = h / 2;
    var a = this.alpha();
    var col = lerpColor(SRC_COLOR, TGT_COLOR, a);

    ctx.fillStyle = "#fafafa";
    ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = "#e5e5e5";
    ctx.beginPath();
    ctx.moveTo(0, mid); ctx.lineTo(w, mid); ctx.stroke();

    var buf = this.buffer();
    if (!buf) {
      ctx.fillStyle = "#999";
      ctx.font = "12px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(this.loading ? "decoding…" : "no audio for this step", w / 2, mid + 4);
      ctx.textAlign = "left";
      return;
    }

    var cols = Math.max(1, Math.floor(w));
    var p = peaks(buf, cols);
    ctx.fillStyle = col;
    for (var x = 0; x < cols; x++) {
      var top = mid - p.max[x] * (mid - 4);
      var bot = mid - p.min[x] * (mid - 4);
      ctx.fillRect(x, top, 1, Math.max(1, bot - top));
    }

    var d = buf.duration;
    var pos = this.position();
    var px = (pos / d) * w;
    ctx.strokeStyle = "#111";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(px, 0); ctx.lineTo(px, h); ctx.stroke();

    ctx.fillStyle = "#666";
    ctx.font = "10px ui-monospace, monospace";
    ctx.fillText(pos.toFixed(2) + " / " + d.toFixed(2) + " s", 6, 12);
  };

  MorphPlayer.prototype.drawStrip = function () {
    var f = fitCanvas(this.strip);
    if (!f) return;
    var ctx = f.ctx, w = f.w, h = f.h;
    ctx.fillStyle = "#fafafa";
    ctx.fillRect(0, 0, w, h);

    if (this.stripView === "env") this.drawEnvelopes(ctx, w, h);
    else this.drawSteps(ctx, w, h);
  };

  MorphPlayer.prototype.drawSteps = function (ctx, w, h) {
    var n = this.steps;
    var gap = 2;
    var cw = (w - gap * (n - 1)) / n;
    var padB = 12;
    var bh = h - padB;
    for (var i = 0; i < n; i++) {
      var x0 = i * (cw + gap);
      var a = n > 1 ? i / (n - 1) : 0;
      var buf = this.buffers[i];
      var sel = i === this.idx;

      ctx.fillStyle = sel ? "#fff" : "#f2f2f2";
      ctx.fillRect(x0, 0, cw, bh);

      if (buf) {
        var cols = Math.max(1, Math.floor(cw));
        var p = peaks(buf, cols);
        var mid = bh / 2;
        ctx.fillStyle = lerpColor(SRC_COLOR, TGT_COLOR, a);
        ctx.globalAlpha = sel ? 1 : 0.55;
        for (var x = 0; x < cols; x++) {
          var top = mid - p.max[x] * (mid - 3);
          var bot = mid - p.min[x] * (mid - 3);
          ctx.fillRect(x0 + x, top, 1, Math.max(1, bot - top));
        }
        ctx.globalAlpha = 1;
      } else {
        ctx.strokeStyle = "#ddd";
        ctx.beginPath();
        ctx.moveTo(x0 + 2, bh / 2); ctx.lineTo(x0 + cw - 2, bh / 2);
        ctx.stroke();
      }

      if (sel) {
        ctx.strokeStyle = "#111";
        ctx.lineWidth = 1;
        ctx.strokeRect(x0 + 0.5, 0.5, cw - 1, bh - 1);
      }

      if (i === 0 || i === n - 1 || (n > 4 && i === Math.floor((n - 1) / 2))) {
        ctx.fillStyle = "#666";
        ctx.font = "9px ui-monospace, monospace";
        ctx.textAlign = "center";
        ctx.fillText(a.toFixed(1), x0 + cw / 2, h - 2);
        ctx.textAlign = "left";
      }
    }
  };

  MorphPlayer.prototype.drawEnvelopes = function (ctx, w, h) {
    var n = this.steps;
    var padB = 12, padT = 4;
    var bh = h - padB - padT;
    var maxv = 1e-6;
    var envs = [];
    for (var i = 0; i < n; i++) {
      var b = this.buffers[i];
      if (!b) { envs.push(null); continue; }
      var e = envelope(b);
      envs.push(e);
      for (var k = 0; k < e.length; k++) if (e[k] > maxv) maxv = e[k];
    }
    ctx.strokeStyle = "#e5e5e5";
    ctx.beginPath();
    ctx.moveTo(0, padT + bh); ctx.lineTo(w, padT + bh); ctx.stroke();

    for (var i2 = 0; i2 < n; i2++) {
      var env = envs[i2];
      if (!env) continue;
      var a = n > 1 ? i2 / (n - 1) : 0;
      var sel = i2 === this.idx;
      ctx.strokeStyle = lerpColor(SRC_COLOR, TGT_COLOR, a);
      ctx.globalAlpha = sel ? 1 : 0.35;
      ctx.lineWidth = sel ? 2 : 1;
      ctx.beginPath();
      for (var k2 = 0; k2 < env.length; k2++) {
        var x = (k2 / (env.length - 1)) * w;
        var y = padT + bh - (env[k2] / maxv) * bh;
        if (k2 === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.lineWidth = 1;
    ctx.fillStyle = "#666";
    ctx.font = "9px ui-monospace, monospace";
    ctx.fillText("RMS envelope, all steps (blue = source, orange = target)", 4, h - 2);
  };

  /* ---------------------------------------------------------- bootstrap */

  function renderInto(host, manifest) {
    var group = host.getAttribute("data-group");
    var only = host.getAttribute("data-example");
    var methodAttr = host.getAttribute("data-methods");
    var compact = host.hasAttribute("data-compact");
    var limit = parseInt(host.getAttribute("data-limit") || "0", 10);

    var list = manifest.examples.filter(function (ex) {
      if (only) return ex.id === only;
      if (group) return ex.group === group;
      return true;
    });
    if (limit > 0) list = list.slice(0, limit);

    if (!list.length) {
      host.appendChild(el("p", "placeholder-note",
        "No examples yet for this section — add entries to data/examples.json."));
      return;
    }

    list.forEach(function (ex) {
      var methodKeys = methodAttr
        ? methodAttr.split(",").map(function (s) { return s.trim(); })
        : Object.keys(ex.methods);
      methodKeys = methodKeys.filter(function (k) { return ex.methods[k]; });

      var node = el("div");
      host.appendChild(node);
      new MorphPlayer(node, ex, methodKeys[0], manifest,
                      { compact: compact, methodKeys: methodKeys });
    });
  }

  function init() {
    var hosts = document.querySelectorAll("[data-morph-group]");
    if (!hosts.length) return;
    fetch("data/examples.json")
      .then(function (r) {
        if (!r.ok) throw new Error("examples.json " + r.status);
        return r.json();
      })
      .then(function (manifest) {
        hosts.forEach(function (h) { renderInto(h, manifest); });
      })
      .catch(function (e) {
        hosts.forEach(function (h) {
          h.appendChild(el("p", "placeholder-note",
            "Could not load data/examples.json (" + e.message +
            "). Serve this page over HTTP, e.g. python3 -m http.server 8080."));
        });
      });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }

  window.MorphPlayer = MorphPlayer;
})();

"use strict";

(() => {
  // client/main.ts - Beast lair admin editor.
  //
  // Owns the webview lifecycle for the lair editor: show/focus on
  // "hmp-beast-lairs:open", Escape as a client-side safety net, and forwarding
  // of page actions to the server. The page only ever talks to us through
  // callEvent(); we relay to the server with Events.emitServer and push models
  // back down with Web.emit.

  const RESOURCE = "hmp-beast-lairs";
  const VIEW_URL = `fw://resources/${RESOURCE}/dist/lairs.html`;
  const Input = Imports.get("hmp-lib").input;

  let view = -1;
  let ready = false;
  let visible = false;
  let stopped = false;
  let controlLease = null;
  let model = null;

  function parse(payload) {
    if (typeof payload === "string") {
      try { return JSON.parse(payload); } catch (_) { return {}; }
    }
    return payload && typeof payload === "object" ? payload : {};
  }

  function lock(value) {
    if (!Input || !Input.controls) return;
    if (value && !controlLease) controlLease = Input.controls.acquire({ resource: RESOURCE, id: "editor" });
    else if (!value && controlLease) {
      try { controlLease.release(); } catch (_) { /* already gone */ }
      controlLease = null;
    }
  }

  function server(event, payload) {
    Events.emitServer(event, JSON.stringify(payload || {}));
  }

  function ensureView() {
    if (view >= 0) return view;
    try {
      view = Web.createView(VIEW_URL, { visible: false });
    } catch (_) {
      view = -1;
    }
    if (view >= 0) {
      Web.on(view, "ready", () => {
        ready = true;
        if (visible && model) Web.emit(view, "hmp-beast-lairs:model", model);
      });
      // Page -> server relays. Each one is just forwarded; the server decides
      // whether the player is actually allowed to do anything.
      Web.on(view, "save", (payload) => {
        const value = parse(payload);
        server("hmp-beast-lairs:action", { action: "save", lair: value.lair });
      });
      Web.on(view, "delete", (payload) => {
        const value = parse(payload);
        server("hmp-beast-lairs:action", { action: "delete", key: String(value.key || "") });
      });
      Web.on(view, "reload", () => server("hmp-beast-lairs:action", { action: "reload" }));
      Web.on(view, "position", () => server("hmp-beast-lairs:action", { action: "position" }));
      Web.on(view, "close", () => hide());
    }
    return view;
  }

  function show(payload) {
    if (stopped) return;
    model = payload || model || {};
    if (ensureView() < 0) {
      Game.notify("[lairs] The lair editor is not ready yet.");
      return;
    }
    visible = true;
    Web.showView(view);
    Web.focusView(view);
    lock(true);
    if (ready) Web.emit(view, "hmp-beast-lairs:model", model);
  }

  function hide() {
    if (!visible) return;
    visible = false;
    if (view >= 0) Web.hideView(view);
    lock(false);
    server("hmp-beast-lairs:action", { action: "close" });
  }

  Events.on("hmp-beast-lairs:open", (payload) => show(parse(payload)));
  Events.on("hmp-beast-lairs:model", (payload) => {
    model = parse(payload);
    if (view >= 0 && ready && visible) Web.emit(view, "hmp-beast-lairs:model", model);
  });
  Events.on("hmp-beast-lairs:position", (payload) => {
    if (view >= 0 && ready && visible) Web.emit(view, "hmp-beast-lairs:position", parse(payload));
  });
  Events.on("hmp-beast-lairs:notice", (payload) => {
    if (view >= 0 && ready && visible) Web.emit(view, "hmp-beast-lairs:notice", parse(payload));
  });
  Events.on("hmp-beast-lairs:error", (payload) => {
    const value = parse(payload);
    if (view >= 0 && ready && visible) Web.emit(view, "hmp-beast-lairs:error", value);
    else Game.notify(`[lairs] ${value.message || "Error"}`);
  });
  Events.on("hmp-beast-lairs:close", () => hide());

  // Escape always works, even if the page itself stopped responding.
  try {
    Input?.shortcuts?.register({
      resource: RESOURCE,
      id: "close",
      key: "escape",
      state: "down",
      priority: 1000,
      when: () => visible,
      handler: () => hide()
    });
  } catch (error) {
    console.warn(`[${RESOURCE}] escape shortcut unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }

  Events.on("resourceStop", (name) => {
    if (name && name !== RESOURCE) return;
    stopped = true;
    visible = false;
    lock(false);
    if (view >= 0) {
      try { Web.destroyView(view); } catch (_) { /* already gone */ }
      view = -1;
      ready = false;
    }
    Input?.cleanup?.(RESOURCE);
  });

  // Warm the page before the first visit so the editor opens instantly.
  try { ensureView(); } catch (_) { /* recreated on demand */ }
  console.info(`[${RESOURCE}] beast lair editor client ready`);
})();

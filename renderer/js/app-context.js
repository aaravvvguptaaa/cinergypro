// Shared application context populated at startup (avoids circular imports between panels).
export const app = {
  store: null, prefs: null, commands: null, dock: null, player: null, audio: null, actions: null,
  info: null, caps: null, gl: null, compositor: null, pool: null, jobs: null, panels: {},
  timeline: null, program: null, source: null,
};
window.__app = app;

# ci agent memory

One file per finding; this index is what loads. Read the file before relying on
its one-line summary. A runner, cache or host that behaved differently from what
its workflow file says goes in its own file and gets a line here. A lesson every
lane needs goes to `lane-protocol` instead.

- [Playwright 1.64 breaks cef-floor](playwright-1-64-breaks-cef-floor.md) — stay
  on 1.63.x until the floor Chromium is 105 or newer
- [mariadb init server answers the socket](mariadb-image-init-server-answers-the-socket.md)
  — probe DB readiness over TCP; the socket passes ~35 ms, then a 1–2 s gap

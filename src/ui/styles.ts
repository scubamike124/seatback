export const APP_CSS = /* css */ `
:root {
  --bg: #f5f3ee;
  --surface: #ffffff;
  --surface-2: #faf8f4;
  --ink: #16212b;
  --ink-2: #4a5866;
  --ink-3: #5f6b78;
  --line: #e3ded4;
  --navy: #123a5c;
  --navy-ink: #ffffff;
  --accent: #f4b740;
  --origin: #2f6fa8;
  --dest: #d9623b;
  --both: #5b8a5a;
  --dest-ink: #b4431f;
  --both-ink: #3f6f3e;
  --warn-bg: #fff4d6;
  --warn-ink: #6b4b00;
  --err-bg: #fde8e4;
  --err-ink: #8a2a16;
  --radius: 14px;
  --shadow: 0 1px 2px rgba(18, 33, 43, .06), 0 6px 20px rgba(18, 33, 43, .06);
  --mono: ui-monospace, "SF Mono", Menlo, Consolas, monospace;
  --sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #0f151b;
    --surface: #161e26;
    --surface-2: #1b252f;
    --ink: #e8edf2;
    --ink-2: #b3bfcb;
    --ink-3: #8593a1;
    --line: #26323e;
    --navy: #0b2a44;
    --origin: #6aa8e0;
    --dest: #f08a64;
    --both: #8cbf8a;
    --dest-ink: #f08a64;
    --both-ink: #8cbf8a;
    --warn-bg: #3a2f10;
    --warn-ink: #f6dc9a;
    --err-bg: #3b1d16;
    --err-ink: #f7b9a8;
    --shadow: 0 1px 2px rgba(0, 0, 0, .3), 0 8px 24px rgba(0, 0, 0, .25);
    color-scheme: dark;
  }
}
* { box-sizing: border-box; }
html, body { margin: 0; }
body { background: var(--bg); color: var(--ink); font: 15px/1.5 var(--sans); }
h1, h2, h3 { line-height: 1.2; margin: 0 0 .5rem; }
h1 { font-size: 1.9rem; letter-spacing: -.01em; }
h2 { font-size: 1rem; text-transform: uppercase; letter-spacing: .08em; color: var(--ink-2); }
h3 { font-size: 1.05rem; }
button, input, textarea { font: inherit; color: inherit; }
.hint { color: var(--ink-3); font-size: .85rem; }
.small { font-size: .78rem; }
.banner { background: var(--warn-bg); color: var(--warn-ink); padding: .6rem 1rem; text-align: center; font-size: .9rem; position: sticky; top: 0; z-index: 10; border-bottom: 1px solid var(--line); }
@media (max-width: 640px) { .banner { position: static; font-size: .8rem; } }

.topbar { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: .9rem 1.25rem; background: var(--navy); color: var(--navy-ink); }
.brand { display: flex; align-items: center; gap: .8rem; min-width: 0; }
.logo { width: 34px; height: 34px; flex: none; }
.logo rect { fill: #0c2a44; } .logo path { fill: none; stroke: var(--accent); stroke-width: 3; stroke-linecap: round; }
.name { font-weight: 700; font-size: 1.2rem; letter-spacing: .02em; margin: 0; color: inherit; }
.lead { font-size: 1.9rem; letter-spacing: -.01em; text-transform: none; color: var(--ink); }
.tag { font-size: .82rem; opacity: .8; }
.mode { font: 600 .75rem/1 var(--mono); letter-spacing: .08em; padding: .45rem .7rem; border-radius: 999px; background: rgba(255,255,255,.12); white-space: nowrap; }
.mode.live { background: #1f7a4d; } .mode.synthetic { background: var(--accent); color: #2b1d00; }

.layout { display: grid; grid-template-columns: minmax(300px, 380px) 1fr; gap: 1.25rem; padding: 1.25rem; max-width: 1400px; margin: 0 auto; }
@media (max-width: 900px) { .layout { grid-template-columns: 1fr; padding: 1rem; } }
.panel { display: flex; flex-direction: column; gap: 1rem; }
.panel > section, .panel > details { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 1rem; box-shadow: var(--shadow); }
form label { display: block; font-weight: 600; font-size: .9rem; margin: .7rem 0 .25rem; }
input:not([type=checkbox]):not([type=range]):not([type=file]), textarea { width: 100%; padding: .55rem .65rem; border: 1px solid var(--line); border-radius: 10px; background: var(--surface-2); font-weight: 400; }
textarea { font: .85rem/1.45 var(--mono); resize: vertical; }
input:focus-visible, textarea:focus-visible, button:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent) 70%, transparent); outline-offset: 1px; }
.route-inputs { display: grid; grid-template-columns: 1fr auto 1fr; align-items: end; gap: .5rem; }
.route-inputs label { margin-top: .3rem; }
.plane { width: 22px; height: 22px; fill: var(--ink-3); margin-bottom: .6rem; transform: rotate(90deg); }
.mix input { width: 100%; accent-color: var(--dest); }
.mix output { display: block; font: 500 .8rem var(--mono); color: var(--ink-2); }
.row { display: flex; align-items: center; justify-content: space-between; gap: .5rem; margin-top: .5rem; }
.options { border: 1px dashed var(--line); border-radius: 10px; margin: .8rem 0; padding: .4rem .8rem .8rem; }
.options legend { font-size: .8rem; color: var(--ink-3); padding: 0 .3rem; }
.check { display: flex; align-items: center; gap: .45rem; font-weight: 500; }
.file { position: relative; overflow: hidden; display: inline-flex; align-items: center; margin: 0; font-weight: 500; font-size: .9rem; cursor: pointer; border: 1px solid var(--line); border-radius: 10px; padding: .5rem .8rem; }
.file input { position: absolute; inset: 0; width: 100%; height: 100%; opacity: 0; cursor: pointer; }
.file:focus-within { outline: 3px solid color-mix(in srgb, var(--accent) 70%, transparent); }
.inline { display: flex; align-items: center; gap: .5rem; font-weight: 500; font-size: .85rem; }
.inline input { width: 8.5rem !important; }
.slots { display: grid; grid-template-columns: repeat(4, 1fr); gap: .4rem; }
.slots label { font-size: .78rem; margin-top: .5rem; }
button { cursor: pointer; border-radius: 10px; border: 1px solid var(--line); background: var(--surface-2); padding: .5rem .8rem; }
button:disabled { opacity: .6; cursor: progress; }
.primary { width: 100%; background: var(--navy); color: #fff; border-color: var(--navy); font-weight: 700; padding: .75rem; }
.ghost { background: transparent; }
.example-list { display: grid; gap: .5rem; }
.build > summary { list-style: none; cursor: pointer; display: flex; align-items: center; justify-content: space-between; }
.build > summary::-webkit-details-marker { display: none; }
.build > summary::after { content: '+'; font: 700 1.2rem var(--mono); color: var(--ink-3); }
.build[open] > summary::after { content: '-'; }
.build > summary h2 { margin: 0; }
.calls { margin: 0; padding: .45rem .55rem; list-style: none; background: var(--surface-2); border-radius: 8px; font: .72rem/1.45 var(--mono); color: var(--ink-2); }
.calls li { overflow-wrap: anywhere; }
.calls .who { color: var(--ink); font-weight: 700; }
.badge.single-end { color: var(--ink-2); border-style: dashed; }
.topbar-actions { display: flex; flex-wrap: wrap; gap: .5rem; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
.example { text-align: left; display: grid; gap: .1rem; padding: .65rem .8rem; background: var(--surface-2); }
.example b { font-size: .95rem; } .example span { color: var(--ink-3); font-size: .8rem; }
.example .code { font: 700 .8rem var(--mono); color: var(--dest-ink); letter-spacing: .06em; }

.results { min-width: 0; }
.empty, .confirm, .error, .pass, .tabpanel { background: var(--surface); border: 1px solid var(--line); border-radius: var(--radius); padding: 1.25rem; box-shadow: var(--shadow); }
.empty p { max-width: 62ch; color: var(--ink-2); }
.how { padding-left: 1.2rem; max-width: 64ch; } .how li { margin: .45rem 0; color: var(--ink-2); }
.error { background: var(--err-bg); color: var(--err-ink); margin-bottom: 1rem; }
.qloo-status { display: flex; flex-wrap: wrap; align-items: center; gap: .6rem; padding: .5rem 1.25rem; font: 600 .85rem/1.3 var(--mono); border-bottom: 1px solid var(--line); background: var(--surface); }
.qloo-status .badge { padding: .25rem .6rem; border-radius: 999px; color: #fff; letter-spacing: .06em; }
.qloo-status.mock .badge { background: #8a4b00; } .qloo-status.live .badge { background: #14663a; } .qloo-status.dry .badge { background: #4a4a4a; }
.limits-panel { margin: 1rem 0; padding: .75rem 1rem; border: 1px solid var(--line); border-left: 4px solid #8a4b00; border-radius: var(--radius); }
.limits-panel summary { cursor: pointer; font-weight: 700; } .limits-panel li { margin: .35rem 0; }
.ambig { margin-bottom: 1rem; padding: 1rem; border: 1px solid var(--line); border-left: 4px solid #8a4b00; border-radius: var(--radius); background: var(--surface); }
.ambig li { margin: .25rem 0; } .conf { font-family: var(--mono); font-size: .8rem; }
.confirm { margin-bottom: 1rem; } .confirm .choices { display: flex; flex-wrap: wrap; gap: .5rem; margin: .5rem 0 1rem; }

.pass { display: grid; grid-template-columns: 1fr auto 1fr; gap: 1rem; align-items: start; border-top: 6px solid var(--navy); position: relative; }
.pass .end h3 { font-size: 1.6rem; margin: .1rem 0 .3rem; }
.pass .end.dest { text-align: right; }
.pass .label { font: 700 .7rem var(--mono); letter-spacing: .14em; color: var(--ink-3); }
.pass .chips { display: flex; flex-wrap: wrap; gap: .3rem; margin-top: .4rem; }
.pass .end.dest .chips { justify-content: flex-end; }
.pass .mid { text-align: center; padding-top: 1.1rem; min-width: 150px; }
.mixbar { display: flex; height: 8px; border-radius: 999px; overflow: hidden; margin: .4rem 0; background: var(--line); }
.mixbar .o { background: var(--origin); } .mixbar .d { background: var(--dest); }
.chip { display: inline-flex; align-items: center; gap: .25rem; font-size: .75rem; padding: .15rem .5rem; border-radius: 999px; background: var(--surface-2); border: 1px solid var(--line); color: var(--ink-2); }
.chip.o { border-color: color-mix(in srgb, var(--origin) 45%, var(--line)); }
.chip.d { border-color: color-mix(in srgb, var(--dest) 45%, var(--line)); }
.anchors { font-size: .78rem; color: var(--ink-3); margin-top: .4rem; }
.anchors summary { font-size: .78rem; }
@media (max-width: 640px) { .pass { grid-template-columns: 1fr; } .pass .end.dest { text-align: left; } .pass .end.dest .chips { justify-content: flex-start; } .pass .mid { text-align: left; padding: 0; } }

.tabs-wrap { position: relative; margin: 1rem 0 .6rem; }
.tabs { display: flex; gap: .25rem; overflow-x: auto; scrollbar-width: thin; }
@media (max-width: 760px) {
  /* Tabs wrap onto rows on a phone, so none is hidden off-screen. */
  .tabs { flex-wrap: wrap; overflow-x: visible; }
  .tabs button { padding: .45rem .7rem; font-size: .85rem; border: 1px solid var(--line); }
  .pass .chips { display: none; }
  .pass { gap: .5rem; padding: .9rem 1rem; }
  .pass .end h3 { font-size: 1.3rem; }
}
.tabs button { border: none; background: transparent; padding: .55rem .85rem; border-radius: 999px; color: var(--ink-2); font-weight: 600; white-space: nowrap; }
.tabs button[aria-selected=true] { background: var(--navy); color: #fff; }
.tabpanel { padding: 1.1rem; }

.note { border-left: 4px solid var(--accent); background: var(--surface-2); padding: .7rem .9rem; border-radius: 8px; margin-bottom: 1rem; }
.note p { margin: .2rem 0; }
.split { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: .6rem; margin-bottom: 1.2rem; }
.split > div { background: var(--surface-2); border-radius: 10px; padding: .6rem .7rem; }
.split h4 { margin: 0 0 .35rem; font-size: .75rem; letter-spacing: .08em; text-transform: uppercase; color: var(--ink-3); }
@media (max-width: 640px) { .split { grid-template-columns: 1fr; } }

.domain { margin: 1.4rem 0 .6rem; display: flex; align-items: baseline; justify-content: space-between; gap: .5rem; flex-wrap: wrap; }
.domain h3 { margin: 0; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: .7rem; }
.card { border: 1px solid var(--line); border-radius: 12px; padding: .8rem .9rem; background: var(--surface); display: flex; flex-direction: column; gap: .45rem; }
.card .top { display: flex; align-items: baseline; gap: .55rem; }
.card .rank { font: 700 .8rem var(--mono); color: var(--ink-3); }
.card .title { font-weight: 700; font-size: 1rem; flex: 1; min-width: 0; overflow-wrap: anywhere; }
.card .fit { font: 700 1.1rem var(--mono); }
.fitbar { display: flex; height: 6px; border-radius: 999px; overflow: hidden; background: var(--line); }
.fitbar .o { background: var(--origin); } .fitbar .d { background: var(--dest); }
.badges { display: flex; flex-wrap: wrap; gap: .3rem; }
.badge { font-size: .7rem; font-weight: 700; letter-spacing: .03em; padding: .12rem .45rem; border-radius: 6px; background: var(--surface-2); color: var(--ink-2); border: 1px solid var(--line); }
.badge.origin { color: var(--origin); } .badge.destination { color: var(--dest-ink); } .badge.both { color: var(--both-ink); }
.badge.syn { background: var(--warn-bg); color: var(--warn-ink); border-color: transparent; }
.why { margin: 0; padding-left: 1rem; font-size: .84rem; color: var(--ink-2); }
.ev { font: 600 .72rem var(--mono); border: 1px solid var(--line); background: var(--surface-2); border-radius: 6px; padding: 0 .4rem; margin: 2px 0 2px .25rem; color: var(--ink-2); min-height: 24px; min-width: 32px; display: inline-flex; align-items: center; justify-content: center; vertical-align: middle; }
.ev:hover { border-color: var(--accent); }
details { margin-top: .6rem; } summary { cursor: pointer; color: var(--ink-2); font-size: .88rem; }
.mini { font-size: .84rem; color: var(--ink-2); margin: .3rem 0 0; padding-left: 1rem; }
.rail { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: .5rem; }
.rail .item { background: var(--surface-2); border-radius: 10px; padding: .55rem .7rem; font-size: .85rem; }
.rail .item b { display: block; }
.toolbar { display: flex; gap: .5rem; flex-wrap: wrap; justify-content: flex-end; margin-top: 1rem; }

.trace { list-style: none; margin: 0; padding: 0; }
.trace li { display: grid; grid-template-columns: 20px 1fr; gap: .6rem; padding: .45rem 0; border-bottom: 1px solid var(--line); }
.trace .dot { width: 12px; height: 12px; border-radius: 50%; margin-top: .35rem; background: var(--ink-3); }
.trace .ok .dot { background: var(--both); } .trace .warn .dot { background: var(--accent); } .trace .error .dot { background: var(--dest); }
.trace .run .dot { background: var(--origin); animation: pulse 1s infinite; }
.trace .decision .dot { background: transparent; border: 2px solid var(--accent); }
.trace .lbl { font-weight: 600; } .trace .det { color: var(--ink-2); font-size: .85rem; }
@keyframes pulse { 50% { opacity: .35; } }
@media (prefers-reduced-motion: reduce) { .trace .run .dot { animation: none; } }

.cmp { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
@media (max-width: 760px) { .cmp { grid-template-columns: 1fr; } }
.cmp ul { padding-left: 1.1rem; margin: .3rem 0; }
.metric { display: inline-block; margin: 0 1.2rem .6rem 0; }
.metric b { display: block; font: 700 1.4rem var(--mono); }
.metric span { color: var(--ink-3); font-size: .78rem; }
.caveat { background: var(--surface-2); border-radius: 10px; padding: .7rem .9rem; color: var(--ink-2); font-size: .86rem; }

.evtable { width: 100%; border-collapse: collapse; font-size: .82rem; }
.evtable th, .evtable td { border-bottom: 1px solid var(--line); padding: .45rem .4rem; text-align: left; vertical-align: top; }
.evtable code { font: .75rem var(--mono); overflow-wrap: anywhere; color: var(--ink-2); }
.evtable tr.flash { background: color-mix(in srgb, var(--accent) 25%, transparent); }
.scroll { overflow-x: auto; }
/* No empty boarding-pass shell after an error */
.pass:empty { display: none; }
/* Evidence: stacked, collapsed rows with a height cap (no table to clip on a phone) */
.evlist { list-style: none; margin: .4rem 0; padding: 0; max-height: 70vh; overflow-y: auto; border: 1px solid var(--line); border-radius: 10px; }
.evlist li { border-bottom: 1px solid var(--line); }
.evlist li:last-child { border-bottom: 0; }
.evrow summary { display: grid; grid-template-columns: auto 1fr; column-gap: .6rem; row-gap: .1rem; padding: .55rem .7rem; cursor: pointer; font-size: .86rem; list-style-position: inside; }
.evrow .evid { font: 700 .78rem var(--mono); }
.evrow .evt { min-width: 0; overflow-wrap: anywhere; }
.evrow .evm { grid-column: 2; color: var(--ink-3); font-size: .78rem; }
.evrow .evbody { padding: 0 .7rem .7rem; min-width: 0; }
.evrow .evbody code { display: block; font: .75rem var(--mono); overflow-wrap: anywhere; word-break: break-all; color: var(--ink-2); }
.evrow.flash { background: color-mix(in srgb, var(--accent) 25%, transparent); }
.swap { margin: .6rem 0 .2rem; }
.swap-line { margin: 0; font-size: 1rem; padding: .5rem .7rem; border-left: 4px solid var(--accent); background: var(--surface-2); border-radius: 0 8px 8px 0; overflow-wrap: anywhere; }
.swap-more summary { font-size: .82rem; color: var(--ink-3); cursor: pointer; margin-top: .3rem; }
.foot { text-align: center; color: var(--ink-3); font-size: .78rem; padding: 1.5rem 1rem 2.5rem; }

/* Accessibility helpers */
.skip { position: absolute; left: -9999px; top: 0; z-index: 20; background: var(--navy); color: var(--navy-ink); padding: .5rem .9rem; border-radius: 0 0 8px 0; }
.skip:focus { left: 0; }
.visually-hidden { position: absolute; width: 1px; height: 1px; margin: -1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0; }
.results:focus { outline: none; }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }

/* Landing facts */
.facts { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: .6rem; margin: 1rem 0 .4rem; max-width: 760px; }
.fact { background: var(--surface-2); border: 1px solid var(--line); border-radius: 12px; padding: .7rem .8rem; }
.fact b { display: block; font: 700 1.35rem var(--mono); color: var(--navy); }
@media (prefers-color-scheme: dark) { .fact b { color: var(--accent); } }
.fact span { font-size: .8rem; color: var(--ink-2); }

/* At a glance */
.glance { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: .5rem; margin: 0 0 1rem; }
.glance .tile { background: var(--surface-2); border: 1px solid var(--line); border-radius: 12px; padding: .6rem .75rem; }
.glance .tile b { display: block; font: 700 1.15rem var(--mono); color: var(--ink); overflow-wrap: anywhere; }
.glance .tile span { font-size: .76rem; color: var(--ink-2); }

/* Card fold */
details.more { margin-top: .2rem; }
details.more summary { font-size: .8rem; }

/* Network map */
.network { margin: .5rem 0 1rem; }
.netgrid { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: 1rem; align-items: start; }
@media (max-width: 760px) { .netgrid { grid-template-columns: 1fr; } }
.netmap { width: 100%; height: auto; background: var(--surface-2); border: 1px solid var(--line); border-radius: 12px; }
.netmap .land { fill: var(--surface); stroke: var(--line); stroke-width: 1.5; }
.netmap .route { stroke: var(--ink-2); stroke-width: 2; stroke-dasharray: 5 4; }
.netmap .city circle { fill: var(--ink-3); opacity: .35; }
.netmap .city.ranked circle { fill: var(--both); opacity: .55; }
.netmap .city.top circle { fill: var(--both); opacity: .95; stroke: var(--surface); stroke-width: 1.5; }
.netmap .city.withheld circle { fill: none; stroke: var(--accent); stroke-width: 2; opacity: 1; }
.netmap .city.end circle { fill: var(--navy); opacity: 1; stroke: var(--accent); stroke-width: 2; }
@media (prefers-color-scheme: dark) { .netmap .city.end circle { fill: var(--accent); } }
.netmap text { font: 700 11px var(--mono); fill: var(--ink); }
h3.section { margin: 1.6rem 0 .2rem; padding-top: 1rem; border-top: 1px solid var(--line); }
.netlist { margin: .3rem 0; padding-left: 1.2rem; font-size: .9rem; }
.netlist b { font-family: var(--mono); }

/* Phone header: short tagline, pill never squeezes the title */
.tag-short { display: none; }
@media (max-width: 640px) {
  .topbar { flex-wrap: wrap; padding: .7rem 1rem; gap: .5rem; }
  .tag-long { display: none; } .tag-short { display: inline; }
  .tag { opacity: .85; }
  .mode { font-size: .68rem; padding: .35rem .6rem; }
  h1 { font-size: 1.6rem; }
  .lead { font-size: 1.5rem; }
}
.howto { margin: .6rem 0; } .howto summary { font-weight: 600; }

/* The Answer: first screen of the result */
.answer { border: 2px solid var(--navy); border-radius: var(--radius); padding: 1rem 1.1rem; margin-bottom: 1rem; background: var(--surface); }
.answer .looking { margin: 0 0 .6rem; padding: .5rem .7rem; background: var(--bg-soft, #f4f6fa); border-left: 3px solid var(--navy); border-radius: 4px; font-size: .95rem; }
.answer .honest, .answer .qloo-evidence { margin-top: .7rem; font-size: .9rem; }
.answer .honest h4, .answer .qloo-evidence h4 { margin: 0 0 .2rem; }
.answer .how-it-works > summary { cursor: pointer; font-weight: 600; }
.answer h3 { margin: .1rem 0 .4rem; font-size: 1.3rem; }
.answer .label { font: 700 .7rem var(--mono); letter-spacing: .14em; color: var(--ink-3); }
.ans-dom { margin: .8rem 0 .2rem; font-size: .8rem; text-transform: uppercase; letter-spacing: .08em; color: var(--ink-2); }
.ans-list { list-style: none; margin: 0; padding: 0; }
.ans-list li { display: flex; align-items: center; justify-content: space-between; gap: .6rem; padding: .4rem 0; border-bottom: 1px solid var(--line); }
.ans-t { font-weight: 700; min-width: 0; overflow-wrap: anywhere; }
.ans-n { display: flex; gap: .7rem; flex: none; }
.ans-n .n { display: flex; flex-direction: column; align-items: center; min-width: 3.2rem; }
.ans-n b { font: 700 1.05rem var(--mono); }
.ans-n i { font-style: normal; font-size: .66rem; color: var(--ink-3); white-space: nowrap; }
.ans-actions { justify-content: flex-start; flex-wrap: wrap; margin-top: .8rem; }
.primary-sm { background: var(--navy); color: #fff; border-color: var(--navy); font-weight: 700; }
.syn-note { display: inline-block; background: var(--warn-bg); color: var(--warn-ink); border-radius: 6px; padding: .15rem .5rem; font-size: .8rem; font-weight: 600; margin: .2rem 0; }
details.worked { margin-top: .8rem; } details.worked summary { font-weight: 600; color: var(--ink); }
@media (max-width: 640px) {
  .ans-list li { flex-direction: column; align-items: flex-start; gap: .25rem; }
  .ans-n { gap: .5rem; }
  .answer { padding: .8rem; }
}
details.fullslate { margin-top: 1rem; }
details.fullslate > summary { font-weight: 700; color: var(--ink); padding: .6rem .8rem; border: 1px dashed var(--line); border-radius: 10px; }

/* Evidence links are collapsed by default; they show inside opened details, or when switched on */
#tab-slate .ev { display: none; }
#tab-slate.evon .ev, #tab-slate details[open] .ev { display: inline-flex; }
.card .fit.onecity { font-size: .72rem; font-weight: 600; color: var(--ink-2); border: 1px dashed var(--line); border-radius: 6px; padding: .1rem .35rem; white-space: nowrap; }

/* Glance tiles: a short word on top, never a wrapped sentence in monospace */
.glance .tile b { overflow-wrap: normal; white-space: nowrap; }
.glance { grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); }
@media (max-width: 640px) { .glance { grid-template-columns: 1fr 1fr; } .glance .tile b { font-size: 1rem; } }

/* Comparison */
.caveat.strong { border-left: 4px solid var(--accent); }
.ran { font-weight: 600; }
.cmp-table td, .cmp-table th { min-width: 6rem; }
.cmp-table tr.me { background: color-mix(in srgb, var(--accent) 12%, transparent); }

/* First screen: the question, then one-click answers. */
.question { font-size: 1.05rem; max-width: 62ch; color: var(--ink); }
.hero-ctas { display: flex; flex-wrap: wrap; gap: .6rem; margin: 1rem 0 .4rem; }
.hero-ctas .cta { min-height: 44px; padding: .6rem 1rem; font-weight: 700; border-radius: 10px; background: var(--surface-2); color: var(--ink); border: 1px solid var(--line); }
.hero-ctas .cta:first-child { background: var(--navy); color: var(--navy-ink); border-color: var(--navy); }
details.context > summary { font-weight: 600; color: var(--ink); }
/* On phones the question sits above the example buttons, in the same order as the keyboard focus order (no CSS reordering). */
.q-mobile { display: none; }
@media (max-width: 900px) { .q-mobile { display: block; margin: 0 0 .6rem; color: var(--ink); } }
/* What fed the answer: built from the run's own call ledger. */
.fedby { margin: .6rem 0 1rem; padding: .6rem .8rem; background: var(--surface-2); border: 1px solid var(--line); border-radius: 10px; }
.fedby > summary { font-weight: 600; color: var(--ink); }
.fedby ul { margin: .3rem 0; padding-left: 1.1rem; } .fedby li { margin: .25rem 0; font-size: .85rem; color: var(--ink-2); }
#tab-slate .fedby .ev { display: inline-flex; }
.dom-note { margin: -.2rem 0 .4rem; }
/* Targets of at least 24 px (WCAG 2.2 AA 2.5.8) and no motion when the user asks for none. */
summary { min-height: 24px; padding-block: .2rem; }
/* A message scrolled into view must not end up under the sticky banner. */
.error, .confirm, .answer, .evrow, #out, .tabpanel { scroll-margin-top: 3.75rem; }
.error:focus { outline: 3px solid color-mix(in srgb, var(--err-ink) 60%, transparent); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; scroll-behavior: auto !important; } }

/* Round 5: no duplicate example buttons (hero on desktop before a run, left column on phones), compact synthetic marks. */
@media (min-width: 901px) { .layout:not(.has-result) .examples { display: none; } }
@media (max-width: 900px) { .hero-ctas, #hero-note { display: none; } }
.ans-t .badge, .end h3 .badge { margin-left: .45rem; vertical-align: middle; }
#tabs-wrap { scroll-margin-top: .75rem; }
.ans-n.one { justify-content: flex-start; }
.dom-note.one-note { color: var(--ink); }
/* iPhone / Safari polish: safe-area insets, no text inflation, no input zoom, 44px tap targets */
html { -webkit-text-size-adjust: 100%; text-size-adjust: 100%; }
.topbar, .banner, .private-preview { padding-left: max(1rem, env(safe-area-inset-left)); padding-right: max(1rem, env(safe-area-inset-right)); }
.topbar { padding-top: max(.5rem, env(safe-area-inset-top)); }
body { padding-bottom: env(safe-area-inset-bottom); }
@media (max-width: 900px) {
  .layout { padding-left: max(1rem, env(safe-area-inset-left)); padding-right: max(1rem, env(safe-area-inset-right)); }
  input, textarea, select { font-size: 16px; }
  button, .ghost-btn, summary, .tabs button, [role="tab"], .cta, .primary, .primary-sm, .ghost { min-height: 44px; }
  .tabs button, [role="tab"] { min-width: 44px; padding-left: .8rem; padding-right: .8rem; }
  .answer, .answer * { overflow-wrap: anywhere; }
  img, svg, table { max-width: 100%; }
}
.private-preview { position: sticky; top: 0; z-index: 50; background: #7a1f1f; color: #fff; text-align: center; font: 600 .8rem system-ui, sans-serif; padding-top: .25rem; padding-bottom: .25rem; letter-spacing: .08em; }
@media (max-width: 900px) {
  .ev { position: relative; }
  .ev::after { content: ''; position: absolute; left: 50%; top: 50%; width: max(100%, 44px); height: 44px; transform: translate(-50%, -50%); }
  .skip { min-height: 44px; }
}
`;

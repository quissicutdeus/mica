// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import esbuild from 'esbuild';
import { createRuntime } from './lib/fivem-server-runtime.js';
import { IMAGE, openDatabase, step } from './lib/mariadb-harness.js';
import { connectAsOxmysql, createOxmysql } from './lib/oxmysql-shim.js';

/**
 * The real net-event handlers, for several players at once, against a real database (MICA-304).
 *
 * Every other suite proves a third of this. The unit tests run the handlers with the database
 * mocked; `test:schema` runs the repositories against MariaDB with no handlers; the in-server
 * suite runs the bundle inside FXServer with nobody connected. Nothing ran a call from one
 * player to another, a text and its push, or a bill paid, through the code a server actually
 * loads and the SQL it actually sends. This does.
 *
 * **What runs is the shipped server, unmodified.** `server/server.ts` is bundled by esbuild as
 * `build/build-bundle.js` bundles it, and imported against a stand-in for the FXServer runtime
 * (`lib/fivem-server-runtime.js`): `onNet`, `on`, `emitNet`, exports, convars and the player
 * natives. A "client" is a source number and a list of identifiers; firing a net event sets
 * `source` as FXServer does and waits for the handler; every `emitNet` is captured, so a push
 * is asserted as the arguments a phone would have been handed. The database is a throwaway
 * MariaDB with the shipped schema imported, reached through an oxmysql stand-in that returns
 * what oxmysql returns (`lib/oxmysql-shim.js`). Nothing in `server/` knows it is under test.
 *
 * **Two shapes.** Standalone (`mica_standalone`, identity from each player's `license:`
 * identifier, `mica.esx.sql`), and qb (`mica.sql`, a seeded `players` table, and a fake qb-core
 * whose `GetCoreObject` hands out player objects carrying money and a job). The qb core is a
 * stand-in the harness writes, not qb-core: it proves what micaOS does with what a qb core
 * answers, not that qb-core answers it.
 *
 * **What this proves:** a call between two players (ring, answer, the same id to both, end,
 * a call-log row each; busy, unreachable, declined); a job line's group ring, first answer
 * winning under a fresh id; a text written and pushed, and withheld from a player who blocked
 * the sender; settings that survive a reconnect on a new server id; an invoice billed by
 * another resource's export, paid (money moving on qb, refused on standalone) and declined;
 * an unauthenticated source refused, a client unable to raise a runtime event, and the rate
 * limit tripping. Then the export and line surface: `CreateCall` answering ok only for a call
 * that rang, and busy, unreachable, blocked and rejected each as such (MICA-276); `micacall`'s
 * console caller, source -1, never addressed (MICA-277); a line hanging up the call it
 * answered, and blocked like a number unless its owner says otherwise (MICA-278); a line told
 * of a player's text and replying into the same thread (MICA-275); `SendMessage` to a player
 * online and offline (MICA-223); qb-phone's mail events (MICA-222); and a player's own data
 * exported and deleted with another's untouched (MICA-168). qb-phone's `CustomNotification` is
 * a client event with no server half, so it is not here.
 *
 * **What this does not prove, and nothing in this repo can:** the client relay (`client/`)
 * and whether a phone acts on what it is sent; CEF and NUI; voice; a real `GetPlayerIdentifiers`
 * and a real license; FXServer's event loop, its msgpack encoding and its cross-resource
 * function references; a real qb-core, qbx_core or ox_inventory (MICA-304's qbx stack mode on
 * hoth is for that); and two statements racing on oxmysql's pool. What only a live FXServer
 * shows is the in-server suite, MICA-302.
 *
 * **A skip is never a pass.** No Docker is exit 1. Every flow asserts with `check`, and the
 * run fails if fewer than `MINIMUM_CHECKS` ran, so a flow that returns early cannot pass.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const CONTAINER_LABEL = 'mica-endpoints-harness';

let checksRun = 0;
/**
 * What each flow asserts, per shape. Held per flow as well as in total: a flow that stops
 * short fails the run even when another one grew. The group ring has two more on standalone,
 * where another resource's line is registered and its handler is seen being asked.
 */
const FLOW_CHECKS = {
  connect: { standalone: 8, qb: 8 },
  call: { standalone: 36, qb: 36 },
  groupRing: { standalone: 17, qb: 15 },
  text: { standalone: 15, qb: 15 },
  invoice: { standalone: 14, qb: 14 },
  refusals: { standalone: 9, qb: 9 },
  reconnect: { standalone: 8, qb: 8 },
  createCall: { standalone: 25, qb: 25 },
  micacall: { standalone: 15, qb: 15 },
  lineCall: { standalone: 23, qb: 23 },
  lineText: { standalone: 13, qb: 13 },
  sendMessage: { standalone: 12, qb: 12 },
  qbMail: { standalone: 10, qb: 10 },
  privacy: { standalone: 13, qb: 13 }
};
const MINIMUM_CHECKS = Object.values(FLOW_CHECKS).reduce(
  (sum, perShape) => sum + perShape.standalone + perShape.qb,
  0
);

const check = (label, actual, expected) => {
  checksRun += 1;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${label}\n    expected: ${e}\n    actual:   ${a}`);
  console.log(`    ok  ${label}`);
};

/* ------------------------------------------------------------------ the bundle */

const BUNDLE = path.join(root, 'node_modules', '.cache', 'mica-endpoints-server.mjs');

/**
 * `server/server.ts`, bundled with `build/build-bundle.js`'s options for the server target, as
 * an ES module rather than a script: Node gives a CommonJS module its own `exports`, which
 * would shadow the global FXServer provides. `shared/rpc.ts` rides along so the harness names
 * request and reply events with the same functions the client does.
 */
const buildBundle = async () => {
  step('bundling server/server.ts');
  await esbuild.build({
    stdin: {
      contents: [
        `import '${root}/server/server.ts';`,
        `export { requestEventFor, responseEventFor } from '${root}/shared/rpc.ts';`
      ].join('\n'),
      resolveDir: root,
      loader: 'ts'
    },
    bundle: true,
    platform: 'node',
    target: 'node22',
    charset: 'utf8',
    format: 'esm',
    outfile: BUNDLE,
    logLevel: 'warning'
  });
};

/* ------------------------------------------------------------------ fixtures */

const PLAYERS_TABLE = `
CREATE TABLE IF NOT EXISTS players (
    citizenid varchar(50) NOT NULL,
    charinfo text DEFAULT NULL,
    PRIMARY KEY (citizenid)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_unicode_ci;`;

/**
 * The people. Sources 1 and 2 are the two players every flow is about; 4 is a third who
 * calls the job line, since a line never rings its own caller; 3 is connected and cannot be
 * named — no identifiers on standalone, no loaded character on qb.
 */
const PEOPLE = {
  1: {
    name: 'Alice Test',
    license: 'license:' + 'a1'.repeat(20),
    citizenid: 'CIT_A',
    phone: '5550001',
    bank: 1000,
    job: 'police'
  },
  2: {
    name: 'Bob Test',
    license: 'license:' + 'b2'.repeat(20),
    citizenid: 'CIT_B',
    phone: '5550002',
    bank: 500,
    job: 'police'
  },
  4: {
    name: 'Dana Test',
    license: 'license:' + 'd4'.repeat(20),
    citizenid: 'CIT_D',
    phone: '5550004',
    bank: 100,
    job: 'unemployed'
  }
};
const NOBODY = 3;

/**
 * A qb core, as far as micaOS reads one: `GetCoreObject().Functions.GetPlayer` and
 * `GetQBPlayers`, player objects with `PlayerData` (citizenid, charinfo, money, job) and the
 * `Functions` micaOS calls. Money moves for real here, so a paid invoice changes two balances.
 */
const createQbCore = () => {
  const loaded = new Map();
  const core = {
    Functions: {
      GetPlayer: (src) => loaded.get(Number(src)) ?? null,
      GetQBPlayers: () => Object.fromEntries(loaded),
      CreateUseableItem: () => {}
    }
  };
  const playerFor = (src, person) => {
    const PlayerData = {
      source: src,
      citizenid: person.citizenid,
      charinfo: { firstname: person.name.split(' ')[0], lastname: 'Test', phone: person.phone },
      money: { bank: person.bank, cash: 0 },
      job: { name: person.job, label: person.job, onduty: true, grade: { name: 'one', level: 0 } },
      metadata: {}
    };
    return {
      PlayerData,
      Functions: {
        GetMoney: (type) => PlayerData.money[type],
        RemoveMoney: (type, amount) => {
          if (PlayerData.money[type] < amount) return false;
          PlayerData.money[type] -= amount;
          return true;
        },
        AddMoney: (type, amount) => {
          PlayerData.money[type] += amount;
          return true;
        },
        SetMetaData: (key, value) => {
          PlayerData.metadata[key] = value;
        },
        SetPlayerData: (key, value) => {
          PlayerData[key] = value;
        },
        SetJobDuty: (onDuty) => {
          PlayerData.job.onduty = onDuty;
        }
      }
    };
  };
  return {
    resource: { GetCoreObject: () => core },
    load: (src, person) => {
      const player = playerFor(src, person);
      loaded.set(src, player);
      return player;
    },
    unload: (src) => loaded.delete(src),
    bank: (src) => loaded.get(src)?.PlayerData.money.bank
  };
};

/* ------------------------------------------------------------------ one shape */

/**
 * A fresh database with the shipped schema, a fresh runtime, and a fresh copy of the bundle
 * imported into it — module state included, so nothing one shape did is visible to the next.
 */
const startShape = async ({ db, kind }) => {
  const database = `mica_endpoints_${kind}`;
  const schemaFile = kind === 'qb' ? 'mica.sql' : 'mica.esx.sql';
  const admin = db.connection;

  step(`${kind}: ${schemaFile} into \`${database}\``);
  await admin.query(`DROP DATABASE IF EXISTS \`${database}\``);
  await admin.query(`CREATE DATABASE \`${database}\``);
  await admin.changeUser({ database });
  if (kind === 'qb') {
    await admin.query(PLAYERS_TABLE);
    for (const person of Object.values(PEOPLE)) {
      await admin.query('INSERT INTO players (citizenid, charinfo) VALUES (?, ?)', [
        person.citizenid,
        JSON.stringify({
          firstname: person.name.split(' ')[0],
          lastname: 'Test',
          phone: person.phone
        })
      ]);
    }
  }
  await admin.query(fs.readFileSync(path.join(root, schemaFile), 'utf8'));

  const ox = await connectAsOxmysql(db.config, database);
  const shim = createOxmysql(ox);
  const qb = kind === 'qb' ? createQbCore() : null;
  const runtime = createRuntime({
    root,
    convars: kind === 'standalone' ? { mica_standalone: '1' } : {},
    // The resources this server can see: the database, the two that call micaOS's exports in
    // the flows below, and on qb the core.
    resources: {
      oxmysql: shim.oxmysql,
      fake_dispatch: {},
      fake_billing: {},
      fake_cab: {},
      fake_bank: {},
      fake_other: {},
      ...(qb ? { 'qb-core': qb.resource } : {})
    }
  });
  runtime.install();

  const bundle = await import(`file://${BUNDLE}?shape=${kind}`);

  /**
   * Wait until the handlers' work is done: no statement in flight and no short timer pending,
   * for several turns of the event loop. Handlers write fire-and-forget (a call-log row, a push after a write), and an
   * assertion made before those land would be about a moment nobody can observe in game.
   */
  const settle = async () => {
    const deadline = Date.now() + 10_000;
    let quiet = 0;
    while (quiet < 5) {
      if (Date.now() > deadline) throw new Error('the server never went quiet within 10s');
      await new Promise((resolve) => setImmediate(resolve));
      quiet = shim.idle() && !runtime.shortTimerPending() ? quiet + 1 : 0;
    }
  };

  let nextCb = 0;
  /**
   * A NUI round trip as the client relay makes it: `emitNet(request, cbId, data)`, then the
   * reply on the derived response event for this source and this callback id.
   */
  const call = async (src, service, action, data) => {
    const cbId = `endpoints-${++nextCb}`;
    const mark = runtime.sent.length;
    const ran = await runtime.fire(src, bundle.requestEventFor(service, action), cbId, data);
    await settle();
    if (ran === 0) throw new Error(`nothing handles ${service}:${action}`);
    const reply = runtime
      .since(mark)
      .find(
        (m) =>
          m.event === bundle.responseEventFor(service, action) &&
          m.target === src &&
          m.args[0] === cbId
      );
    if (!reply) throw new Error(`${service}:${action} from ${src} was never answered`);
    return reply.args[1];
  };

  /** A client's raw `TriggerServerEvent`, and what the server sent back to anyone because of it. */
  const fire = async (src, event, ...args) => {
    const mark = runtime.sent.length;
    const ran = await runtime.fire(src, event, ...args);
    await settle();
    return { ran, sent: runtime.since(mark) };
  };

  /** A runtime- or framework-raised event, and what it sent. */
  const raise = async (work) => {
    const mark = runtime.sent.length;
    await work();
    await settle();
    return runtime.since(mark);
  };

  /** Another resource calling one of micaOS's exports: its answer, and what it sent. */
  const invoke = async (invoker, name, ...args) => {
    const mark = runtime.sent.length;
    const result = await runtime.callExport(invoker, name, ...args);
    await settle();
    return { result, sent: runtime.since(mark) };
  };

  const connect = (src, person) =>
    raise(async () => {
      if (kind === 'standalone') {
        runtime.addPlayer(src, {
          name: person.name,
          identifiers: [person.license, `ip:127.0.0.${src}`]
        });
        await runtime.raise(src, 'playerJoining', '0');
      } else {
        runtime.addPlayer(src, { name: person.name, identifiers: [person.license] });
        const player = qb.load(src, person);
        await runtime.local('QBCore:Server:PlayerLoaded', player);
      }
    });

  const disconnect = (src) =>
    raise(async () => {
      await runtime.raise(src, 'playerDropped', 'Exiting');
      runtime.removePlayer(src);
      qb?.unload(src);
    });

  /** The citizenid a person's rows are keyed on in this shape. */
  const citizenOf = (person) => (kind === 'standalone' ? person.license : person.citizenid);

  const rows = async (sql, params = []) => (await admin.query(sql, params))[0];

  const numberOf = async (person) =>
    (
      await rows(
        "SELECT `number` FROM `mica_phone_numbers` WHERE `citizenid` = ? AND `status` = 'active' ORDER BY `id` DESC LIMIT 1",
        [citizenOf(person)]
      )
    )[0]?.number ?? null;

  await raise(() => runtime.local('onResourceStart', 'mica'));

  return {
    kind,
    runtime,
    qb,
    call,
    fire,
    raise,
    invoke,
    connect,
    disconnect,
    citizenOf,
    numberOf,
    rows,
    settle,
    stop: async () => {
      await ox.end().catch(() => {});
      runtime.shutdown();
    }
  };
};

/** Every message in `sent` with this event, to this source. */
const to = (sent, event, target) => sent.filter((m) => m.event === event && m.target === target);
const events = (sent) => sent.map((m) => `${m.target} ${m.event}`);

const INCOMING = 'mica:client:phone:incoming';
const ACCEPTED = 'mica:client:phone:accepted';
const ENDED = 'mica:client:phone:ended';
const FAILED = 'mica:client:phone:failed';
const NOTIFY = 'mica:client:shell:notify';
const RECEIVED = 'mica:client:messages:received';
const APP_EVENT = 'mica:client:shell:appEvent';

/* ------------------------------------------------------------------ the flows */

/** Everyone connects; each is issued a number and told to re-read their settings. */
const runConnect = async (shape) => {
  step(`${shape.kind}: three players connect, and one nobody can name`);
  const numbers = {};
  for (const [src, person] of Object.entries(PEOPLE)) {
    const sent = await shape.connect(Number(src), person);
    numbers[src] = await shape.numberOf(person);
    check(
      `${shape.kind}: source ${src} is told to re-read its settings on connect`,
      to(sent, 'mica:client:settings:rehydrate', Number(src)).length,
      1
    );
  }
  if (shape.kind === 'qb') {
    // A qb core issued these; micaOS adopts the framework's number rather than minting one.
    check(`${shape.kind}: each player keeps the number the framework issued`, numbers, {
      1: PEOPLE[1].phone,
      2: PEOPLE[2].phone,
      4: PEOPLE[4].phone
    });
  } else {
    check(
      `${shape.kind}: each player is issued a number of their own`,
      Object.values(numbers).every((n) => typeof n === 'string' && n.length > 0) &&
        new Set(Object.values(numbers)).size === 3,
      true
    );
  }

  // Source 3 is connected and cannot be named: no identifiers, or no character loaded.
  shape.runtime.addPlayer(NOBODY, { name: 'Nobody', identifiers: [] });
  const nobody = await shape.raise(() => shape.runtime.raise(NOBODY, 'playerJoining', '0'));
  // On standalone the join itself is the "loaded" event, so the subscribers run and push
  // their no-character defaults: nothing read from any row (`Battery.ts`'s 100, two empty
  // rehydrates). On qb no character loads, so nothing fires at all.
  check(
    `${shape.kind}: an unnameable source is pushed defaults and no data on connect`,
    nobody.map((m) => [m.target, m.event, m.args]).sort(),
    shape.kind === 'standalone'
      ? [
          [NOBODY, 'mica:client:battery:set', [100]],
          [NOBODY, 'mica:client:settings:rehydrate', []],
          [NOBODY, 'mica:client:shell:rehydrate', []]
        ]
      : []
  );
  check(
    `${shape.kind}: an unnameable source is issued no number`,
    (await shape.rows('SELECT COUNT(*) AS n FROM `mica_phone_numbers`'))[0].n,
    3
  );

  // `playerJoining` is the runtime's, registered with `on`: a client cannot raise it.
  const forged = await shape.fire(1, 'playerJoining', '0');
  check(`${shape.kind}: a client cannot raise playerJoining`, forged.ran, 0);
  check(`${shape.kind}: and the forged event pushed nothing`, events(forged.sent), []);
  return numbers;
};

/** A call from 1 to 2: ring, answer, end, and the three ways a call does not connect. */
const runCall = async (shape, numbers) => {
  const { kind } = shape;
  const A = PEOPLE[1];
  const B = PEOPLE[2];
  const callLog = async (person) =>
    await shape.rows(
      'SELECT `kind`, `number`, `duration` FROM `mica_phone_call_log` WHERE `citizenid` = ? ORDER BY `id`',
      [shape.citizenOf(person)]
    );

  step(`${kind}: 1 calls 2, 2 answers, 1 hangs up`);
  const start = await shape.fire(1, 'mica:server:phone:start', numbers[2]);
  const incoming = to(start.sent, INCOMING, 2);
  check(`${kind}: 2 is rung once`, incoming.length, 1);
  check(`${kind}: the ring says who is calling`, incoming[0]?.args[0]?.from, numbers[1]);
  check(`${kind}: and nobody else hears of it`, events(start.sent), [`2 ${INCOMING}`]);
  const callId = incoming[0]?.args[0]?.callId;

  const answer = await shape.fire(2, 'mica:server:phone:answer');
  const accepted = (src) => to(answer.sent, ACCEPTED, src).map((m) => m.args[0].callId);
  check(`${kind}: the caller is told it connected, under the ringing id`, accepted(1), [callId]);
  check(`${kind}: so is the callee, under the same id`, accepted(2), [callId]);
  check(`${kind}: nothing else is sent on answer`, answer.sent.length, 2);

  const end = await shape.fire(1, 'mica:server:phone:end');
  check(`${kind}: the caller is told it ended`, to(end.sent, ENDED, 1).length, 1);
  check(`${kind}: so is the callee`, to(end.sent, ENDED, 2).length, 1);
  const aLog = await callLog(A);
  const bLog = await callLog(B);
  check(
    `${kind}: the caller has an outgoing row to the callee`,
    aLog.map((r) => [r.kind, r.number]),
    [['outgoing', numbers[2]]]
  );
  check(
    `${kind}: the callee has an incoming row from the caller`,
    bLog.map((r) => [r.kind, r.number]),
    [['incoming', numbers[1]]]
  );
  check(
    `${kind}: both rows carry a duration`,
    [...aLog, ...bLog].every((r) => Number.isInteger(r.duration) && r.duration >= 0),
    true
  );

  step(`${kind}: 2 is ringing when 4 calls them — busy`);
  await shape.fire(1, 'mica:server:phone:start', numbers[2]);
  const busy = await shape.fire(4, 'mica:server:phone:start', numbers[2]);
  check(`${kind}: the second caller is told it failed`, to(busy.sent, FAILED, 4).length, 1);
  check(
    `${kind}: with 'Line busy'`,
    to(busy.sent, NOTIFY, 4).map((m) => m.args[0].key),
    ['server.phone.lineBusy']
  );
  check(`${kind}: and 2 is not rung a second time`, to(busy.sent, INCOMING, 2).length, 0);

  step(`${kind}: 2 declines`);
  const decline = await shape.fire(2, 'mica:server:phone:end');
  check(
    `${kind}: the caller is told the declined call ended`,
    to(decline.sent, ENDED, 1).length,
    1
  );
  check(`${kind}: so is the one who declined`, to(decline.sent, ENDED, 2).length, 1);
  check(
    `${kind}: the caller logs an outgoing row`,
    (await callLog(A)).map((r) => [r.kind, r.number, r.duration]).slice(1),
    [['outgoing', numbers[2], 0]]
  );
  check(
    `${kind}: the callee logs it as missed`,
    (await callLog(B)).map((r) => [r.kind, r.number, r.duration]).slice(1),
    [['missed', numbers[1], 0]]
  );
  check(
    `${kind}: the busy caller logged nothing for a call that never rang`,
    (await callLog(PEOPLE[4])).length,
    0
  );

  step(`${kind}: 1 calls a number nobody holds`);
  const nowhere = await shape.fire(1, 'mica:server:phone:start', '5559999');
  check(`${kind}: the caller is told it failed`, to(nowhere.sent, FAILED, 1).length, 1);
  check(
    `${kind}: with 'Number unavailable'`,
    to(nowhere.sent, NOTIFY, 1).map((m) => m.args[0].key),
    ['server.phone.numberUnavailable']
  );
  check(`${kind}: and nobody is rung`, to(nowhere.sent, INCOMING, 2).length, 0);
  check(
    `${kind}: the caller logs an outgoing row to the number`,
    (await callLog(A)).map((r) => [r.kind, r.number]).slice(2),
    [['outgoing', '5559999']]
  );

  step(`${kind}: 1 calls 2 when 2 has blocked 1 — indistinguishable from nobody`);
  const blocked = await shape.call(2, 'blocklist', 'create', { number: numbers[1] });
  check(`${kind}: 2's block is written`, typeof blocked?.id, 'number');
  const refused = await shape.fire(1, 'mica:server:phone:start', numbers[2]);
  check(`${kind}: 2 is not rung`, to(refused.sent, INCOMING, 2).length, 0);
  check(
    `${kind}: the caller sees exactly what an unheld number shows`,
    events(refused.sent),
    events(nowhere.sent)
  );
  check(
    `${kind}: with the same message`,
    to(refused.sent, NOTIFY, 1).map((m) => m.args[0].key),
    ['server.phone.numberUnavailable']
  );
  check(
    `${kind}: and the same kind of row`,
    (await callLog(A)).map((r) => [r.kind, r.number]).slice(3),
    [['outgoing', numbers[2]]]
  );
  const unblocked = await shape.call(2, 'blocklist', 'delete', { id: blocked.id });
  check(`${kind}: 2 lifts the block`, unblocked, true);

  // The unblock is a soft delete under `phone_number_unique (phone_id, number)`, so a second
  // block of the same number from the same phone used to be refused as a duplicate (MICA-318).
  // The revive is the generic `uniqueAfterDelete: 'revive'` path since MICA-321, so this is
  // the check that runs its two statements against MariaDB through a real handler.
  step(`${kind}: 2 blocks 1 again, and lifts it again`);
  const reblocked = await shape.call(2, 'blocklist', 'create', { number: numbers[1] });
  check(`${kind}: the second block revives the first row`, reblocked?.id, blocked.id);
  check(
    `${kind}: which is the one row for the pair, and active`,
    (
      await shape.rows('SELECT `id`, `status` FROM `mica_blocklist` WHERE `number` = ?', [
        numbers[1]
      ])
    ).map((r) => [r.id, r.status]),
    [[blocked.id, 'active']]
  );
  check(
    `${kind}: 2 lifts it again`,
    await shape.call(2, 'blocklist', 'delete', { id: reblocked?.id }),
    true
  );

  step(`${kind}: 1 calls themselves`);
  const self = await shape.fire(1, 'mica:server:phone:start', numbers[1]);
  check(
    `${kind}: is refused as busy`,
    to(self.sent, NOTIFY, 1).map((m) => m.args[0].key),
    ['server.phone.busy']
  );
  check(`${kind}: and is told it failed`, to(self.sent, FAILED, 1).length, 1);

  step(`${kind}: 2 answers a call nobody placed`);
  const stray = await shape.fire(2, 'mica:server:phone:answer');
  check(`${kind}: nothing is sent`, events(stray.sent), []);
  check(
    `${kind}: and no call-log rows were written beyond the six above`,
    (await shape.rows('SELECT COUNT(*) AS n FROM `mica_phone_call_log`'))[0].n,
    6
  );
};

const LINE = { number: '5550911', label: 'Dispatch' };

/**
 * MICA-307's group ring: a line whose staff are 1 and 2, called by 4. On qb it is a real
 * `mica_job_lines` entry, and 1 and 2 are staff because the qb core says they hold the job
 * on duty. Standalone has no jobs, so the same ring is asked for by another resource's line
 * through `RegisterNumber`, whose `onCall` answers `ring` — the verdict a job line's own
 * handler gives — and the part under test, `Phone.ts`'s ring, is the same code either way.
 */
const runGroupRing = async (shape, numbers) => {
  const { kind } = shape;
  const asked = [];
  if (kind === 'qb') {
    shape.runtime.setConvar(
      'mica_job_lines',
      JSON.stringify([{ number: LINE.number, label: LINE.label, jobs: ['police'] }])
    );
  } else {
    const registered = await shape.runtime.callExport(
      'fake_dispatch',
      'RegisterNumber',
      LINE.number,
      {
        label: LINE.label,
        onCall: (incoming) => {
          asked.push(incoming);
          return { action: 'ring', sources: [1, 2] };
        }
      }
    );
    check(`${kind}: another resource registers the line`, registered, { ok: true });
  }
  const callLogCount = async (person) =>
    (
      await shape.rows('SELECT COUNT(*) AS n FROM `mica_phone_call_log` WHERE `citizenid` = ?', [
        shape.citizenOf(person)
      ])
    )[0].n;
  const aRowsBefore = await callLogCount(PEOPLE[1]);

  step(`${kind}: 4 calls the line, and both staff ring`);
  const dial = await shape.fire(4, 'mica:server:phone:start', LINE.number);
  const rings = [1, 2].map((src) => to(dial.sent, INCOMING, src).map((m) => m.args[0]));
  check(
    `${kind}: each of the staff is rung once`,
    rings.map((r) => r.length),
    [1, 1]
  );
  const ringId = rings[0][0]?.callId;
  check(`${kind}: both under one call id`, rings[1][0]?.callId, ringId);
  check(`${kind}: from the caller, on the line`, rings[0][0], {
    from: numbers[4],
    callId: ringId,
    line: LINE
  });
  check(
    `${kind}: the caller is told nothing until somebody answers`,
    to(dial.sent, ACCEPTED, 4),
    []
  );
  if (kind === 'standalone') {
    check(`${kind}: the line's handler was asked once, with the caller and the call id`, asked, [
      { from: numbers[4], source: 4, callId: ringId }
    ]);
  }

  step(`${kind}: 2 answers first`);
  const answer = await shape.fire(2, 'mica:server:phone:answer');
  const acceptedId = (src) => to(answer.sent, ACCEPTED, src).map((m) => m.args[0].callId);
  const callId = acceptedId(4)[0];
  check(`${kind}: the caller and the winner are told it connected, under one id`, acceptedId(2), [
    callId
  ]);
  check(`${kind}: which is not the id the losers were rung with`, callId !== ringId, true);
  check(`${kind}: the other phone stops ringing`, to(answer.sent, ENDED, 1).length, 1);
  check(`${kind}: and is never told the call connected`, acceptedId(1), []);

  const late = await shape.fire(1, 'mica:server:phone:answer');
  check(`${kind}: a second answer takes nothing`, events(late.sent), []);

  step(`${kind}: the caller hangs up`);
  const end = await shape.fire(4, 'mica:server:phone:end');
  check(
    `${kind}: the caller and the winner are told it ended`,
    [to(end.sent, ENDED, 4).length, to(end.sent, ENDED, 2).length],
    [1, 1]
  );
  const lastRow = async (person) =>
    (
      await shape.rows(
        'SELECT `kind`, `number` FROM `mica_phone_call_log` WHERE `citizenid` = ? ORDER BY `id` DESC LIMIT 1',
        [shape.citizenOf(person)]
      )
    )[0];
  check(`${kind}: the caller logs an outgoing row to the line`, await lastRow(PEOPLE[4]), {
    kind: 'outgoing',
    number: LINE.number
  });
  check(`${kind}: the winner logs an incoming row from the caller`, await lastRow(PEOPLE[2]), {
    kind: 'incoming',
    number: numbers[4]
  });
  check(`${kind}: the loser logs nothing`, await callLogCount(PEOPLE[1]), aRowsBefore);

  step(`${kind}: every staff phone is busy`);
  await shape.fire(1, 'mica:server:phone:start', numbers[2]);
  const nobodyFree = await shape.fire(4, 'mica:server:phone:start', LINE.number);
  check(
    `${kind}: nobody is rung`,
    to(nobodyFree.sent, INCOMING, 1).length + to(nobodyFree.sent, INCOMING, 2).length,
    0
  );
  check(
    `${kind}: and the caller sees an unheld number, not 'busy'`,
    to(nobodyFree.sent, NOTIFY, 4).map((m) => m.args[0].key),
    ['server.phone.numberUnavailable']
  );
  await shape.fire(1, 'mica:server:phone:end');
};

/** A text from 1 to 2: written, pushed to 2; and withheld from 2's phone once 2 blocks 1. */
const runText = async (shape, numbers) => {
  const { kind } = shape;
  step(`${kind}: 1 starts a thread with 2's number and texts it`);
  const thread = await shape.call(1, 'conversations', 'create', { phone: numbers[2] });
  check(`${kind}: the thread is created`, typeof thread?.id, 'number');

  const mark = shape.runtime.sent.length;
  const sent = await shape.call(1, 'messages', 'send', {
    conversation_id: thread.id,
    message: 'hello from 1'
  });
  check(`${kind}: the sender is answered with the stored row`, typeof sent?.id, 'number');
  const [row] = await shape.rows(
    'SELECT `citizenid`, `conversation_id`, `message` FROM `mica_messages` WHERE `id` = ?',
    [sent.id]
  );
  check(`${kind}: the row is written, owned by the sender`, row, {
    citizenid: shape.citizenOf(PEOPLE[1]),
    conversation_id: thread.id,
    message: 'hello from 1'
  });
  const pushes = shape.runtime.since(mark, (m) => m.event === RECEIVED);
  check(
    `${kind}: the text is pushed to 2 and nobody else`,
    pushes.map((m) => m.target),
    [2]
  );
  const push = pushes[0]?.args[0];
  check(
    `${kind}: the push carries the thread, the text and the sender`,
    {
      conversation_id: push?.conversation_id,
      message: push?.message,
      phone: push?.phone,
      senderName: push?.senderName,
      row: push?.row?.id
    },
    {
      conversation_id: thread.id,
      message: 'hello from 1',
      phone: numbers[1],
      senderName: 'Alice Test',
      row: sent.id
    }
  );

  const page = await shape.call(2, 'messages', 'get', { conversation_id: thread.id });
  check(
    `${kind}: 2 reads it in the thread`,
    page?.rows?.map((m) => m.message),
    ['hello from 1']
  );
  const outsider = await shape.call(4, 'messages', 'get', { conversation_id: thread.id });
  check(`${kind}: 4, not in the thread, is refused it`, typeof outsider?.error, 'string');
  check(`${kind}: and is shown no rows`, outsider?.rows, undefined);

  step(`${kind}: 1 blocks 2, and 2 texts`);
  const block = await shape.call(1, 'blocklist', 'create', { number: numbers[2] });
  check(`${kind}: 1's block is written`, typeof block?.id, 'number');
  const mark2 = shape.runtime.sent.length;
  const second = await shape.call(2, 'messages', 'send', {
    conversation_id: thread.id,
    message: 'are you there'
  });
  check(`${kind}: the send still succeeds`, typeof second?.id, 'number');
  check(
    `${kind}: the row is still written`,
    (await shape.rows('SELECT `message` FROM `mica_messages` WHERE `id` = ?', [second.id]))[0]
      ?.message,
    'are you there'
  );
  check(
    `${kind}: and nothing is pushed to 1`,
    shape.runtime.since(mark2, (m) => m.event === RECEIVED).length,
    0
  );

  step(`${kind}: 1 unblocks 2, and 2 texts again`);
  check(
    `${kind}: the block is lifted`,
    await shape.call(1, 'blocklist', 'delete', { id: block.id }),
    true
  );
  const mark3 = shape.runtime.sent.length;
  await shape.call(2, 'messages', 'send', { conversation_id: thread.id, message: 'yes' });
  check(
    `${kind}: the text is pushed to 1, in the same thread`,
    shape.runtime
      .since(mark3, (m) => m.event === RECEIVED)
      .map((m) => [m.target, m.args[0].conversation_id, m.args[0].message]),
    [[1, thread.id, 'yes']]
  );
  const again = await shape.call(1, 'conversations', 'create', { phone: numbers[2] });
  check(`${kind}: starting the thread again finds the same one`, again?.id, thread.id);
};

/**
 * MICA-240: another resource bills 1 through `SendInvoice`, payable to 2. On qb money moves
 * between the two players; standalone has no money, so the same tap is refused and the
 * invoice stays open.
 */
const runInvoice = async (shape) => {
  const { kind } = shape;
  const A = shape.citizenOf(PEOPLE[1]);
  const B = shape.citizenOf(PEOPLE[2]);
  const told = [];
  const bill = (amount, memo) =>
    shape.runtime.callExport('fake_billing', 'SendInvoice', A, {
      from: 'Los Santos Customs',
      amount,
      memo,
      payee: B,
      onPaid: (invoice) => told.push(['paid', invoice.id]),
      onDeclined: (invoice) => told.push(['declined', invoice.id])
    });
  const invoice = async (id) =>
    (
      await shape.rows(
        'SELECT `citizenid`, `amount`, `status`, `paid_at`, `resource`, `payee` FROM `mica_invoices` WHERE `id` = ?',
        [id]
      )
    )[0];

  step(`${kind}: a resource bills 1, payable to 2`);
  const mark = shape.runtime.sent.length;
  const sent = await bill(250, 'Repair');
  await shape.settle();
  check(
    `${kind}: SendInvoice answers the new id`,
    sent?.ok === true && typeof sent.value?.id,
    'number'
  );
  const id = sent.value.id;
  check(`${kind}: the invoice is written, open, naming the biller`, await invoice(id), {
    citizenid: A,
    amount: 250,
    status: 'active',
    paid_at: null,
    resource: 'fake_billing',
    payee: B
  });
  const pushed = shape.runtime.since(mark, (m) => m.event === APP_EVENT);
  check(
    `${kind}: 1's Bank app is told, and nobody else`,
    pushed.map((m) => [m.target, m.args[0].app, m.args[0].event, m.args[0].payload]),
    [[1, 'bank', 'invoice', { id }]]
  );
  const open = await shape.call(1, 'invoices', 'getOpen');
  check(
    `${kind}: 1 sees it open`,
    open.map((row) => row.id),
    [id]
  );

  step(`${kind}: 2 tries to pay 1's invoice`);
  check(
    `${kind}: refused as unknown, not as someone else's`,
    await shape.call(2, 'invoices', 'pay', { id }),
    {
      ok: false,
      reason: 'unknown_invoice'
    }
  );

  step(`${kind}: 1 pays`);
  const paid = await shape.call(1, 'invoices', 'pay', { id });
  if (kind === 'qb') {
    check(`${kind}: the payment succeeds`, [paid.ok, paid.invoices], [true, []]);
    check(
      `${kind}: 250 moves from 1's bank to 2's`,
      [shape.qb.bank(1), shape.qb.bank(2)],
      [750, 750]
    );
    const row = await invoice(id);
    check(
      `${kind}: the invoice is paid and stamped`,
      [row.status, typeof row.paid_at],
      ['paid', 'number']
    );
    check(`${kind}: the biller is told`, told, [['paid', id]]);
  } else {
    check(`${kind}: there is no money to pay with`, paid, {
      ok: false,
      reason: 'insufficient_funds'
    });
    const row = await invoice(id);
    check(`${kind}: the invoice is still open`, [row.status, row.paid_at], ['active', null]);
    check(
      `${kind}: 1 still sees it open`,
      (await shape.call(1, 'invoices', 'getOpen')).map((r) => r.id),
      [id]
    );
    check(`${kind}: the biller is told nothing`, told, []);
  }

  step(`${kind}: a second bill, and 1 declines it`);
  const second = (await bill(40, 'Tow')).value.id;
  await shape.settle();
  const declined = await shape.call(1, 'invoices', 'decline', { id: second });
  check(`${kind}: the decline succeeds`, declined.ok, true);
  check(`${kind}: the invoice is declined`, (await invoice(second)).status, 'declined');
  check(`${kind}: the biller is told`, told.at(-1), ['declined', second]);
  check(
    `${kind}: a second decline finds nothing open`,
    await shape.call(1, 'invoices', 'decline', { id: second }),
    {
      ok: false,
      reason: 'not_open'
    }
  );

  step(`${kind}: a bill for nobody`);
  const nobody = await shape.runtime.callExport('fake_billing', 'SendInvoice', 'NOT_A_CITIZEN', {
    from: 'Los Santos Customs',
    amount: 5,
    payee: B
  });
  check(
    `${kind}: is refused as an unknown player`,
    [nobody.ok, nobody.reason],
    [false, 'unknown_player']
  );
};

/** An unauthenticated source, a forged column, an unregistered event, and the rate limit. */
const runRefusals = async (shape, numbers) => {
  const { kind } = shape;
  step(`${kind}: source ${NOBODY}, which nobody can name, asks for things`);
  check(
    `${kind}: a read is refused as unauthenticated`,
    await shape.call(NOBODY, 'settings', 'getAll'),
    {
      error: 'Player not authenticated',
      key: 'server.notAuthenticated'
    }
  );
  const before = (await shape.rows('SELECT COUNT(*) AS n FROM `mica_messages`'))[0].n;
  const write = await shape.call(NOBODY, 'messages', 'send', { conversation_id: 1, message: 'hi' });
  check(`${kind}: a write is refused the same way`, write?.key, 'server.notAuthenticated');
  check(
    `${kind}: and writes nothing`,
    (await shape.rows('SELECT COUNT(*) AS n FROM `mica_messages`'))[0].n,
    before
  );
  const dial = await shape.fire(NOBODY, 'mica:server:phone:start', numbers[2]);
  check(`${kind}: a raw net event from it does nothing at all`, events(dial.sent), []);

  step(`${kind}: a client sends what nothing registered`);
  check(
    `${kind}: an unregistered event reaches no handler`,
    (await shape.fire(1, 'mica:server:phone:teleport')).ran,
    0
  );

  step(`${kind}: 1 creates a contact and names 2 as its owner`);
  const contact = await shape.call(1, 'contacts', 'create', {
    firstname: 'Forged',
    phone: '5551234',
    citizenid: shape.citizenOf(PEOPLE[2])
  });
  check(
    `${kind}: the row is 1's, whatever the payload said`,
    (await shape.rows('SELECT `citizenid` FROM `mica_contacts` WHERE `id` = ?', [contact.id]))[0]
      ?.citizenid,
    shape.citizenOf(PEOPLE[1])
  );

  step(`${kind}: 4 asks for its invoices sixty-one times in a minute`);
  const answers = [];
  for (let i = 0; i < 61; i++) answers.push(await shape.call(4, 'invoices', 'getOpen'));
  check(`${kind}: the first sixty are answered`, answers.slice(0, 60).every(Array.isArray), true);
  check(
    `${kind}: the sixty-first is refused as rate limited`,
    answers[60]?.key,
    'server.rateLimited'
  );
  check(
    `${kind}: and another player is unaffected`,
    Array.isArray(await shape.call(2, 'invoices', 'getOpen')),
    true
  );
};

/** Settings 1 writes survive a disconnect and a reconnect on a different server id. */
const runReconnect = async (shape, numbers) => {
  const { kind } = shape;
  step(`${kind}: 1 sets a preference`);
  check(
    `${kind}: the write is accepted`,
    await shape.call(1, 'settings', 'set', { app: 'clock', key: 'format', value: '"24h"' }),
    true
  );
  const mine = (list) =>
    list
      .filter((row) => row.app === 'clock' && row.setting_key === 'format')
      .map((row) => row.setting_value);
  check(`${kind}: 1 reads it back`, mine(await shape.call(1, 'settings', 'getAll')), ['"24h"']);
  check(`${kind}: 2 does not see it`, mine(await shape.call(2, 'settings', 'getAll')), []);

  step(`${kind}: 1 disconnects, and comes back as source 5`);
  await shape.disconnect(1);
  check(
    `${kind}: the old source is no longer anybody`,
    (await shape.call(1, 'settings', 'getAll'))?.key,
    'server.notAuthenticated'
  );
  const back = await shape.connect(5, PEOPLE[1]);
  check(
    `${kind}: the new source is told to re-read its settings`,
    to(back, 'mica:client:settings:rehydrate', 5).length,
    1
  );
  check(`${kind}: and finds the preference`, mine(await shape.call(5, 'settings', 'getAll')), [
    '"24h"'
  ]);
  check(`${kind}: on the same number`, await shape.numberOf(PEOPLE[1]), numbers[1]);
  const ring = await shape.fire(2, 'mica:server:phone:start', numbers[1]);
  check(`${kind}: which now rings the new source`, to(ring.sent, INCOMING, 5).length, 1);
  await shape.fire(2, 'mica:server:phone:end');
};

/* ------------------------------------------------------- the export and line flows */

/**
 * Every flow below runs after the reconnect, so 1's person (Alice) is source 5 from here on.
 * `live` names who is on which source now; the sendMessage flow moves Dana to source 6.
 */
const outcome = (result) => (result?.ok === true ? 'ok' : result?.reason);
/** Every message addressed to something that is not a player: -1 is FiveM's broadcast. */
const toNobody = (sent) => sent.filter((m) => !(m.target > 0)).map((m) => `${m.target} ${m.event}`);
const lastCallRow = async (shape, person) =>
  (
    await shape.rows(
      'SELECT `kind`, `number` FROM `mica_phone_call_log` WHERE `citizenid` = ? ORDER BY `id` DESC LIMIT 1',
      [shape.citizenOf(person)]
    )
  )[0];
const isInCall = async (shape, src) =>
  (await shape.runtime.callExport('fake_dispatch', 'IsInCall', src))?.value;

/**
 * MICA-276: `CreateCall` answers ok only for a call that rang or connected. Busy is
 * `not_ready`; a number nobody holds, a blocked caller and a line that rejects are each
 * `unknown_player` — one word on purpose (MICA-64), after the same toast the caller's phone
 * shows. A source with no character and a value that is no number are refused before anything.
 */
const runCreateCall = async (shape, numbers, live) => {
  const { kind } = shape;
  const { A, B, D } = live;
  const create = (src, number) => shape.invoke('fake_dispatch', 'CreateCall', src, number);

  step(`${kind}: a resource places a call from 2 to 1`);
  const placed = await create(B, numbers[1]);
  check(`${kind}: CreateCall answers ok for a call that rang`, placed.result, { ok: true });
  check(
    `${kind}: and 1 is rung, from 2's number`,
    to(placed.sent, INCOMING, A).map((m) => m.args[0].from),
    [numbers[2]]
  );
  check(
    `${kind}: IsInCall agrees for both`,
    [await isInCall(shape, A), await isInCall(shape, B)],
    [true, true]
  );

  step(`${kind}: while it rings, a resource places a call from 4 to 1`);
  const busy = await create(D, numbers[1]);
  check(`${kind}: CreateCall answers not_ready`, outcome(busy.result), 'not_ready');
  check(
    `${kind}: after 4's phone is told 'Line busy'`,
    to(busy.sent, NOTIFY, D).map((m) => m.args[0].key),
    ['server.phone.lineBusy']
  );
  check(`${kind}: and 1 is not rung again`, to(busy.sent, INCOMING, A).length, 0);
  const hangup = await shape.fire(B, 'mica:server:phone:end');
  check(`${kind}: the rung call ends like any other`, to(hangup.sent, ENDED, A).length, 1);

  step(`${kind}: a resource places a call to a number nobody holds`);
  const nowhere = await create(B, '5559998');
  check(`${kind}: CreateCall answers unknown_player`, outcome(nowhere.result), 'unknown_player');
  check(
    `${kind}: after 2's phone is told 'Number unavailable'`,
    to(nowhere.sent, NOTIFY, B).map((m) => m.args[0].key),
    ['server.phone.numberUnavailable']
  );
  check(`${kind}: and that it failed`, to(nowhere.sent, FAILED, B).length, 1);

  step(`${kind}: 2 blocks 4, and a resource places a call from 4 to 2`);
  const block = await shape.call(B, 'blocklist', 'create', { number: numbers[4] });
  check(`${kind}: 2's block is written`, typeof block?.id, 'number');
  const blocked = await create(D, numbers[2]);
  check(
    `${kind}: CreateCall answers unknown_player, as for nobody`,
    outcome(blocked.result),
    'unknown_player'
  );
  check(
    `${kind}: after the same messages a number nobody holds sends`,
    blocked.sent.map((m) => m.event),
    nowhere.sent.map((m) => m.event)
  );
  check(`${kind}: and 2 is not rung`, to(blocked.sent, INCOMING, B).length, 0);
  check(
    `${kind}: 2 lifts the block`,
    await shape.call(B, 'blocklist', 'delete', { id: block.id }),
    true
  );

  step(`${kind}: a resource places a call to a line that rejects it`);
  check(
    `${kind}: the line is registered`,
    await shape.runtime.callExport('fake_dispatch', 'RegisterNumber', '5550601', {
      onCall: () => ({ action: 'reject' })
    }),
    { ok: true }
  );
  const rejected = await create(B, '5550601');
  check(`${kind}: CreateCall answers unknown_player`, outcome(rejected.result), 'unknown_player');
  check(
    `${kind}: after 2's phone is told 'Number unavailable'`,
    to(rejected.sent, NOTIFY, B).map((m) => m.args[0].key),
    ['server.phone.numberUnavailable']
  );

  step(`${kind}: a resource places a call to a line that accepts it`);
  check(
    `${kind}: the line is registered`,
    await shape.runtime.callExport('fake_dispatch', 'RegisterNumber', '5550602', {
      onCall: () => ({ action: 'accept' })
    }),
    { ok: true }
  );
  const accepted = await create(B, '5550602');
  check(`${kind}: CreateCall answers ok`, accepted.result, { ok: true });
  check(`${kind}: and 2 is told it connected`, to(accepted.sent, ACCEPTED, B).length, 1);
  await shape.fire(B, 'mica:server:phone:end');
  for (const number of ['5550601', '5550602']) {
    await shape.runtime.callExport('fake_dispatch', 'UnregisterNumber', number);
  }

  step(`${kind}: a source nobody can name, and a number that is not one`);
  const nobody = await create(NOBODY, numbers[1]);
  check(`${kind}: no character is unknown_player`, outcome(nobody.result), 'unknown_player');
  check(`${kind}: and nothing is sent`, events(nobody.sent), []);
  const bad = await create(B, { not: 'a number' });
  check(`${kind}: no number is invalid_args`, outcome(bad.result), 'invalid_args');
  check(`${kind}: and nothing is sent`, events(bad.sent), []);
};

/**
 * MICA-277: `micacall`'s caller is source -1, which FiveM's `emitNet` broadcasts to every
 * client. Nothing about that call may be addressed to it — not `accepted`, not `ended` —
 * while the admin's own phone is told everything (the positive twin of each).
 */
const runMicacall = async (shape, live) => {
  const { kind } = shape;
  const { B, D } = live;
  const run = (src, args) => shape.raise(() => shape.runtime.command(src, 'micacall', args));
  shape.runtime.grantAce(B, 'command');

  step(`${kind}: 4, not an admin, runs micacall`);
  const refused = await run(D, []);
  check(
    `${kind}: is refused`,
    to(refused, NOTIFY, D).map((m) => m.args[0].type),
    ['error']
  );
  check(
    `${kind}: and nobody is rung`,
    refused.filter((m) => m.event === INCOMING),
    []
  );

  step(`${kind}: 2, an admin, rings themselves from 5550123, answers, and hangs up`);
  const ring = await run(B, ['5550123']);
  const incoming = to(ring, INCOMING, B).map((m) => m.args[0]);
  check(
    `${kind}: 2 is rung from that number`,
    incoming.map((m) => m.from),
    ['5550123']
  );
  check(`${kind}: and nothing is addressed to the console's caller`, toNobody(ring), []);
  const answer = await shape.fire(B, 'mica:server:phone:answer');
  check(
    `${kind}: 2 is told it connected, under the ringing id`,
    to(answer.sent, ACCEPTED, B).map((m) => m.args[0].callId),
    [incoming[0]?.callId]
  );
  check(
    `${kind}: and accepted goes to nobody else, -1 included`,
    answer.sent.filter((m) => m.event === ACCEPTED).map((m) => m.target),
    [B]
  );
  const end = await shape.fire(B, 'mica:server:phone:end');
  check(
    `${kind}: ended goes to 2 and to nobody else, -1 included`,
    end.sent.filter((m) => m.event === ENDED).map((m) => m.target),
    [B]
  );
  check(`${kind}: nothing at all is addressed to -1`, toNobody(end.sent), []);
  check(
    `${kind}: 2 logs an incoming row from the test number`,
    await lastCallRow(shape, PEOPLE[2]),
    {
      kind: 'incoming',
      number: '5550123'
    }
  );

  step(`${kind}: 2 is rung again, and ends it with micacall end`);
  const again = await run(B, []);
  check(
    `${kind}: rung from the default test number`,
    to(again, INCOMING, B).map((m) => m.args[0].from),
    ['5550100']
  );
  const forced = await run(B, ['end']);
  check(
    `${kind}: ended goes to 2 and to nobody else, -1 included`,
    forced.filter((m) => m.event === ENDED).map((m) => m.target),
    [B]
  );
  check(`${kind}: nothing at all is addressed to -1`, toNobody(forced), []);
  check(
    `${kind}: and 2 is told it ended`,
    to(forced, NOTIFY, B).map((m) => m.args[0].type),
    ['success']
  );
  check(`${kind}: 2 logs it as missed`, await lastCallRow(shape, PEOPLE[2]), {
    kind: 'missed',
    number: '5550100'
  });
  const idle = await run(B, ['end']);
  check(
    `${kind}: micacall end with no call says so, and ends nothing`,
    [to(idle, NOTIFY, B).map((m) => m.args[0].type), idle.filter((m) => m.event === ENDED)],
    [['error'], []]
  );
};

const CAB = { number: '5550777', label: 'Downtown Cab' };
const CAB_UNBLOCKABLE = '5550778';

/**
 * MICA-278: a line that answered a call can hang it up (`EndLineCall`), and only its owner
 * can; a call that is not a line's is refused. A player can block a line's number like any
 * other — its texts arrive unpushed — unless its owner registered it `blockable: false`, and
 * then only for texts the owner itself sends.
 */
const runLineCall = async (shape, numbers, live) => {
  const { kind } = shape;
  const { A, B, D } = live;
  const asked = [];
  check(
    `${kind}: a cab company registers its line`,
    await shape.runtime.callExport('fake_cab', 'RegisterNumber', CAB.number, {
      label: CAB.label,
      onCall: (call) => {
        asked.push(call);
        return { action: 'accept' };
      }
    }),
    { ok: true }
  );
  const endLine = (invoker, callId) => shape.invoke(invoker, 'EndLineCall', callId);

  step(`${kind}: 1 calls the cab, and the line answers`);
  const dial = await shape.fire(A, 'mica:server:phone:start', CAB.number);
  const callId = to(dial.sent, ACCEPTED, A)[0]?.args[0]?.callId;
  check(
    `${kind}: 1 is connected under the id the line was asked with`,
    [callId],
    asked.map((c) => c.callId)
  );

  step(`${kind}: another resource tries to hang it up`);
  const stolen = await endLine('fake_other', callId);
  check(`${kind}: refused as not_owner`, outcome(stolen.result), 'not_owner');
  check(`${kind}: and the call is still up`, await isInCall(shape, A), true);

  step(`${kind}: the cab names calls that are not its line's`);
  const ring = await shape.fire(B, 'mica:server:phone:start', numbers[4]);
  const playerCallId = to(ring.sent, INCOMING, D)[0]?.args[0]?.callId;
  const notLine = await endLine('fake_cab', playerCallId);
  check(
    `${kind}: a call between two players is invalid_args`,
    outcome(notLine.result),
    'invalid_args'
  );
  check(`${kind}: and keeps ringing`, await isInCall(shape, D), true);
  await shape.fire(B, 'mica:server:phone:end');
  check(
    `${kind}: an id nothing holds is invalid_args`,
    outcome((await endLine('fake_cab', 42)).result),
    'invalid_args'
  );

  step(`${kind}: the cab hangs up`);
  const hangup = await endLine('fake_cab', callId);
  check(`${kind}: EndLineCall answers ok`, hangup.result, { ok: true });
  check(
    `${kind}: 1 is told it ended, and nobody else`,
    hangup.sent.filter((m) => m.event === ENDED).map((m) => m.target),
    [A]
  );
  check(`${kind}: nothing is addressed to the line's side`, toNobody(hangup.sent), []);
  check(`${kind}: 1 is free`, await isInCall(shape, A), false);
  check(`${kind}: and logs an outgoing row to the line`, await lastCallRow(shape, PEOPLE[1]), {
    kind: 'outgoing',
    number: CAB.number
  });
  check(
    `${kind}: hanging up twice is invalid_args`,
    outcome((await endLine('fake_cab', callId)).result),
    'invalid_args'
  );

  const text = (invoker, number, body) =>
    shape.invoke(invoker, 'SendMessage', shape.citizenOf(PEOPLE[1]), { from: { number }, body });
  const pushedTo = (sent, src) =>
    sent.filter((m) => m.event === RECEIVED && m.target === src).map((m) => m.args[0].message);

  step(`${kind}: the cab texts 1, then 1 blocks the cab`);
  const before = await text('fake_cab', CAB.number, 'Your cab is outside');
  check(
    `${kind}: before the block it is delivered and pushed`,
    [before.result.value?.delivered, pushedTo(before.sent, A)],
    [true, ['Your cab is outside']]
  );
  const block = await shape.call(A, 'blocklist', 'create', { number: CAB.number });
  check(`${kind}: 1 blocks the line's number`, typeof block?.id, 'number');
  const after = await text('fake_cab', CAB.number, 'Still outside');
  check(
    `${kind}: after it the text is written but not delivered`,
    [outcome(after.result), after.result.value?.delivered],
    ['ok', false]
  );
  check(
    `${kind}: and nothing is pushed to anyone`,
    after.sent.filter((m) => m.event === RECEIVED),
    []
  );
  check(
    `${kind}: the row is in the thread`,
    (
      await shape.rows('SELECT `conversation_id` FROM `mica_messages` WHERE `id` = ?', [
        after.result.value?.messageId
      ])
    )[0]?.conversation_id,
    before.result.value?.conversationId
  );
  const redial = await shape.fire(A, 'mica:server:phone:start', CAB.number);
  check(`${kind}: 1 can still call the line it blocked`, to(redial.sent, ACCEPTED, A).length, 1);
  await endLine('fake_cab', to(redial.sent, ACCEPTED, A)[0]?.args[0]?.callId);

  step(`${kind}: a line registered blockable: false`);
  check(
    `${kind}: the cab registers it`,
    await shape.runtime.callExport('fake_cab', 'RegisterNumber', CAB_UNBLOCKABLE, {
      blockable: false,
      onCall: () => ({ action: 'reject' })
    }),
    { ok: true }
  );
  check(
    `${kind}: 1 blocks it`,
    typeof (await shape.call(A, 'blocklist', 'create', { number: CAB_UNBLOCKABLE }))?.id,
    'number'
  );
  const owner = await text('fake_cab', CAB_UNBLOCKABLE, 'Fare receipt');
  check(
    `${kind}: the owner's text is delivered and pushed anyway`,
    [owner.result.value?.delivered, pushedTo(owner.sent, A)],
    [true, ['Fare receipt']]
  );
  const borrowed = await text('fake_other', CAB_UNBLOCKABLE, 'Borrowed number');
  check(
    `${kind}: another resource sending as that number is still withheld`,
    [outcome(borrowed.result), borrowed.result.value?.delivered, pushedTo(borrowed.sent, A)],
    ['ok', false, []]
  );
};

const TOW = { number: '5550333', label: 'Tow Desk' };

/**
 * MICA-275: a player texts a line, its `onMessage` is told who, what and where, and its
 * `SendMessage` reply lands in the same thread and is pushed. A text in a thread with no line
 * tells it nothing; an unregistered line keeps the text and tells nobody.
 */
const runLineText = async (shape, numbers, live) => {
  const { kind } = shape;
  const { A, B } = live;
  const told = [];
  check(
    `${kind}: a tow company registers a line that reads texts`,
    await shape.runtime.callExport('fake_cab', 'RegisterNumber', TOW.number, {
      label: TOW.label,
      onCall: () => ({ action: 'reject' }),
      onMessage: (message) => told.push(message)
    }),
    { ok: true }
  );

  step(`${kind}: 2 texts the line`);
  const thread = await shape.call(B, 'conversations', 'create', { phone: TOW.number });
  check(`${kind}: the thread is created`, typeof thread?.id, 'number');
  const mark = shape.runtime.sent.length;
  const sent = await shape.call(B, 'messages', 'send', {
    conversation_id: thread.id,
    message: 'Flat tyre on Route 68'
  });
  check(`${kind}: the send answers the stored row`, typeof sent?.id, 'number');
  check(`${kind}: onMessage is told once, with who, what and where`, told, [
    {
      to: TOW.number,
      from: numbers[2],
      source: B,
      citizenid: shape.citizenOf(PEOPLE[2]),
      body: 'Flat tyre on Route 68',
      conversationId: thread.id,
      messageId: sent.id
    }
  ]);
  check(
    `${kind}: and the player's own text is pushed to nobody`,
    shape.runtime.since(mark, (m) => m.event === RECEIVED),
    []
  );

  step(`${kind}: the line replies`);
  const reply = await shape.invoke('fake_cab', 'SendMessage', told[0]?.citizenid, {
    from: { number: TOW.number },
    body: 'A truck is on its way'
  });
  check(
    `${kind}: SendMessage lands in the same thread, delivered`,
    [outcome(reply.result), reply.result.value?.conversationId, reply.result.value?.delivered],
    ['ok', thread.id, true]
  );
  check(
    `${kind}: pushed to 2 alone, in that thread`,
    reply.sent
      .filter((m) => m.event === RECEIVED)
      .map((m) => [m.target, m.args[0].conversation_id, m.args[0].message]),
    [[B, thread.id, 'A truck is on its way']]
  );
  const page = await shape.call(B, 'messages', 'get', { conversation_id: thread.id });
  check(
    `${kind}: 2 reads both in the thread, in the order sent`,
    page?.rows?.map((m) => m.message),
    ['Flat tyre on Route 68', 'A truck is on its way']
  );

  step(`${kind}: 2 texts 1 in their own thread`);
  const players = await shape.call(B, 'conversations', 'create', { phone: numbers[1] });
  const mark2 = shape.runtime.sent.length;
  await shape.call(B, 'messages', 'send', {
    conversation_id: players.id,
    message: 'tow is coming'
  });
  check(
    `${kind}: 1 is pushed it`,
    shape.runtime.since(mark2, (m) => m.event === RECEIVED).map((m) => m.target),
    [A]
  );
  check(`${kind}: and the line is told nothing`, told.length, 1);

  step(`${kind}: the line goes away, and 2 texts it again`);
  check(
    `${kind}: the line is unregistered`,
    await shape.runtime.callExport('fake_cab', 'UnregisterNumber', TOW.number),
    { ok: true }
  );
  const orphan = await shape.call(B, 'messages', 'send', {
    conversation_id: thread.id,
    message: 'hello?'
  });
  check(`${kind}: the text is still written`, typeof orphan?.id, 'number');
  check(`${kind}: and nobody is told`, told.length, 1);
};

/**
 * MICA-223: `SendMessage` from a business to a player online (a row, and a push to that
 * source alone) and offline (a row and no push). Nothing is queued: the player who comes back
 * is pushed nothing for it and reads it from the thread, as the code says.
 */
const runSendMessage = async (shape, numbers, live) => {
  const { kind } = shape;
  const { A, B } = live;
  const send = (citizenid, from, body) =>
    shape.invoke('fake_bank', 'SendMessage', citizenid, { from, body });
  const BANK = { name: 'Maze Bank' };

  step(`${kind}: a bank texts 2, who is online`);
  const online = await send(shape.citizenOf(PEOPLE[2]), BANK, 'Your statement is ready');
  const value = online.result.value;
  check(
    `${kind}: SendMessage answers ok, delivered`,
    [
      outcome(online.result),
      typeof value?.conversationId,
      typeof value?.messageId,
      value?.delivered
    ],
    ['ok', 'number', 'number', true]
  );
  check(
    `${kind}: the row is 2's, marked as from the bank`,
    (
      await shape.rows(
        'SELECT `citizenid`, `conversation_id`, `external_sender` FROM `mica_messages` WHERE `id` = ?',
        [value?.messageId]
      )
    )[0],
    {
      citizenid: shape.citizenOf(PEOPLE[2]),
      conversation_id: value?.conversationId,
      external_sender: BANK.name
    }
  );
  check(
    `${kind}: pushed to 2 alone, named as the bank`,
    online.sent
      .filter((m) => m.event === RECEIVED)
      .map((m) => [m.target, m.args[0].senderName, m.args[0].message]),
    [[B, BANK.name, 'Your statement is ready']]
  );
  const second = await send(shape.citizenOf(PEOPLE[2]), BANK, 'Payment received');
  check(
    `${kind}: a second text from the bank is in the same thread`,
    second.result.value?.conversationId,
    value?.conversationId
  );
  const outsider = await shape.call(A, 'messages', 'get', {
    conversation_id: value?.conversationId
  });
  check(`${kind}: 1 cannot read 2's thread with the bank`, outsider?.rows, undefined);

  step(`${kind}: SendMessage refuses what it must`);
  check(
    `${kind}: a number a character holds is number_in_use`,
    outcome((await send(shape.citizenOf(PEOPLE[2]), { number: numbers[1] }, 'hi')).result),
    'number_in_use'
  );
  check(
    `${kind}: a citizenid nobody has is unknown_player`,
    outcome((await send('NOT_A_CITIZEN', BANK, 'hi')).result),
    'unknown_player'
  );

  step(`${kind}: 4 disconnects, and the bank texts them`);
  await shape.disconnect(live.D);
  const before = shape.runtime.sent.length;
  const offline = await send(
    shape.citizenOf(PEOPLE[4]),
    { name: 'Maze Bank', number: '5550800' },
    'Overdraft notice'
  );
  check(
    `${kind}: SendMessage answers ok, not delivered`,
    [outcome(offline.result), offline.result.value?.delivered],
    ['ok', false]
  );
  check(
    `${kind}: the row is written, 4's`,
    (
      await shape.rows('SELECT `citizenid` FROM `mica_messages` WHERE `id` = ?', [
        offline.result.value?.messageId
      ])
    )[0]?.citizenid,
    shape.citizenOf(PEOPLE[4])
  );
  check(
    `${kind}: and nothing is pushed to anyone`,
    shape.runtime.since(before, (m) => m.event === RECEIVED),
    []
  );

  step(`${kind}: 4 comes back as source 6`);
  const back = await shape.connect(6, PEOPLE[4]);
  live.D = 6;
  check(`${kind}: nothing queued is pushed on connect`, to(back, RECEIVED, 6), []);
  const page = await shape.call(6, 'messages', 'get', {
    conversation_id: offline.result.value?.conversationId
  });
  check(
    `${kind}: 4 reads it in the thread`,
    page?.rows?.map((m) => m.message),
    ['Overdraft notice']
  );
};

const QB_MAIL = {
  sender: 'Los Santos Customs',
  subject: 'Your car is ready',
  message: 'Pick it up at the garage.'
};

/**
 * MICA-222: qb-phone's mail events, answered unmodified. `sendNewMail` is a net event and
 * mails only its own source; `sendNewMailToOffline` names a citizenid, so a client cannot
 * raise it and a server script can. Registered whatever the framework, so it runs on both
 * shapes. qb-phone's `CustomNotification` is a client event and has no server half here.
 */
const runQbMail = async (shape, live) => {
  const { kind } = shape;
  const { A, B } = live;
  const D = live.D;
  const mailOf = async (person) =>
    await shape.rows(
      'SELECT `sender`, `subject` FROM `mica_mail` WHERE `citizenid` = ? ORDER BY `id`',
      [shape.citizenOf(person)]
    );
  const total = async () => (await shape.rows('SELECT COUNT(*) AS n FROM `mica_mail`'))[0].n;

  step(`${kind}: a qb script fires sendNewMail as 2`);
  const sent = await shape.fire(B, 'qb-phone:server:sendNewMail', QB_MAIL);
  check(`${kind}: micaOS answers it`, sent.ran, 1);
  check(`${kind}: the mail is 2's`, await mailOf(PEOPLE[2]), [
    { sender: QB_MAIL.sender, subject: QB_MAIL.subject }
  ]);
  check(
    `${kind}: 2 reads the body qb called message`,
    (await shape.call(B, 'mail', 'getMail')).map((m) => m.content),
    [QB_MAIL.message]
  );
  check(`${kind}: 1 has none of it`, await shape.call(A, 'mail', 'getMail'), []);
  check(
    `${kind}: 2's phone is told, and nobody else's`,
    sent.sent.map((m) => [m.target, m.event, m.args[0]?.app ?? null]),
    [
      [B, 'mica:client:mail:receive', null],
      [B, APP_EVENT, 'mail']
    ]
  );

  step(`${kind}: payloads it must not deliver`);
  const count = await total();
  const noSubject = await shape.fire(B, 'qb-phone:server:sendNewMail', {
    sender: 'x',
    message: 'y'
  });
  check(
    `${kind}: one with no subject writes nothing and sends nothing`,
    [await total(), events(noSubject.sent)],
    [count, []]
  );
  const nobody = await shape.fire(NOBODY, 'qb-phone:server:sendNewMail', QB_MAIL);
  check(
    `${kind}: one from a source nobody can name writes nothing`,
    [await total(), events(nobody.sent)],
    [count, []]
  );
  const forged = await shape.fire(
    B,
    'qb-phone:server:sendNewMailToOffline',
    shape.citizenOf(PEOPLE[1]),
    QB_MAIL
  );
  check(
    `${kind}: a client cannot raise sendNewMailToOffline`,
    [forged.ran, await total()],
    [0, count]
  );

  step(`${kind}: a server script raises sendNewMailToOffline for 4`);
  const local = await shape.raise(() =>
    shape.runtime.local('qb-phone:server:sendNewMailToOffline', shape.citizenOf(PEOPLE[4]), {
      ...QB_MAIL,
      subject: 'Invoice overdue'
    })
  );
  check(`${kind}: the mail is 4's`, await mailOf(PEOPLE[4]), [
    { sender: QB_MAIL.sender, subject: 'Invoice overdue' }
  ]);
  check(`${kind}: and 4, online, is told`, to(local, 'mica:client:mail:receive', D).length, 1);
};

/**
 * MICA-168: a player's export is their own rows, and their delete removes them while another
 * player's — including their messages in a thread the deleter started — stay as they were.
 * Last, because it deletes 1's data.
 */
const runPrivacy = async (shape, live) => {
  const { kind } = shape;
  const { A, B } = live;
  const OWNED = ['mica_settings', 'mica_contacts', 'mica_phone_call_log', 'mica_messages'];
  const counts = async (person) => {
    const out = {};
    for (const table of OWNED) {
      out[table] = (
        await shape.rows(`SELECT COUNT(*) AS n FROM \`${table}\` WHERE \`citizenid\` = ?`, [
          shape.citizenOf(person)
        ])
      )[0].n;
    }
    return out;
  };
  const exported = (result) =>
    Object.fromEntries(
      OWNED.map((table) => [
        table,
        result?.categories?.find((c) => c.category === table.replace(/^mica_/, ''))?.rows?.length
      ])
    );
  const clock = (result) =>
    result?.categories
      ?.find((c) => c.category === 'settings')
      ?.rows?.filter((row) => row.app === 'clock' && row.setting_key === 'format')
      .map((row) => row.setting_value);

  step(`${kind}: 1 and 2 export their data`);
  const aRows = await counts(PEOPLE[1]);
  const bRows = await counts(PEOPLE[2]);
  check(
    `${kind}: 1 has rows in every table checked`,
    Object.values(aRows).every((n) => n > 0),
    true
  );
  const aExport = await shape.call(A, 'privacy', 'export');
  const bExport = await shape.call(B, 'privacy', 'export');
  check(`${kind}: 1's export holds exactly 1's rows`, exported(aExport), aRows);
  check(`${kind}: 2's export holds exactly 2's rows`, exported(bExport), bRows);
  check(`${kind}: 1's export has 1's clock setting`, clock(aExport), ['"24h"']);
  check(`${kind}: 2's export does not`, clock(bExport), []);

  step(`${kind}: 1 deletes their data`);
  const typo = await shape.call(A, 'privacy', 'delete', { confirm: 'delete' });
  check(
    `${kind}: the wrong word is refused, and deletes nothing`,
    [typo?.key, await counts(PEOPLE[1])],
    ['server.privacy.confirmRequired', aRows]
  );
  const numberBefore = await shape.numberOf(PEOPLE[1]);
  const deleted = await shape.call(A, 'privacy', 'delete', { confirm: 'DELETE' });
  check(`${kind}: the delete completes`, [deleted?.complete, deleted?.failed], [true, []]);
  const aAfter = await counts(PEOPLE[1]);
  check(
    `${kind}: 1's settings, contacts and call log are gone`,
    [aAfter.mica_settings, aAfter.mica_contacts, aAfter.mica_phone_call_log],
    [0, 0, 0]
  );
  check(
    `${kind}: 1 keeps the phone number, which is the device's`,
    await shape.numberOf(PEOPLE[1]),
    numberBefore
  );
  check(`${kind}: 2's rows are untouched`, await counts(PEOPLE[2]), bRows);
  const shared = (
    await shape.rows(
      'SELECT `conversation_id` FROM `mica_messages` WHERE `citizenid` = ? AND `message` IS NOT NULL AND `external_sender` IS NULL ORDER BY `id` LIMIT 1',
      [shape.citizenOf(PEOPLE[2])]
    )
  )[0]?.conversation_id;
  const page = await shape.call(B, 'messages', 'get', { conversation_id: shared });
  check(
    `${kind}: 2 still reads their own texts in the thread 1 started`,
    page?.rows?.map((m) => m.message).filter((m) => m === 'are you there'),
    ['are you there']
  );
  check(
    `${kind}: 1's export now has no clock setting`,
    clock(await shape.call(A, 'privacy', 'export')),
    []
  );
  check(
    `${kind}: a second delete within the hour is refused`,
    (await shape.call(A, 'privacy', 'delete', { confirm: 'DELETE' }))?.key,
    'server.privacy.deleteTooSoon'
  );
};

/* ------------------------------------------------------------------ main */

/** One flow, held to its own floor. */
const flow = async (shape, name, run) => {
  const before = checksRun;
  const result = await run();
  const ran = checksRun - before;
  const expected = FLOW_CHECKS[name][shape.kind];
  console.log(`  ${shape.kind}, ${name}: ${ran} checks`);
  if (ran < expected) {
    throw new Error(
      `${shape.kind}: the ${name} flow ran ${ran} checks, fewer than its ${expected}. ` +
        'Something returned early — treat this as a failure, not a pass.'
    );
  }
  return result;
};

const runShape = async (db, kind) => {
  const shape = await startShape({ db, kind });
  const before = checksRun;
  try {
    const numbers = await flow(shape, 'connect', () => runConnect(shape));
    await flow(shape, 'call', () => runCall(shape, numbers));
    await flow(shape, 'groupRing', () => runGroupRing(shape, numbers));
    await flow(shape, 'text', () => runText(shape, numbers));
    await flow(shape, 'invoice', () => runInvoice(shape));
    await flow(shape, 'refusals', () => runRefusals(shape, numbers));
    await flow(shape, 'reconnect', () => runReconnect(shape, numbers));
    // 1's person is source 5 from the reconnect on.
    const live = { A: 5, B: 2, D: 4 };
    await flow(shape, 'createCall', () => runCreateCall(shape, numbers, live));
    await flow(shape, 'micacall', () => runMicacall(shape, live));
    await flow(shape, 'lineCall', () => runLineCall(shape, numbers, live));
    await flow(shape, 'lineText', () => runLineText(shape, numbers, live));
    await flow(shape, 'sendMessage', () => runSendMessage(shape, numbers, live));
    await flow(shape, 'qbMail', () => runQbMail(shape, live));
    await flow(shape, 'privacy', () => runPrivacy(shape, live));
  } finally {
    await shape.stop();
  }
  console.log(`\n${kind}: ${checksRun - before} checks passed.`);
};

const main = async () => {
  let db;
  try {
    db = await openDatabase(CONTAINER_LABEL);
    await buildBundle();
    await runShape(db, 'standalone');
    await runShape(db, 'qb');

    if (checksRun < MINIMUM_CHECKS) {
      throw new Error(
        `only ${checksRun} checks ran, fewer than the ${MINIMUM_CHECKS} expected. Something ` +
          'returned early — treat this as a failure, not a pass.'
      );
    }
    console.log(`\nAll ${checksRun} checks passed${db.external ? '' : ` against ${IMAGE}`}.`);
  } finally {
    if (db) await db.close();
  }
};

main().catch((error) => {
  console.error(`\nendpoints harness FAILED: ${error.stack ?? error.message}`);
  console.error('\nNothing here is a pass. Fix the failure or the environment and re-run.');
  process.exit(1);
});

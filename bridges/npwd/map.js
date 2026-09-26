// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Every `exports.npwd` name this bridge answers, and what each becomes in micaOS (MICA-232).
 * The one table: `runtime.js` registers from it, and `scripts/bridge-table.js` writes
 * README's "coming from NPWD" table from it, so the two cannot disagree.
 *
 * An entry is `{ name, side, uses, note, fallback, run }`. `uses` names the micaOS exports
 * the call reaches (`server:` when a client name reaches a server export); empty means no
 * equivalent, and the name is registered as a stub that logs once. `fallback` is what NPWD
 * answers when it has nothing, and is what a failure answers here.
 *
 * Signatures are read from NPWD's docs (projecterror.dev/docs/npwd/api: client exports,
 * server exports, the notification API). Where a doc left a return value unstated, the
 * entry says it is a best reading. A JS export returns one value, and an entry that waits on
 * the server is a promise FiveM's Lua runtime awaits for a caller inside a thread.
 */
(() => {
  const CALL_EVENT = 'npwd:bridge:createCall';

  /** An outcome's value, or undefined for a failure. micaOS never throws; it answers. */
  const value = (outcome) =>
    outcome && typeof outcome === 'object' && outcome.ok === true ? outcome.value : undefined;

  const citizenOfNumber = async (mica, number) =>
    typeof number === 'string' && number.trim()
      ? value(await mica.GetCitizenId(number))
      : undefined;

  const citizenOfSource = async (mica, source) => {
    const src = Number(source);
    return Number.isInteger(src) && src > 0
      ? value(await mica.GetCitizenIdFromSource(src))
      : undefined;
  };

  /** A toast from either notification DTO. NPWD's title is `secondaryTitle`. */
  const toast = (mica, dto) => {
    if (!dto || typeof dto !== 'object') return undefined;
    mica.Notify({
      type: 'info',
      title: String(dto.secondaryTitle || dto.appId || ''),
      message: String(dto.content || '')
    });
    return undefined;
  };

  const entries = [
    // ---- server -------------------------------------------------------------------------
    {
      name: 'getPlayerData',
      side: 'server',
      uses: ['GetCitizenIdFromSource', 'GetCitizenId', 'GetPhoneNumber'],
      note:
        '`identifier` is the citizenid. `firstName`, `lastName` and `name` are nil: micaOS ' +
        'exports no character names.',
      fallback: null,
      run: async (mica, query) => {
        if (!query || typeof query !== 'object') return null;
        let citizenid;
        if (query.source !== undefined) citizenid = await citizenOfSource(mica, query.source);
        else if (query.phoneNumber !== undefined) {
          citizenid = await citizenOfNumber(mica, query.phoneNumber);
        } else if (typeof query.identifier === 'string') citizenid = query.identifier;
        if (!citizenid) return null;
        const phoneNumber = value(await mica.GetPhoneNumber(citizenid));
        if (!phoneNumber) return null;
        return { phoneNumber, identifier: citizenid, firstName: null, lastName: null, name: null };
      }
    },
    {
      name: 'emitMessage',
      side: 'server',
      uses: ['GetCitizenId', 'SendMessage'],
      note:
        '`senderNumber` must be a line, not a number a character holds -- micaOS refuses to ' +
        'speak for a player. `embed` is dropped.',
      fallback: undefined,
      run: async (mica, dto) => {
        if (!dto || typeof dto !== 'object') return undefined;
        const citizenid = await citizenOfNumber(mica, dto.targetNumber);
        if (!citizenid) return undefined;
        await mica.SendMessage(citizenid, {
          from: { number: String(dto.senderNumber) },
          body: String(dto.message || '')
        });
        return undefined;
      }
    },
    {
      name: 'isPlayerBusy',
      side: 'server',
      uses: ['IsInCall'],
      note: '',
      fallback: false,
      run: (mica, source) => value(mica.IsInCall(Number(source))) === true
    },
    {
      name: 'isPhoneNumberBusy',
      side: 'server',
      uses: ['GetSourceFromNumber', 'IsInCall'],
      note: 'false when nobody connected holds the number.',
      fallback: false,
      run: async (mica, phoneNumber) => {
        const src = value(await mica.GetSourceFromNumber(phoneNumber));
        return src === undefined ? false : value(mica.IsInCall(src)) === true;
      }
    },
    {
      name: 'onCall',
      side: 'server',
      uses: [],
      note:
        "No drop-in equivalent: micaOS's `RegisterNumber(number, { onCall })` answers " +
        "`{ action = 'accept' | 'reject' | 'forward' }` rather than NPWD's middleware `ctx`.",
      fallback: undefined
    },
    {
      name: 'onMessage',
      side: 'server',
      uses: [],
      note: 'No equivalent: a text to a registered line is not delivered to a script.',
      fallback: undefined
    },
    {
      name: 'generatePhoneNumber',
      side: 'server',
      uses: [],
      note: 'No equivalent: numbers come from the framework.',
      fallback: null
    },
    {
      name: 'newPlayer',
      side: 'server',
      uses: [],
      note: 'No equivalent: micaOS loads players from the framework.',
      fallback: undefined
    },
    {
      name: 'unloadPlayer',
      side: 'server',
      uses: [],
      note: 'No equivalent: micaOS loads players from the framework.',
      fallback: undefined
    },

    // ---- client -------------------------------------------------------------------------
    {
      name: 'openApp',
      side: 'client',
      uses: ['OpenApp'],
      note: "NPWD's app id is lowercased (`CONTACTS` becomes `contacts`).",
      fallback: undefined,
      run: (mica, appId) => {
        mica.OpenApp(String(appId || '').toLowerCase());
        return undefined;
      }
    },
    {
      name: 'setPhoneVisible',
      side: 'client',
      uses: ['OpenPhone', 'ClosePhone'],
      note: 'Refused while the phone is disabled, as in NPWD.',
      fallback: undefined,
      run: (mica, visible) => {
        if (visible) mica.OpenPhone();
        else mica.ClosePhone();
        return undefined;
      }
    },
    {
      name: 'isPhoneVisible',
      side: 'client',
      uses: ['IsPhoneOpen'],
      note: '',
      fallback: false,
      run: (mica) => value(mica.IsPhoneOpen()) === true
    },
    {
      name: 'setPhoneDisabled',
      side: 'client',
      uses: ['SetPhoneEnabled'],
      note: '',
      fallback: undefined,
      run: (mica, disabled) => {
        mica.SetPhoneEnabled(disabled !== true);
        return undefined;
      }
    },
    {
      name: 'isPhoneDisabled',
      side: 'client',
      uses: ['IsPhoneEnabled'],
      note: '',
      fallback: false,
      run: (mica) => value(mica.IsPhoneEnabled()) === false
    },
    {
      name: 'getPhoneNumber',
      side: 'client',
      uses: ['GetPhoneNumber'],
      note: '',
      fallback: null,
      run: (mica) => value(mica.GetPhoneNumber()) ?? null
    },
    {
      name: 'createNotification',
      side: 'client',
      uses: ['Notify'],
      note: 'A toast: `secondaryTitle` is the title. `path`, `duration` and `keepOpen` are dropped.',
      fallback: undefined,
      run: toast
    },
    {
      name: 'createSystemNotification',
      side: 'client',
      uses: ['Notify'],
      note:
        'A toast with no controls: `onConfirm` and `onCancel` are never called, so do not ' +
        'gate anything on them.',
      fallback: undefined,
      run: toast
    },
    {
      name: 'startPhoneCall',
      side: 'client',
      uses: ['server:CreateCall'],
      note: "Places the call through this bridge's server half, at most one every two seconds.",
      fallback: undefined,
      run: (mica, phoneNumber) => {
        if (typeof phoneNumber === 'string' && phoneNumber.trim()) emitNet(CALL_EVENT, phoneNumber);
        return undefined;
      }
    },
    {
      name: 'isInCall',
      side: 'client',
      uses: ['IsInCall'],
      note: '',
      fallback: false,
      run: (mica) => value(mica.IsInCall()) === true
    },
    {
      name: 'endCall',
      side: 'client',
      uses: [],
      note: 'No equivalent: a call ends from the phone.',
      fallback: undefined
    },
    {
      name: 'fillNewContact',
      side: 'client',
      uses: [],
      note: "No equivalent. The server's `AddContact(citizenid, contact)` saves one outright.",
      fallback: undefined
    },
    {
      name: 'fillNewNote',
      side: 'client',
      uses: [],
      note: 'No equivalent.',
      fallback: undefined
    },
    {
      name: 'sendUIMessage',
      side: 'client',
      uses: [],
      note: 'No equivalent: a micaOS add-on talks to its own iframe through the SDK.',
      fallback: undefined
    }
  ];

  globalThis.micaBridge = { resource: 'npwd', callEvent: CALL_EVENT, entries };
})();

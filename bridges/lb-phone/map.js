// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Every `exports['lb-phone']` name this bridge answers, and what each becomes in micaOS
 * (MICA-232). The one table: `runtime.js` registers from it, and `scripts/bridge-table.js`
 * writes README's "coming from lb-phone" table from it, so the two cannot disagree.
 *
 * An entry is `{ name, side, uses, note, fallback, run }`. `uses` names the micaOS exports
 * the call reaches (`server:` when a client name reaches a server export); empty means no
 * equivalent, and the name is registered as a stub that logs once. `fallback` is what
 * lb-phone answers when it has nothing -- nil or false -- and is what a failure answers here.
 *
 * Signatures are read from lb-phone's public docs (docs.lbscripts.com/phone/exports), not
 * from its source, which is not public. Where a doc left a return value or a callback's
 * argument unstated, the entry says it is a best reading.
 *
 * Two limits of a JavaScript bridge apply to every entry. A JS export returns one value, so
 * a Lua caller writing `local a, b = ...` gets the first and nil. And an entry that waits on
 * the server is a promise, which FiveM's Lua runtime awaits for the caller -- the caller has
 * to be in a thread (an event handler or `CreateThread`), as it does for micaOS's own
 * asynchronous exports.
 */
(() => {
  const CALL_EVENT = 'lb-phone:bridge:createCall';

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

  /** lb-phone's `source | identifier`: a number (or a string of digits) is a source. */
  const citizenOfSourceOrIdentifier = (mica, target) =>
    typeof target === 'number' || (typeof target === 'string' && /^\d+$/.test(target))
      ? citizenOfSource(mica, target)
      : Promise.resolve(typeof target === 'string' && target.trim() ? target : undefined);

  /** `ext_<resource>`, the group an external notification goes under. */
  const externalApp = () => {
    const invoking = typeof GetInvokingResource === 'function' ? GetInvokingResource() : '';
    const slug = String(invoking || 'lb-phone')
      .toLowerCase()
      .replace(/[^a-z0-9_]/g, '_');
    return { app: `ext_${slug}`, label: invoking || 'lb-phone' };
  };

  const entries = [
    // ---- server -------------------------------------------------------------------------
    {
      name: 'SendMessage',
      side: 'server',
      uses: ['GetCitizenId', 'SendMessage'],
      note:
        '`from` must be a line, not a number a character holds -- micaOS refuses to speak ' +
        'for a player. Attachment URLs are appended to the body; `channelId` is ignored. ' +
        '`cb` gets `true`/`false` (best reading of the docs).',
      fallback: null,
      run: async (mica, from, to, message, attachments, cb) => {
        const reply = (result) => {
          if (typeof cb === 'function') cb(result !== null);
          return result;
        };
        const citizenid = await citizenOfNumber(mica, to);
        if (!citizenid) return reply(null);
        const urls = Array.isArray(attachments) ? attachments.map(String) : [];
        const body = [typeof message === 'string' ? message : '', ...urls]
          .filter((line) => line.trim())
          .join('\n');
        const sent = value(
          await mica.SendMessage(citizenid, { from: { number: String(from) }, body })
        );
        return reply(sent ? { channelId: sent.conversationId, messageId: sent.messageId } : null);
      }
    },
    {
      name: 'SendNotification',
      side: 'server',
      uses: ['GetCitizenIdFromSource', 'GetCitizenId', 'SendNotification'],
      note:
        "Grouped under the calling resource (`ext_<resource>`), labelled with lb-phone's " +
        '`app`. Answers `true` rather than a notification id, which micaOS does not expose; ' +
        '`customData` buttons are dropped.',
      fallback: null,
      run: async (mica, target, data) => {
        // Before any await: GetInvokingResource names the caller only while its call is on
        // the stack, and answers nothing once this has yielded.
        const { app, label } = externalApp();
        const citizenid =
          typeof target === 'number'
            ? await citizenOfSource(mica, target)
            : await citizenOfNumber(mica, target);
        if (!citizenid || !data || typeof data !== 'object') return null;
        const outcome = await mica.SendNotification(citizenid, {
          app,
          sourceLabel: data.app ? String(data.app) : label,
          title: String(data.title || data.app || label),
          body: data.content ? String(data.content) : '',
          avatar: data.avatar ? String(data.avatar) : undefined
        });
        return value(outcome) ? true : null;
      }
    },
    {
      name: 'SendMail',
      side: 'server',
      uses: ['GetCitizenId', 'GetPhoneNumber', 'SendSystemEmail'],
      note:
        'micaOS mail has no addresses: `to` must be a phone number or a citizenid, and an ' +
        'lb-phone address answers `false`. Answers `success` only, not `success, id`; ' +
        '`attachments` and `actions` are dropped.',
      fallback: false,
      run: async (mica, data) => {
        if (!data || typeof data !== 'object' || typeof data.to !== 'string') return false;
        const to = data.to.trim();
        let citizenid = await citizenOfNumber(mica, to);
        if (!citizenid && to && !to.includes('@') && value(await mica.GetPhoneNumber(to))) {
          citizenid = to;
        }
        if (!citizenid) return false;
        const mail = await mica.SendSystemEmail(citizenid, {
          sender: String(data.sender || 'System'),
          subject: String(data.subject || ''),
          content: String(data.message || '')
        });
        return Boolean(mail);
      }
    },
    {
      name: 'AddContact',
      side: 'server',
      uses: ['GetCitizenId', 'AddContact'],
      note: '`avatar` and `address` have no micaOS column and are dropped.',
      fallback: undefined,
      run: async (mica, phoneNumber, data) => {
        const citizenid = await citizenOfNumber(mica, phoneNumber);
        if (!citizenid || !data || typeof data !== 'object') return undefined;
        await mica.AddContact(citizenid, {
          firstname: data.firstname,
          lastname: data.lastname,
          phone: data.number,
          email: data.email
        });
        return undefined;
      }
    },
    {
      name: 'GetEquippedPhoneNumber',
      side: 'server',
      uses: ['GetCitizenIdFromSource', 'GetPhoneNumber'],
      note: 'A source, or a citizenid as the identifier.',
      fallback: null,
      run: async (mica, target) => {
        const citizenid = await citizenOfSourceOrIdentifier(mica, target);
        if (!citizenid) return null;
        return value(await mica.GetPhoneNumber(citizenid)) ?? null;
      }
    },
    {
      name: 'GetSourceFromNumber',
      side: 'server',
      uses: ['GetSourceFromNumber'],
      note: 'nil when nobody connected holds the number.',
      fallback: null,
      run: async (mica, phoneNumber) => value(await mica.GetSourceFromNumber(phoneNumber)) ?? null
    },
    {
      name: 'CreateCall',
      side: 'server',
      uses: ['CreateCall'],
      note:
        "Calls from `caller.source`'s own number; `caller.phoneNumber` and `options` are " +
        'ignored. Answers `true` rather than a call id, which micaOS does not expose.',
      fallback: null,
      run: async (mica, caller, callee) => {
        const src = caller && typeof caller === 'object' ? Number(caller.source) : NaN;
        if (!Number.isInteger(src) || typeof callee !== 'string') return null;
        const outcome = await mica.CreateCall(src, callee);
        return outcome && outcome.ok === true ? true : null;
      }
    },
    {
      name: 'IsInCall',
      side: 'server',
      uses: ['IsInCall'],
      note: 'Answers `inCall` only; no call id or call table.',
      fallback: false,
      run: (mica, source) => value(mica.IsInCall(Number(source))) === true
    },
    {
      name: 'HasPhoneItem',
      side: 'server',
      uses: ['HasPhoneItem'],
      note: '`phoneNumber` is ignored: micaOS asks whether the player holds any phone.',
      fallback: false,
      run: (mica, source) => value(mica.HasPhoneItem(Number(source))) === true
    },
    {
      name: 'EndCall',
      side: 'server',
      uses: [],
      note: 'No equivalent: a call ends from the phone.',
      fallback: undefined
    },
    {
      name: 'GetCall',
      side: 'server',
      uses: [],
      note: 'No equivalent. `IsInCall(source)` answers whether there is one.',
      fallback: null
    },
    {
      name: 'NotifyEveryone',
      side: 'server',
      uses: [],
      note: "No equivalent; call micaOS's `SendNotification` per citizenid.",
      fallback: undefined
    },
    {
      name: 'SendCoords',
      side: 'server',
      uses: [],
      note: 'No equivalent.',
      fallback: undefined
    },

    // ---- client -------------------------------------------------------------------------
    {
      name: 'IsOpen',
      side: 'client',
      uses: ['IsPhoneOpen'],
      note: '',
      fallback: false,
      run: (mica) => value(mica.IsPhoneOpen()) === true
    },
    {
      name: 'ToggleOpen',
      side: 'client',
      uses: ['OpenPhone', 'ClosePhone', 'TogglePhone'],
      note: '`noFocus` is ignored.',
      fallback: undefined,
      run: (mica, open) => {
        if (open === true) mica.OpenPhone();
        else if (open === false) mica.ClosePhone();
        else mica.TogglePhone();
        return undefined;
      }
    },
    {
      name: 'IsDisabled',
      side: 'client',
      uses: ['IsPhoneEnabled'],
      note: '',
      fallback: false,
      run: (mica) => value(mica.IsPhoneEnabled()) === false
    },
    {
      name: 'ToggleDisabled',
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
      name: 'OpenApp',
      side: 'client',
      uses: ['OpenApp'],
      note: "lb-phone's app identifier is lowercased; micaOS's own ids differ for most apps.",
      fallback: undefined,
      run: (mica, app, data) => {
        mica.OpenApp(String(app || '').toLowerCase(), data);
        return undefined;
      }
    },
    {
      name: 'SendNotification',
      side: 'client',
      uses: ['Notify'],
      note: 'A toast only, as in lb-phone; `thumbnail` and `avatar` are dropped.',
      fallback: undefined,
      run: (mica, data) => {
        if (!data || typeof data !== 'object') return undefined;
        mica.Notify({
          type: 'info',
          title: data.title ? String(data.title) : undefined,
          message: String(data.content || data.title || '')
        });
        return undefined;
      }
    },
    {
      name: 'GetEquippedPhoneNumber',
      side: 'client',
      uses: ['GetPhoneNumber'],
      note: '',
      fallback: null,
      run: (mica) => value(mica.GetPhoneNumber()) ?? null
    },
    {
      name: 'CreateCall',
      side: 'client',
      uses: ['server:CreateCall'],
      note:
        "Places the call through this bridge's server half, at most one every two seconds; " +
        '`company`, `videoCall` and `hideNumber` are ignored.',
      fallback: undefined,
      run: (mica, options) => {
        const number = options && typeof options === 'object' ? options.number : undefined;
        if (typeof number === 'string' && number.trim()) emitNet(CALL_EVENT, number);
        return undefined;
      }
    },
    {
      name: 'IsInCall',
      side: 'client',
      uses: ['IsInCall'],
      note: '',
      fallback: false,
      run: (mica) => value(mica.IsInCall()) === true
    },
    {
      name: 'AddContact',
      side: 'client',
      uses: [],
      note: 'Server-side only in micaOS: `AddContact(citizenid, contact)`.',
      fallback: false
    },
    {
      name: 'HasPhoneItem',
      side: 'client',
      uses: [],
      note:
        'Server-side only in micaOS: `HasPhoneItem(source)`. The client `IsPhoneEnabled` is ' +
        'also false while the phone is confiscated.',
      fallback: false
    },
    {
      name: 'GetBattery',
      side: 'client',
      uses: [],
      note: 'Server-side only in micaOS: `GetBatteryLevel(source)`.',
      fallback: null
    },
    {
      name: 'CloseApp',
      side: 'client',
      uses: [],
      note: 'No equivalent.',
      fallback: undefined
    }
  ];

  globalThis.micaBridge = { resource: 'lb-phone', callEvent: CALL_EVENT, entries };
})();

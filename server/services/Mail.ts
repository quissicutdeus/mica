// SPDX-FileCopyrightText: 2026 quissicutdeus
//
// SPDX-License-Identifier: AGPL-3.0-or-later

import { defineService, SchemaRepository } from '../lib/defineService';
import { Mail } from '@mica/shared/types';
import { AuditLogger } from '../lib/AuditLogger';
import { FrameworkBridge } from '../lib/FrameworkBridge';
import { Database } from '../lib/Database';
import { appEventChannel } from '../lib/appEvents';
import { flagUnlessFalse } from '../lib/payload';
import { MAIL_CONTENT_MAX, mailContract } from '@mica/shared/contracts/mail';
import { openRows, storablePlaintext } from '../lib/contentCipher';
import { buildDeepLink } from '@mica/shared/deepLink';
import { notificationFailureReason } from './Notifications';

/**
 * Mail: `read: 'owner'`, `write: 'server'`.
 *
 * Nobody writes mail from their own phone — it arrives from jobs, dispatches and
 * bank alerts via the `SendSystemEmail` export below. The `server` write axis therefore
 * closes the generic create/update path entirely, while reads and deletes stay
 * ownership-scoped because a mail row still belongs to exactly one citizenid.
 *
 * **Receive-only is a decision, not an omission (MICA-58).** Two things would have to
 * be invented before a player could compose or reply, and neither is small: an address
 * namespace — the only way to name a player anywhere in this phone is the framework's
 * phone number, and reusing it would make Mail a slower Messages with a subject line —
 * and a sender identity on the row. `sender` and `sender_address` are display strings an
 * external resource passes in; no mail that exists carries the citizenid a reply would
 * be delivered to, and `SendSystemEmail`'s signature is published and frozen. So the
 * inbox says it only receives rather than growing a compose button that could only ever
 * answer a no-reply address. `reachability.test.ts` pins the reachable action set, so
 * reopening this is a deliberate act rather than a drift.
 *
 * `read` is a MySQL reserved word. Every generated and hand-written identifier here
 * is backtick-quoted, which is what makes the column usable at all.
 */
class MailRepository extends SchemaRepository<Mail> {
  /**
   * Everything not deleted, newest first — archived mail still shows in the UI. Bodies are
   * sealed at rest (MICA-165) and opened here; `*` carries the owner they are bound to.
   */
  async findAllByCitizenId(citizenid: string): Promise<Mail[]> {
    const query = `
            SELECT * FROM \`mica_mail\`
            WHERE \`citizenid\` = ? AND \`status\` != 'deleted'
            ORDER BY \`created_at\` DESC
        `;
    return openRows(this.tableName, await Database.query<Mail[]>(query, [citizenid]));
  }

  async markAsRead(id: number, citizenid: string): Promise<boolean> {
    const query = 'UPDATE `mica_mail` SET `read` = 1 WHERE `id` = ? AND `citizenid` = ?';
    return await Database.update(query, [id, citizenid]);
  }

  async archive(id: number, citizenid: string, archiveState: boolean = true): Promise<boolean> {
    const query = 'UPDATE `mica_mail` SET `status` = ? WHERE `id` = ? AND `citizenid` = ?';
    return await Database.update(query, [archiveState ? 'archived' : 'active', id, citizenid]);
  }

  /** Privileged: writes a row on another player's behalf, so no ownership predicate. */
  async createForCitizen(mail: Partial<Mail>): Promise<number> {
    return await this.create(mail);
  }
}

let mailRepo!: MailRepository;

export const mail = defineService<Mail, typeof mailContract>({
  contract: mailContract,
  id: 'mail',
  app: 'mail',
  access: { read: 'owner', write: 'server' },
  statuses: ['active', 'archived', 'deleted', 'moderated'],
  /** A mail row is its own thread: the body is bound to its table, column and owner alone. */
  encryptionScope: [],
  schema: {
    sender: { type: 'string', length: 100, notNull: true },
    sender_address: { type: 'string', length: 100 },
    subject: { type: 'string', length: 255, notNull: true },
    /** Sealed at rest (MICA-165); at most `MAIL_CONTENT_MAX` characters, so the seal fits. */
    content: { type: 'text', notNull: true, encrypted: true },
    read: { type: 'bool', notNull: true, default: 0 }
  },
  indexes: [
    { name: 'citizenid_status_created', columns: ['citizenid', 'status', 'created_at'] },
    { name: 'citizenid_read_status', columns: ['citizenid', 'read', 'status'] }
  ],
  // Reads and deletes are custom below: the list needs an explicit ORDER BY, and
  // delete/archive carry their own audit entries.
  options: { disableGet: true, disableDelete: true },
  repositoryFactory: (resolved) => {
    mailRepo = new MailRepository(resolved);
    return mailRepo;
  }
});

const app = mail.app;

const auditMail = (citizenid: string, action: 'archived' | 'unarchived' | 'deleted', id: number) =>
  AuditLogger.log({
    citizenid,
    action,
    service: 'mail',
    method: action === 'deleted' ? 'deleteMail' : 'archiveMail',
    targetId: id,
    targetTable: 'mica_mail'
  });

app.registerEvent('getMail', async (source, cbId, data, citizenid) => {
  return await mailRepo.findAllByCitizenId(citizenid);
});

app.registerEvent('markAsRead', async (source, cbId, data, citizenid) => {
  return await mailRepo.markAsRead(data.id, citizenid);
});

app.registerEvent('archiveMail', async (source, cbId, data, citizenid) => {
  const id = data.id;
  const shouldArchive = flagUnlessFalse(data.archive);

  const success = await mailRepo.archive(id, citizenid, shouldArchive);
  if (success) {
    await auditMail(citizenid, shouldArchive ? 'archived' : 'unarchived', id);
  }
  return success;
});

app.registerEvent('deleteMail', async (source, cbId, data, citizenid) => {
  const id = data.id;

  const success = await mailRepo.delete(id, citizenid);
  if (success) {
    await auditMail(citizenid, 'deleted', id);
  }
  return success;
});

/**
 * Global Server Export: SendSystemEmail
 *
 * Lets external resources (jobs, dispatches, bank alerts) drop mail into a player's
 * mailbox. This is the only write path into the table, which is what
 * `write: 'server'` is asserting.
 */
export const SendSystemEmail = async (
  targetCitizenId: string,
  emailData: {
    sender: string;
    sender_address?: string;
    subject: string;
    content: string;
  }
): Promise<Mail | null> => {
  let newMail: Mail;
  try {
    /**
     * Refused past `MAIL_CONTENT_MAX`, which is what fits the column once sealed (MICA-165).
     * The null this has always answered for a mail it could not deliver, said in the console
     * rather than left for the insert to fail on.
     */
    if (typeof emailData?.content === 'string' && emailData.content.length > MAIL_CONTENT_MAX) {
      console.error(
        `SendSystemEmail: a mail body is at most ${MAIL_CONTENT_MAX} characters; this one is ` +
          `${emailData.content.length}. Not delivered.`
      );
      return null;
    }
    const mailItem: Partial<Mail> = {
      citizenid: targetCitizenId,
      sender: emailData.sender,
      sender_address: emailData.sender_address || 'system@mica.local',
      subject: emailData.subject,
      // A script's words, often a player's relayed: never refused for starting like a sealed
      // value (MICA-165), and never lost to a null the caller cannot tell from a failure.
      content: await storablePlaintext(emailData.content, MAIL_CONTENT_MAX),
      status: 'active',
      read: false
    };

    const id = await mailRepo.createForCitizen(mailItem);
    newMail = {
      ...mailItem,
      id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    } as Mail;
  } catch (error) {
    // The driver's last line only: oxmysql's message carries the parameters, which are this
    // mail's sender, subject and body (MICA-329).
    console.error(`Error in SendSystemEmail: ${notificationFailureReason(error)}`);
    return null;
  }

  // The row exists from here on, so the answer is the mail whatever the notify steps do: a null
  // reads to the calling script as "not delivered", and one that retries would put a second
  // copy in the inbox (MICA-333). Each step is caught on its own so a failed live push cannot
  // cost the stored notification, and is logged by id, never by subject or body.
  const mailId = newMail.id;
  notifyStep(mailId, targetCitizenId, 'live push', () => {
    const players = FrameworkBridge.getAllPlayers();
    for (const src in players) {
      if (players[src]?.PlayerData?.citizenid === targetCitizenId) {
        emitNet('mica:client:mail:receive', parseInt(src, 10), newMail);
        break;
      }
    }
  });

  notifyStep(mailId, targetCitizenId, 'app event', () => {
    appEventChannel('mail').push(
      targetCitizenId,
      'email',
      { id: mailId, sender: emailData.sender, subject: emailData.subject },
      {
        notify: {
          type: 'info',
          title: `Email from ${emailData.sender}`,
          message: emailData.subject
        },
        kind: 'email',
        title: `Email from ${emailData.sender}`,
        deepLink: buildDeepLink('mail', { mailId })
      }
    );
  });

  return newMail;
};

/** One notify step after a system mail is stored: logged on failure, never thrown. */
const notifyStep = (mailId: number, citizenid: string, step: string, run: () => void): void => {
  try {
    run();
  } catch (error) {
    console.error(
      `[mail] stored system mail ${mailId} for ${citizenid}, but its ${step} failed ` +
        `(${notificationFailureReason(error)}); the mail is in their inbox.`
    );
  }
};

// Registration moved to `lib/publicApi.ts`, which is the one place the public surface is
// declared and the only place a contract test can read it. The function stays here,
// because it belongs to Mail.

import { defineService, SchemaRepository } from '../lib/defineService';
import { Mail } from '@shared/types';
import { AuditLogger } from '../lib/AuditLogger';
import { FrameworkBridge } from '../lib/FrameworkBridge';
import { Database } from '../lib/Database';
import { fields, flagUnlessFalse, requirePositiveInt } from '../lib/payload';

/**
 * Mail: `read: 'owner'`, `write: 'server'`.
 *
 * Nobody writes mail from their own phone — it arrives from jobs, dispatches and
 * bank alerts via the `SendSystemEmail` export below. The `server` write axis therefore
 * closes the generic create/update path entirely, while reads and deletes stay
 * ownership-scoped because a mail row still belongs to exactly one citizenid.
 *
 * `read` is a MySQL reserved word. Every generated and hand-written identifier here
 * is backtick-quoted, which is what makes the column usable at all.
 */
class MailRepository extends SchemaRepository<Mail> {
  /** Everything not deleted, newest first — archived mail still shows in the UI. */
  async findAllByCitizenId(citizenid: string): Promise<Mail[]> {
    const query = `
            SELECT * FROM \`gphone_mail\`
            WHERE \`citizenid\` = ? AND \`status\` != 'deleted'
            ORDER BY \`created_at\` DESC
        `;
    return await Database.query<Mail[]>(query, [citizenid]);
  }

  async markAsRead(id: number, citizenid: string): Promise<boolean> {
    const query = 'UPDATE `gphone_mail` SET `read` = 1 WHERE `id` = ? AND `citizenid` = ?';
    return await Database.update(query, [id, citizenid]);
  }

  async archive(id: number, citizenid: string, archiveState: boolean = true): Promise<boolean> {
    const query = 'UPDATE `gphone_mail` SET `status` = ? WHERE `id` = ? AND `citizenid` = ?';
    return await Database.update(query, [archiveState ? 'archived' : 'active', id, citizenid]);
  }

  /** Privileged: writes a row on another player's behalf, so no ownership predicate. */
  async createForCitizen(mail: Partial<Mail>): Promise<number> {
    return await this.create(mail);
  }
}

let mailRepo!: MailRepository;

export const mail = defineService<Mail>({
  id: 'mail',
  access: { read: 'owner', write: 'server' },
  statuses: ['active', 'archived', 'deleted', 'moderated'],
  schema: {
    sender: { type: 'string', length: 100, notNull: true },
    sender_address: { type: 'string', length: 100 },
    subject: { type: 'string', length: 255, notNull: true },
    content: { type: 'text', notNull: true },
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
    targetTable: 'gphone_mail'
  });

app.registerEvent('getMail', async (source, cbId, data, citizenid) => {
  return await mailRepo.findAllByCitizenId(citizenid);
});

app.registerEvent('markAsRead', async (source, cbId, data, citizenid) => {
  const id = requirePositiveInt(fields(data).id, 'email id');
  return await mailRepo.markAsRead(id, citizenid);
});

app.registerEvent('archiveMail', async (source, cbId, data, citizenid) => {
  const id = requirePositiveInt(fields(data).id, 'email id');
  const shouldArchive = flagUnlessFalse(fields(data).archive);

  const success = await mailRepo.archive(id, citizenid, shouldArchive);
  if (success) {
    await auditMail(citizenid, shouldArchive ? 'archived' : 'unarchived', id);
  }
  return success;
});

app.registerEvent('deleteMail', async (source, cbId, data, citizenid) => {
  const id = requirePositiveInt(fields(data).id, 'email id');

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
const SendSystemEmail = async (
  targetCitizenId: string,
  emailData: {
    sender: string;
    sender_address?: string;
    subject: string;
    content: string;
  }
): Promise<Mail | null> => {
  try {
    const mailItem: Partial<Mail> = {
      citizenid: targetCitizenId,
      sender: emailData.sender,
      sender_address: emailData.sender_address || 'system@gphone.local',
      subject: emailData.subject,
      content: emailData.content,
      status: 'active',
      read: false
    };

    const id = await mailRepo.createForCitizen(mailItem);
    const newMail: Mail = {
      ...mailItem,
      id,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    } as Mail;

    // Notify the recipient if they are online.
    const players = FrameworkBridge.getAllPlayers();
    for (const src in players) {
      if (players[src]?.PlayerData?.citizenid === targetCitizenId) {
        emitNet('gphone:client:mail:receive', parseInt(src, 10), newMail);
        break;
      }
    }

    return newMail;
  } catch (error) {
    console.error('Error in SendSystemEmail:', error);
    return null;
  }
};

// `exports` is callable only under the FiveM runtime. This module is now also
// imported by the SQL codegen and by server tests, where the host supplies a
// non-callable `exports` binding that shadows any global stub — so guard the call
// rather than throwing on import.
if (typeof exports === 'function') {
  exports('SendSystemEmail', SendSystemEmail);
}

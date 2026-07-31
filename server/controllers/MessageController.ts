import { MessageRepository } from '../repositories/MessageRepository';
import { ServerApp } from '../lib/ServerApp';
import { Message } from '@shared/types';

const messageRepo = new MessageRepository();
const app = new ServerApp<Message>('messages', messageRepo, {
  disableGet: true,
  disableCreate: true,
  disableUpdate: true,
  disableDelete: true
});

app.registerEvent('get', async (source, cbId, conversationId, citizenid, player) => {
  // conversationId passed as data
  const messages = await messageRepo.findByConversation(conversationId);
  return messages;
});

app.registerEvent('send', async (source, cbId, data, citizenid) => {
  // data: { conversation_id, message, attachments? }
  const newMessage: Partial<Message> = {
    conversation_id: data.conversation_id,
    citizenid: citizenid,
    message: data.message,
    attachments: data.attachments || [], // Array of { attachment }
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    status: 'active'
  };

  const id = await messageRepo.create(newMessage);
  return { ...newMessage, id };
});

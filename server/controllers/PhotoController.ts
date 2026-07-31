import { PhotoRepository } from '../repositories/PhotoRepository';
import { ServerApp } from '../lib/ServerApp';
import { Photo } from '@shared/types';
import { AuditLogger } from '../lib/AuditLogger';

const photoRepo = new PhotoRepository();
const app = new ServerApp<Photo>('photos', photoRepo, { disableDelete: true, disableGet: true });

app.registerEvent('get', async (source: number, cbId: any, data: any, citizenid: string) => {
  // Only return visible photos
  const result = await photoRepo.findAll({ ...data, citizenid, status: 'active' } as any);
  return result;
});

app.registerEvent('delete', async (source: number, cbId: any, data: any, citizenid: string) => {
  if (!data.id) throw new Error('ID required for delete');
  // Soft delete: just update the status instead of actually deleting the row
  const success = await photoRepo.update(data.id, { status: 'deleted' });
  if (success) {
    await AuditLogger.log({
      citizenid,
      action: 'deleted',
      controller: 'PhotoController',
      method: 'delete',
      targetId: Number(data.id),
      targetTable: 'gphone_photos'
    });
  }
  return success;
});

import { Repository } from '../lib/Repository';
import { Photo } from '@shared/types';

export class PhotoRepository extends Repository<Photo> {
  protected tableName = 'gphone_photos';

  protected columns = ['id', 'citizenid', 'image', 'status', 'created_at', 'updated_at'];

  protected clientWritable = ['image'];

  async findAll(where: Partial<Photo> = {}): Promise<Photo[]> {
    const photos = await super.findAll(where);
    return photos.map((photo) => {
      if (photo.image && typeof photo.image !== 'string') {
        photo.image = (photo.image as any).toString('utf8');
      }
      return photo;
    });
  }

  async findById(id: number | string, citizenid?: string): Promise<Photo | null> {
    const photo = await super.findById(id, citizenid);
    if (photo && photo.image && typeof photo.image !== 'string') {
      photo.image = (photo.image as any).toString('utf8');
    }
    return photo;
  }
}

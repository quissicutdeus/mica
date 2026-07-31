import { PhotoRepository } from '../repositories/PhotoRepository';
import { ServerApp } from '../lib/ServerApp';
import { Photo } from '@shared/types';

const photoRepo = new PhotoRepository();

// The generic CRUD path now covers photos completely: `get` filters to
// status = 'active' by default, and `delete` is an ownership-scoped soft delete
// that writes the audit entry. A stored photo has no mutable fields, so `update`
// stays closed rather than existing as a dead endpoint.
const app = new ServerApp<Photo>('photos', photoRepo, { disableUpdate: true });

import { createCrudStore, byNewest } from './createCrudStore';

export interface MarketplaceRow {
  id: number;
  citizenid: string;
  title: string;
  created_at: string;
  updated_at: string;
}

export const marketplace = createCrudStore<MarketplaceRow, Pick<MarketplaceRow, 'title'>>(
  'Marketplace',
  {
    list: 'getMarketplace',
    create: 'createMarketplace',
    update: 'updateMarketplace',
    remove: 'deleteMarketplace'
  },
  { sort: byNewest<MarketplaceRow>('updated_at') }
);

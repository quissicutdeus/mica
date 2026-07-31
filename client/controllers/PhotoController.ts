import { ClientApp } from '../lib/ClientApp';

const app = new ClientApp('photos');

app.registerCallback('getPhotos', 'gphone:server:photos:get');
app.registerCallback('createPhoto', 'gphone:server:photos:create');
// No `updatePhoto`: a stored photo has no mutable fields, and the server no longer
// registers the endpoint. Nothing in web/ ever called it.
app.registerCallback('deletePhoto', 'gphone:server:photos:delete');

import './controllers';

on('onResourceStart', (resName: string) => {
  if (resName === GetCurrentResourceName()) {
    console.log('gphone started!');
  }
});

const { app, BrowserWindow, ipcMain, desktopCapturer, session } = require('electron');
const path = require('path');

if (!app.requestSingleInstanceLock()) app.quit();

let win = null;
let choice = null; // fonte escolhida no seletor (tela ou janela)

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#1e1f22',
    title: 'Transmitir Tela',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
      backgroundThrottling: false // não pausa a transmissão ao minimizar
    }
  });
  win.setMenuBarVisibility(false);
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.on('closed', () => { win = null; });
}

app.on('second-instance', () => {
  if (win) { if (win.isMinimized()) win.restore(); win.focus(); }
});

app.whenReady().then(() => {
  const ses = session.defaultSession;

  const ALLOW = ['media', 'display-capture', 'fullscreen', 'clipboard-sanitized-write', 'window-management'];
  ses.setPermissionRequestHandler((wc, permission, cb) => cb(ALLOW.includes(permission)));
  ses.setPermissionCheckHandler((wc, permission) => ALLOW.includes(permission)); // necessário para listar os nomes dos microfones

  // O app mostra o próprio seletor; aqui só entregamos a fonte escolhida.
  ses.setDisplayMediaRequestHandler((request, callback) => {
    if (!choice) return callback({});
    const stream = { video: choice };
    if (request.audioRequested) stream.audio = 'loopback'; // áudio do sistema (Windows)
    callback(stream);
  }, { useSystemPicker: false });

  createWindow();
  app.on('activate', () => { if (!BrowserWindow.getAllWindows().length) createWindow(); });
});

app.on('window-all-closed', () => app.quit());

ipcMain.handle('sources', async () => {
  const list = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: false
  });
  return list.map(s => ({
    id: s.id,
    name: s.name,
    type: s.id.startsWith('screen') ? 'screen' : 'window',
    thumb: s.thumbnail.toDataURL()
  }));
});

ipcMain.handle('choose', async (e, id) => {
  const list = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
  choice = list.find(s => s.id === id) || null;
  return !!choice;
});

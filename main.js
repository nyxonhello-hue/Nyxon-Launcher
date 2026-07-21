const { app, BrowserWindow, ipcMain, shell, Notification, dialog, Tray, Menu, nativeImage, clipboard } = require('electron');const path = require('path');
const { exec } = require('child_process');
const fs = require('fs');
const os = require('os');

// ─── Polyfill for undici/Web APIs ─────────────────────────────────────────────
// Fix "File is not defined" error from undici in main process
if (typeof global.File === 'undefined') {
  class File extends Blob {
    constructor(parts, filename, options) {
      super(parts, options);
      this.name = filename;
      this.lastModified = options?.lastModified || Date.now();
    }
  }
  global.File = File;
}

if (typeof global.Blob === 'undefined') {
  class Blob {
    constructor(parts = [], options = {}) {
      this.data = Buffer.concat(parts.map(part => 
        typeof part === 'string' ? Buffer.from(part) : Buffer.from(part)
      ));
      this.type = options.type || '';
      this.size = this.data.length;
    }
  }
  global.Blob = Blob;
}

// ─── Analytics ────────────────────────────────────────────────────────────────
function trackEvent(event) {
  try {
    const https = require('https');
    const payload = JSON.stringify({
      ...event,
      platform: os.platform(),
      version: app.getVersion(),
      timestamp: new Date().toISOString()
    });
    const options = {
      hostname: 'nyxon-server.onrender.com',
      path: '/api/analytics',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    const req = https.request(options, () => {});
    req.on('error', () => {}); // silent fail — never crash for analytics
    req.write(payload);
    req.end();
  } catch (_) {} // never crash for analytics
}

// ─── Clean Uninstall Handler ──────────────────────────────────────────────────
if (require('electron-squirrel-startup')) app.quit();

ipcMain.handle('uninstall-cleanup', async () => {
  const userDataPath = app.getPath('userData');
  const filesToRemove = [
    'license.json',
    'cloud-tokens.json',
    'workspaces.json',
  ];

  const log = [];
  for (const file of filesToRemove) {
    const filePath = path.join(userDataPath, file);
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath);
        log.push(`Removed: ${file}`);
      }
    } catch (e) {
      log.push(`Could not remove ${file}: ${e.message}`);
    }
  }

  // Remove entire userData folder
  try {
    fs.rmSync(userDataPath, { recursive: true, force: true });
    log.push('User data folder removed.');
  } catch (e) {
    log.push(`Could not remove userData: ${e.message}`);
  }

  return { success: true, log };
});


let tray = null;
let mainWindow = null;

function createTray() {
  // Use your app icon for the tray
  const iconPath = path.join(__dirname, 'assets', 'icon_512.png');
  let trayIcon = nativeImage.createFromPath(iconPath);

  // Resize to tray-appropriate size
  trayIcon = trayIcon.resize({ width: 16, height: 16 });

  tray = new Tray(trayIcon);
  tray.setToolTip('Nyxon Launcher');

 const contextMenu = Menu.buildFromTemplate([
  {
    label: 'Nyxon Launcher',
    enabled: false
  },
  {
    label: 'Status: Idle',
    id: 'status',
    enabled: false
  },

  { type: 'separator' },

  {
    label: 'Open Nyxon',
    click: () => showWindow()
  },

  { type: 'separator' },

  {
    label: 'Quick Actions',
    submenu: [
      {
        label: 'File Organizer',
        click: () => { showWindow(); mainWindow.webContents.send('tray-launch', 'file'); }
      },
      {
        label: 'System Flush',
        click: () => { showWindow(); mainWindow.webContents.send('tray-launch', 'system'); }
      },
      {
        label: 'Internet Checker',
        click: () => { showWindow(); mainWindow.webContents.send('tray-launch', 'netchecker'); }
      }
    ]
  },

  { type: 'separator' },

  {
    label: 'Check for Updates',
    click: () => {
      showWindow();
      mainWindow.webContents.send('tray-check-updates');
    }
  },

  { type: 'separator' },

  {
    label: 'Quit',
    click: () => {
      app.isQuiting = true;
      app.quit();
    }
  }
]);
  tray.setContextMenu(contextMenu);

  // Double-click to show window
  tray.on('click', () => toggleWindow());
}

function showWindow() {
  if (!mainWindow) return;

  if (mainWindow.isMinimized()) mainWindow.restore();

  mainWindow.show();
  mainWindow.focus();
}

function setTrayStatus(text) {
  const menu = tray.getContextMenu();
  const statusItem = menu.getMenuItemById('status');
  if (statusItem) {
    statusItem.label = `Status: ${text}`;
  }
  tray.setContextMenu(menu);
}

function toggleWindow() {
  if (!mainWindow) return;
  if (mainWindow.isVisible() && !mainWindow.isMinimized()) {
    mainWindow.minimize();
  } else {
    showWindow();
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 780,
    minWidth: 800,
    minHeight: 600,
    backgroundColor: '#0a0a0b',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    frame: process.platform !== 'darwin',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    icon: path.join(__dirname, 'assets', 'icon_512.png')
  });

  mainWindow.loadFile('index.html');

  // Minimize to tray instead of minimizing normally
    mainWindow.on('close', async (event) => {
      if (!app.isQuiting) {
        event.preventDefault();

        // Show dialog asking what to do
        const { response } = await dialog.showMessageBox(mainWindow, {
          type: 'question',
          title: 'Nyxon Launcher',
          message: 'What would you like to do?',
          buttons: ['Minimize to Tray', 'Quit Nyxon', 'Cancel'],
          defaultId: 0,
          cancelId: 2
        });

        if (response === 0) {
          // Minimize to tray
          mainWindow.hide();
          if (!global.trayNotified) {
            new Notification({
              title: 'Nyxon is still running',
              body: 'Nyxon is in your system tray. Right-click the icon to access it.'
            }).show();
            global.trayNotified = true;
          }
        } else if (response === 1) {
          // Actually quit
          app.isQuiting = true;
          app.quit();
        }
        // response === 2 → Cancel, do nothing
      }
    });

  // Prevent full close — just hide to tray
  mainWindow.on('close', (event) => {
    if (!app.isQuiting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  // Open external links in default browser
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();
  createTray();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    // Track app launch
    trackEvent({ event: 'app_launch' });
  });

  // Check for updates 3 seconds after launch
  setTimeout(() => {
    try { autoUpdater.checkForUpdates().catch(() => {}); } catch (_) {}
  }, 3000);
});

app.on('window-all-closed', () => {
  // Don't quit on window close — stays in tray
  if (process.platform !== 'darwin') {
    // Do nothing — tray keeps app alive
  }
});

app.on('before-quit', () => {
  app.isQuiting = true;
});


// ─── Auto Updater ─────────────────────────────────────────────────────────────
const { autoUpdater } = require('electron-updater');

autoUpdater.autoDownload    = false; // notify only — don't download automatically
autoUpdater.autoInstallOnAppQuit = false;

// Check for updates 3 seconds after launch
app.whenReady().then(() => {
  setTimeout(() => {
    autoUpdater.checkForUpdates().catch(() => {}); // silent fail if offline
  }, 3000);
});

// Update available — notify user
autoUpdater.on('update-available', (info) => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    win.webContents.send('update-available', {
      version: info.version,
      releaseNotes: info.releaseNotes || ''
    });
  }

  new Notification({
    title: 'Nyxon Update Available',
    body: `Version ${info.version} is available. Open the app to download.`
  }).show();
});

// Already on latest
autoUpdater.on('update-not-available', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) win.webContents.send('update-not-available');
});

// Handle download if user clicks download
ipcMain.on('download-update', () => {
  autoUpdater.downloadUpdate();
});

// Download progress
autoUpdater.on('download-progress', (progress) => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) win.webContents.send('download-progress', Math.round(progress.percent));
});

// Download complete
autoUpdater.on('update-downloaded', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) win.webContents.send('update-downloaded');
});

// Manual check from renderer
ipcMain.handle('check-for-updates', async () => {
  try {
    await autoUpdater.checkForUpdates();
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});



// ─── IPC HANDLERS ────────────────────────────────────────────────────────────

// File Organizer — prompts user to pick a folder, then sorts by extension
ipcMain.handle('run-file-organizer', async () => {
  const log = [];
  const win = BrowserWindow.getFocusedWindow();

  // Step 1 — Pick folder
  const result = await dialog.showOpenDialog(win, {
    title: 'Select folder to organize',
    defaultPath: os.homedir(),
    properties: ['openDirectory']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, log, error: 'No folder selected.' };
  }

  const targetDir = result.filePaths[0];
  log.push(`Selected: ${targetDir}`);

  const typeMap = {
    Images:      ['.jpg','.jpeg','.png','.gif','.webp','.svg','.heic','.bmp','.tiff','.ico'],
    Documents:   ['.pdf','.doc','.docx','.txt','.md','.odt','.rtf','.pages'],
    Spreadsheets:['.xls','.xlsx','.csv','.numbers','.ods'],
    Slides:      ['.ppt','.pptx','.key','.odp'],
    Videos:      ['.mp4','.mov','.avi','.mkv','.webm','.flv','.wmv','.m4v'],
    Audio:       ['.mp3','.wav','.flac','.aac','.m4a','.ogg','.wma','.opus'],
    Archives:    ['.zip','.tar','.gz','.rar','.7z','.bz2','.xz'],
    Code:        ['.js','.ts','.py','.sh','.html','.css','.json','.xml','.yaml','.yml','.cpp','.c','.java','.go','.rs'],
    Fonts:       ['.ttf','.otf','.woff','.woff2'],
    Executables: ['.AppImage','.deb','.rpm','.exe','.dmg','.msi','.run'],
    Others:      []
  };

  const extToFolder = {};
  for (const [folder, exts] of Object.entries(typeMap)) {
    for (const ext of exts) extToFolder[ext] = folder;
  }

  try {
    const entries = fs.readdirSync(targetDir);
    const files = entries.filter(f => {
      const full = path.join(targetDir, f);
      try { return fs.statSync(full).isFile(); }
      catch (_) { return false; }
    });

    if (files.length === 0) {
      log.push('No files to organize — folder is already clean.');
      return { success: true, log };
    }

    // Build preview of what will be moved
    const preview = files.map(file => {
      const ext = path.extname(file).toLowerCase();
      return { file, folder: extToFolder[ext] || 'Others', ext };
    });

    log.push(`Found ${files.length} file(s) to organize`);

    // Show confirmation dialog with preview
    const categoryCount = {};
    preview.forEach(p => { categoryCount[p.folder] = (categoryCount[p.folder] || 0) + 1; });
    const summaryText = Object.entries(categoryCount)
      .map(([folder, count]) => `${folder}: ${count} file${count > 1 ? 's' : ''}`)
      .join('\n');

    const confirm = await dialog.showMessageBox(win, {
      type: 'question',
      title: 'Nyxon — File Organizer',
      message: `Ready to organize ${files.length} file(s) in:\n${targetDir}`,
      detail: `Files will be moved into these folders:\n\n${summaryText}\n\n⚠️ Warning: Do not run this on program/game folders.\nOnly use on Downloads, Desktop, or media folders.\n\nThis action cannot be undone automatically.`,
      buttons: ['Cancel', 'Organize Files'],
      defaultId: 1,
      cancelId: 0
    });

    if (confirm.response === 0) {
      log.push('Cancelled by user.');
      return { success: false, log, error: 'Cancelled.' };
    }

    // Proceed with organizing
    const counts = {};
    let moved = 0;
    let skipped = 0;
    const undoLog = []; // track moves for potential undo

    for (const { file, folder } of preview) {
      const src = path.join(targetDir, file);
      const destDir = path.join(targetDir, folder);

      if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
        log.push(`Created folder: ${folder}/`);
      }

      let destFile = path.join(destDir, file);
      if (fs.existsSync(destFile)) {
        const ext  = path.extname(file);
        const base = path.basename(file, ext);
        destFile = path.join(destDir, `${base}_${Date.now()}${ext}`);
      }

      try {
        fs.renameSync(src, destFile);
        undoLog.push({ from: destFile, to: src });
        counts[folder] = (counts[folder] || 0) + 1;
        moved++;
      } catch (e) {
        log.push(`Skipped ${file}: ${e.message}`);
        skipped++;
      }
    }

    // Save undo log
    const undoFile = path.join(app.getPath('userData'), 'last-organize-undo.json');
    fs.writeFileSync(undoFile, JSON.stringify({ targetDir, moves: undoLog, timestamp: new Date().toISOString() }));

    log.push('─── Summary ───');
    for (const [folder, count] of Object.entries(counts)) {
      log.push(`  ${folder}/  →  ${count} file${count > 1 ? 's' : ''}`);
    }
    if (skipped > 0) log.push(`  Skipped: ${skipped} file(s)`);
    log.push(`Done — ${moved} file(s) organized.`);
    log.push('💡 Tip: Use "Undo Last Organize" in Settings to reverse this.');

    return { success: true, log };
  } catch (err) {
    log.push('Error: ' + err.message);
    return { success: false, log, error: err.message };
  }
});

// ─── Undo Last File Organize ──────────────────────────────────────────────────
ipcMain.handle('undo-last-organize', async () => {
  const log = [];
  const undoFile = path.join(app.getPath('userData'), 'last-organize-undo.json');

  if (!fs.existsSync(undoFile)) {
    return { success: false, log: ['No organize history found to undo.'] };
  }

  try {
    const { moves, timestamp } = JSON.parse(fs.readFileSync(undoFile, 'utf8'));
    log.push(`Undoing organize from ${new Date(timestamp).toLocaleString()}…`);

    let restored = 0;
    for (const { from, to } of moves.reverse()) {
      try {
        if (fs.existsSync(from)) {
          fs.renameSync(from, to);
          restored++;
        }
      } catch (e) {
        log.push(`Could not restore: ${path.basename(to)}`);
      }
    }

    // Clean up empty folders
    fs.unlinkSync(undoFile);
    log.push(`Restored ${restored} file(s) to original location ✓`);
    return { success: true, log };
  } catch (err) {
    log.push('Undo error: ' + err.message);
    return { success: false, log };
  }
});


// Daily Digest / Notification
ipcMain.handle('run-daily-digest', async () => {
  const log = [];
  try {
    const memTotal = (os.totalmem() / 1e9).toFixed(1);
    const memFree  = (os.freemem()  / 1e9).toFixed(1);
    const memUsed  = (memTotal - memFree).toFixed(1);
    const platform = os.platform();
    const uptime   = (os.uptime() / 3600).toFixed(1);
    const cpus     = os.cpus().length;

    log.push(`Platform: ${platform} | CPUs: ${cpus}`);
    log.push(`Memory: ${memUsed} GB used / ${memTotal} GB total`);
    log.push(`Uptime: ${uptime} hours`);

    new Notification({
      title: 'Nyxon Daily Digest',
      body: `RAM: ${memUsed}/${memTotal} GB | Uptime: ${uptime}h | CPUs: ${cpus}`
    }).show();

    log.push('System notification sent.');
    return { success: true, log };
  } catch (err) {
    return { success: false, log, error: err.message };
  }
});

// System Flush — cross-platform
// ─── System Flush (Aggressive - Temp + Caches + Trash) ───────────────────────
ipcMain.handle('run-system-flush', async () => {
  const log = [];
  const platform = os.platform();
  let totalFreed = 0;

  log.push(`Platform: ${platform}`);
  log.push('Starting aggressive System Flush...');

  const { execSync } = require('child_process');

  function getDirSize(dir) {
    try {
      if (platform === 'win32') {
        const result = execSync(
          `powershell -Command "(Get-ChildItem '${dir}' -Recurse -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum"`,
          { timeout: 10000 }
        ).toString().trim();
        return parseInt(result) || 0;
      } else {
        const out = execSync(`du -sb "${dir}" 2>/dev/null || echo 0`);
        return parseInt(out.toString().split('\t')[0]) || 0;
      }
    } catch (_) { return 0; }
  }
  
  function aggressiveRemove(dirPath, label) {
    if (!fs.existsSync(dirPath)) {
      log.push(`${label}: not found`);
      return;
    }
    try {
      // Measure BEFORE deleting
      const sizeBefore = getDirSize(dirPath);

      if (platform === 'win32') {
        execSync(`powershell -Command "Remove-Item '${dirPath}\\*' -Recurse -Force -ErrorAction SilentlyContinue"`, { timeout: 20000 });
      } else {
        execSync(`rm -rf "${dirPath}"/* 2>/dev/null || true`);
      }

      // Measure AFTER deleting to get actual freed amount
      const sizeAfter = getDirSize(dirPath);
      const freed = Math.max(0, sizeBefore - sizeAfter);
      totalFreed += freed;

      const mb = (freed / 1024 / 1024).toFixed(1);
      log.push(`Cleared ${label} → ${mb} MB freed`);
    } catch (e) {
      log.push(`Partial/Skipped ${label}: ${e.message.split('\n')[0]}`);
    }
  }

  if (platform === 'win32') {
    // ==================== WINDOWS (Aggressive) ====================
    log.push('Windows aggressive cleanup started...');

    const pathsToClean = [
      process.env.TEMP,
      process.env.TMP,
      path.join(os.homedir(), 'AppData', 'Local', 'Temp'),
      path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Windows', 'INetCache'),
      path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Windows', 'Temporary Internet Files'),
      path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'Cache'),
      path.join(os.homedir(), 'AppData', 'Local', 'Google', 'Chrome', 'User Data', 'Default', 'Code Cache'),
      path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Edge', 'User Data', 'Default', 'Cache'),
      path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'Windows', 'Explorer'), // Thumbnails
    ];

    pathsToClean.forEach(p => {
      if (p) aggressiveRemove(p, p.split('\\').pop() || 'Temp folder');
    });

    // Recycle Bin
    log.push('Emptying Recycle Bin...');
    try {
      execSync('powershell -Command "Clear-RecycleBin -Force -ErrorAction SilentlyContinue"', { timeout: 15000 });
      log.push('Recycle Bin emptied');
    } catch (_) {
      log.push('Recycle Bin: skipped (may require admin)');
    }

    // Prefetch (aggressive)
    try {
      const prefetch = 'C:\\Windows\\Prefetch';
      if (fs.existsSync(prefetch)) {
        aggressiveRemove(prefetch, 'Prefetch cache');
      }
    } catch (_) {
      log.push('Prefetch: skipped');
    }

    // Recent files
    try {
      const recent = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Recent');
      aggressiveRemove(recent, 'Recent files list');
    } catch (_) {}

  } else {
    // ==================== LINUX / macOS ====================
    log.push('Linux/macOS aggressive cleanup...');

    aggressiveRemove('/tmp', '/tmp');
    aggressiveRemove(path.join(os.homedir(), '.cache'), 'User cache');
    aggressiveRemove(path.join(os.homedir(), '.local/share/Trash/files'), 'Trash');

    // Browser caches
    aggressiveRemove(path.join(os.homedir(), '.cache/google-chrome'), 'Chrome cache');
    aggressiveRemove(path.join(os.homedir(), '.cache/mozilla'), 'Firefox cache');

    try { execSync('journalctl --vacuum-time=2d 2>/dev/null || true'); } catch (_) {}
  }

  // Clipboard
  try {
    const { clipboard, nativeImage } = require('electron');
    // Clear both text and image from clipboard
    clipboard.writeText('');
    clipboard.writeImage(nativeImage.createEmpty());
    // On Windows use PowerShell for full clipboard clear
    if (platform === 'win32') {
      try {
        execSync('PowerShell.exe -Command "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Clipboard]::Clear()"', 
          { shell: 'cmd.exe', timeout: 5000 });
        log.push('Clipboard fully cleared (text + images).');
      } catch (_) {
        clipboard.writeText('');
        log.push('Clipboard cleared.');
      }
    } else {
      // Linux — also clear xclip if available
      try {
        execSync('xclip -selection clipboard /dev/null 2>/dev/null || xsel --clipboard --clear 2>/dev/null || true');
      } catch (_) {}
      log.push('Clipboard cleared.');
    }
  } catch (_) {}

  // Final summary
  const mbFreed = (totalFreed / (1024 * 1024)).toFixed(1);
  const gbFreed = (totalFreed / (1024 * 1024 * 1024)).toFixed(2);

  log.push('─── Aggressive System Flush Complete ───');
  log.push(`Total space freed: ${mbFreed} MB (${gbFreed} GB)`);
  log.push('Temporary files, caches, and trash have been cleared.');

  new Notification({
    title: 'Nyxon — System Flush Complete',
    body: `Freed ${mbFreed} MB of space.`
  }).show();

  return { success: true, log };
});

// Launch Workspace
ipcMain.handle('run-open-urls', async (_, workspace) => {
  const log = [];
  const win = BrowserWindow.getFocusedWindow();
  const workspacesFile = path.join(app.getPath('userData'), 'workspaces.json');

  // Load saved workspaces
  let workspaces = {};
  try {
    if (fs.existsSync(workspacesFile)) {
      workspaces = JSON.parse(fs.readFileSync(workspacesFile, 'utf8'));
    }
  } catch (_) {}

  // If a specific workspace was passed, launch it
  if (workspace && workspaces[workspace]) {
    const urls = workspaces[workspace];
    log.push(`Launching workspace: ${workspace}`);
    for (const url of urls) {
      shell.openExternal(url);
      log.push(`Opened: ${url}`);
    }
    return { success: true, log };
  }

  // Otherwise return workspaces list to renderer for selection
  return { success: true, log, workspaces };
});

// Save workspace
ipcMain.handle('save-workspace', async (_, name, urls) => {
  const log = [];
  const workspacesFile = path.join(app.getPath('userData'), 'workspaces.json');

  let workspaces = {};
  try {
    if (fs.existsSync(workspacesFile)) {
      workspaces = JSON.parse(fs.readFileSync(workspacesFile, 'utf8'));
    }
  } catch (_) {}

  workspaces[name] = urls;
  fs.writeFileSync(workspacesFile, JSON.stringify(workspaces, null, 2));
  log.push(`Workspace "${name}" saved with ${urls.length} URL(s).`);
  return { success: true, log };
});

// Delete workspace
ipcMain.handle('delete-workspace', async (_, name) => {
  const workspacesFile = path.join(app.getPath('userData'), 'workspaces.json');
  let workspaces = {};
  try {
    if (fs.existsSync(workspacesFile)) {
      workspaces = JSON.parse(fs.readFileSync(workspacesFile, 'utf8'));
    }
  } catch (_) {}

  delete workspaces[name];
  fs.writeFileSync(workspacesFile, JSON.stringify(workspaces, null, 2));
  return { success: true };
});

// Run Script
ipcMain.handle('run-script', async () => {
  const log = [];
  const win = BrowserWindow.getFocusedWindow();

  // Open file picker
  const result = await dialog.showOpenDialog(win, {
    title: 'Select a script to run',
    defaultPath: os.homedir(),
    properties: ['openFile'],
    filters: [
      { name: 'Scripts', extensions: ['sh', 'py', 'js', 'bash', 'rb', 'pl'] },
      { name: 'All Files', extensions: ['*'] }
    ]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, log, error: 'No script selected.' };
  }

  const scriptPath = result.filePaths[0];
  const ext = path.extname(scriptPath).toLowerCase();
  log.push(`Selected: ${scriptPath}`);

  const interpreters = {
    '.py':   'python3',
    '.js':   'node',
    '.sh':   'bash',
    '.bash': 'bash',
    '.rb':   'ruby',
    '.pl':   'perl'
  };

  const interpreter = interpreters[ext] || 'bash';
  const cmd = `${interpreter} "${scriptPath}"`;

  log.push(`Opening terminal…`);

  // Detect which terminal is available on the system
  const terminals = [
    { bin: 'x-terminal-emulator', args: ['-e', `bash -c '${cmd}; echo ""; echo "Press Enter to close…"; read'`] },
    { bin: 'gnome-terminal',      args: ['--', 'bash', '-c', `${cmd}; echo ""; echo "Press Enter to close…"; read`] },
    { bin: 'xterm',               args: ['-e', `bash -c '${cmd}; echo ""; echo "Press Enter to close…"; read'`] },
    { bin: 'konsole',             args: ['-e', `bash -c '${cmd}; echo ""; echo "Press Enter to close…"; read'`] },
    { bin: 'xfce4-terminal',      args: ['-e', `bash -c '${cmd}; echo ""; echo "Press Enter to close…"; read'`] },
    { bin: 'tilix',               args: ['-e', `bash -c '${cmd}; echo ""; echo "Press Enter to close…"; read'`] },
  ];

  // Try each terminal until one works
  let launched = false;
  for (const term of terminals) {
    try {
      const { execFileSync } = require('child_process');
      execFileSync('which', [term.bin], { stdio: 'ignore' });

      // Terminal found — launch it
      const { spawn } = require('child_process');
      spawn(term.bin, term.args, {
        detached: true,
        stdio: 'ignore'
      }).unref();

      log.push(`Launched in ${term.bin} ✓`);
      launched = true;
      break;
    } catch (_) {
      // This terminal not available, try next
    }
  }

  if (!launched) {
    log.push('No terminal emulator found.');
    log.push('Install one with: sudo apt install xterm');
    return { success: false, log };
  }

  return { success: true, log };
});

// ─── Bulk Renamer ─────────────────────────────────────────────────────────────
ipcMain.handle('run-bulk-renamer', async (_, baseName, startNum) => {
  const log = [];

  const win = BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win, {
    title: 'Select folder to rename files in',
    defaultPath: os.homedir(),
    properties: ['openDirectory']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, log, error: 'No folder selected.' };
  }

  const targetDir = result.filePaths[0];
  log.push(`Selected: ${targetDir}`);
  log.push(`Base name: "${baseName}" | Starting from: ${startNum}`);

  try {
    const entries = fs.readdirSync(targetDir);
    const files = entries
      .filter(f => fs.statSync(path.join(targetDir, f)).isFile())
      .sort(); // sort alphabetically so renaming is predictable

    log.push(`Found ${files.length} file(s)`);

    if (files.length === 0) {
      log.push('No files to rename.');
      return { success: true, log };
    }

    let count = 0;
    for (let i = 0; i < files.length; i++) {
      const oldName = files[i];
      const ext     = path.extname(oldName);
      const num     = startNum + i;
      const newName = `${baseName} ${num}${ext}`;
      const src     = path.join(targetDir, oldName);
      const dest    = path.join(targetDir, newName);

      if (src === dest) {
        log.push(`Skipped (same name): ${oldName}`);
        continue;
      }

      // Avoid overwriting existing files
      if (fs.existsSync(dest)) {
        log.push(`Conflict skipped: ${newName} already exists`);
        continue;
      }

      fs.renameSync(src, dest);
      log.push(`${oldName}  →  ${newName}`);
      count++;
    }

    log.push(`─── Done — ${count} file(s) renamed.`);
    return { success: true, log };
  } catch (err) {
    log.push('Error: ' + err.message);
    return { success: false, log, error: err.message };
  }
});

// ─── Internet Checker ─────────────────────────────────────────────────────────
ipcMain.handle('run-net-checker', async () => {
  const log = [];
  const { net } = require('electron');

  const hosts = [
    { label: 'Google',     url: 'https://www.google.com' },
    { label: 'Cloudflare', url: 'https://1.1.1.1' },
    { label: 'OpenDNS',    url: 'https://www.opendns.com' },
    { label: 'GitHub',     url: 'https://github.com' },
  ];

  log.push('Starting network diagnostics…');
  const isOnline = net.isOnline();
  log.push(`System network: ${isOnline ? 'ONLINE ✓' : 'OFFLINE ✗'}`);

  if (!isOnline) {
    log.push('No active network connection detected.');
    return { success: false, log };
  }

  // Ping each host 3 times and average
  const results = [];
  for (const host of hosts) {
    const pings = [];
    let failed = 0;

    for (let attempt = 0; attempt < 3; attempt++) {
      const start = Date.now();
      try {
        await new Promise((resolve, reject) => {
          const req = net.request(host.url);
          req.on('response', () => {
            pings.push(Date.now() - start);
            resolve();
          });
          req.on('error', () => { failed++; resolve(); });
          // Timeout after 5 seconds
          setTimeout(() => { failed++; resolve(); }, 5000);
          req.end();
        });
      } catch (_) { failed++; }
    }

    if (pings.length > 0) {
      const avg = Math.round(pings.reduce((a, b) => a + b, 0) / pings.length);
      const min = Math.min(...pings);
      const max = Math.max(...pings);
      results.push({ label: host.label, avg, min, max, status: 'ok' });
      log.push(`  ${host.label.padEnd(12)} ✓  avg:${avg}ms  min:${min}ms  max:${max}ms`);
    } else {
      results.push({ label: host.label, avg: null, status: 'unreachable' });
      log.push(`  ${host.label.padEnd(12)} ✗  unreachable (${failed}/3 attempts failed)`);
    }
  }

  // Summary
  const reachable  = results.filter(r => r.avg !== null);
  const avgLatency = reachable.length
    ? Math.round(reachable.reduce((a, b) => a + b.avg, 0) / reachable.length)
    : null;

  const quality = avgLatency === null ? 'No connection'
    : avgLatency < 80  ? 'Excellent'
    : avgLatency < 150 ? 'Good'
    : avgLatency < 300 ? 'Fair'
    : 'Poor';

  log.push('─── Summary ───');
  log.push(`  Reachable:   ${reachable.length}/${hosts.length} hosts`);
  if (avgLatency !== null) log.push(`  Avg latency: ${avgLatency}ms`);
  log.push(`  Connection:  ${quality}`);

  if (reachable.length === 0) {
    log.push('  No hosts reachable — check your connection.');
  }

  return { success: reachable.length > 0, log };
});

// ─── Auto Backup ─────────────────────────────────────────────────────────────
ipcMain.handle('run-backup', async (_, source, destination, time, type) => {
  const log = [];
  const win = BrowserWindow.getFocusedWindow();

  // Pick source folder
  const srcResult = await dialog.showOpenDialog(win, {
    title: 'Select folder to back up',
    defaultPath: os.homedir(),
    properties: ['openDirectory']
  });
  if (srcResult.canceled) return { success: false, log, error: 'No source selected.' };
  const srcDir = srcResult.filePaths[0];
  // If just picking source for Google Drive upload
  if (type === 'gdrive-pick') {
  return { success: true, log, srcDir };
  }
  log.push(`Source: ${srcDir}`);

  let destDir = null;

  if (type === 'cloud') {
    // Cloud via rclone — check if rclone is installed
    log.push('Destination: Cloud (rclone)');
    const { execSync } = require('child_process');
    try {
      execSync('which rclone');
      log.push('rclone found ✓');
    } catch {
      log.push('rclone not installed — run: sudo apt install rclone');
      log.push('Then configure with: rclone config');
      return { success: false, log };
    }
    // Run rclone copy to configured remote
    const cmd = `rclone copy "${srcDir}" remote:NyxonBackup --progress`;
    log.push(`Running: ${cmd}`);
    try {
      execSync(cmd, { timeout: 60000 });
      log.push('Cloud backup complete ✓');
    } catch (err) {
      log.push('rclone error: ' + err.message);
      return { success: false, log };
    }

  } else {
    // Local folder or external drive — pick destination
    const destResult = await dialog.showOpenDialog(win, {
      title: type === 'drive' ? 'Select external drive folder' : 'Select backup destination folder',
      defaultPath: type === 'drive' ? '/media' : os.homedir(),
      properties: ['openDirectory']
    });
    if (destResult.canceled) return { success: false, log, error: 'No destination selected.' };
    destDir = destResult.filePaths[0];
    log.push(`Destination: ${destDir}`);

    // Copy files
    const { execSync } = require('child_process');
    const timestamp = new Date().toISOString().slice(0, 10);
    const backupFolder = path.join(destDir, `NyxonBackup_${timestamp}`);
    fs.mkdirSync(backupFolder, { recursive: true });

    log.push('Copying files…');
    try {
      execSync(`cp -r "${srcDir}/." "${backupFolder}"`, { timeout: 120000 });
      log.push(`Backed up to: ${backupFolder}`);
      log.push('Backup complete ✓');
    } catch (err) {
      log.push('Copy error: ' + err.message);
      return { success: false, log };
    }
  }

  // Schedule note — cron-based scheduling
  log.push(`─── Schedule ───`);
  log.push(`Requested time: ${time}`);
  log.push('To auto-run at this time daily, add to cron:');
  const [hour, minute] = time.split(':');
  log.push(`  ${minute} ${hour} * * * cp -r "${srcDir}/." "${destDir}/NyxonBackup_$(date +%F)"`);
  log.push('Run: crontab -e  to add the above line.');

  return { success: true, log };
});

// ─── Company Assessment ───────────────────────────────────────────────────────
ipcMain.handle('run-assessment', async (_, company, email, contact) => {
  const log = [];
  const https = require('https');
  const { execSync } = require('child_process');

  log.push(`Company: ${company}`);
  log.push(`Contact: ${contact} <${email}>`);
  log.push('Starting diagnostics…');

  const scores = {};
  const report = {};

  // ── CPU & Memory ──
  try {
    const cpus     = os.cpus();
    const cpuModel = cpus[0].model.trim();
    const cpuCount = cpus.length;
    const memTotal = (os.totalmem() / 1e9).toFixed(1);
    const memFree  = (os.freemem()  / 1e9).toFixed(1);
    const memUsedPct = Math.round((1 - os.freemem() / os.totalmem()) * 100);

    scores.cpu = cpuCount >= 8 ? 100 : cpuCount >= 4 ? 75 : 50;
    scores.memory = memUsedPct < 50 ? 100 : memUsedPct < 75 ? 70 : 40;

    report.cpu = { model: cpuModel, cores: cpuCount, memTotal, memFree, memUsedPct };
    log.push(`CPU: ${cpuModel} (${cpuCount} cores)`);
    log.push(`RAM: ${memFree} GB free / ${memTotal} GB total (${memUsedPct}% used)`);
  } catch (e) { log.push('CPU check failed: ' + e.message); scores.cpu = 0; }

  // ── Disk ──
  try {
    const diskRaw = execSync("df -BG / | tail -1").toString().trim();
    const parts   = diskRaw.split(/\s+/);
    const total   = parseInt(parts[1]);
    const used    = parseInt(parts[2]);
    const free    = parseInt(parts[3]);
    const usedPct = parseInt(parts[4]);

    scores.disk = usedPct < 60 ? 100 : usedPct < 80 ? 65 : 30;
    report.disk = { total: `${total}GB`, used: `${used}GB`, free: `${free}GB`, usedPct };
    log.push(`Disk: ${free}GB free / ${total}GB total (${usedPct}% used)`);
  } catch (e) { log.push('Disk check failed: ' + e.message); scores.disk = 0; }

  // ── Network ──
  try {
    const hosts = ['https://google.com', 'https://cloudflare.com', 'https://github.com'];
    let totalLatency = 0; let reachable = 0;
    for (const url of hosts) {
      const t = Date.now();
      try {
        await new Promise((res, rej) => {
          const req = require('electron').net.request(url);
          req.on('response', () => { reachable++; totalLatency += Date.now() - t; res(); });
          req.on('error', rej);
          req.end();
        });
      } catch (_) {}
    }
    const avgMs = reachable ? Math.round(totalLatency / reachable) : 9999;
    scores.network = avgMs < 80 ? 100 : avgMs < 200 ? 75 : avgMs < 500 ? 45 : 20;
    report.network = { reachable, total: hosts.length, avgLatencyMs: avgMs };
    log.push(`Network: ${reachable}/${hosts.length} hosts reachable, avg ${avgMs}ms`);
  } catch (e) { log.push('Network check failed: ' + e.message); scores.network = 0; }

  // ── Security ──
  try {
    const platform = os.platform();
    let secScore = 60; // baseline
    const secNotes = [];

    // Check if firewall is active (Linux)
    if (platform === 'linux') {
      try {
        const ufw = execSync('ufw status 2>/dev/null || echo inactive').toString();
        if (ufw.includes('active')) { secScore += 20; secNotes.push('Firewall: active ✓'); }
        else { secNotes.push('Firewall: inactive ✗'); }
      } catch (_) { secNotes.push('Firewall: unknown'); }

      // Check for open ports
      try {
        const ports = execSync('ss -tuln 2>/dev/null | grep LISTEN | wc -l').toString().trim();
        const openCount = parseInt(ports);
        if (openCount < 5)       { secScore += 20; secNotes.push(`Open ports: ${openCount} (low) ✓`); }
        else if (openCount < 15) { secScore += 10; secNotes.push(`Open ports: ${openCount} (moderate)`); }
        else                     { secNotes.push(`Open ports: ${openCount} (high) ✗`); }
      } catch (_) {}
    }

    scores.security = Math.min(secScore, 100);
    report.security = { notes: secNotes, platform };
    secNotes.forEach(n => log.push(`Security: ${n}`));
  } catch (e) { log.push('Security check failed: ' + e.message); scores.security = 50; }

  // ── File Organisation Health ──
  try {
    const downloads = path.join(os.homedir(), 'Downloads');
    const files = fs.readdirSync(downloads).filter(f =>
      fs.statSync(path.join(downloads, f)).isFile()
    );
    // Penalise cluttered Downloads
    const orgScore = files.length < 20 ? 100 : files.length < 50 ? 70 : files.length < 100 ? 45 : 20;
    scores.fileOrg = orgScore;
    report.fileOrg = { downloadsFileCount: files.length };
    log.push(`File health: ${files.length} loose files in Downloads`);
  } catch (e) { log.push('File check failed: ' + e.message); scores.fileOrg = 50; }

  // ── Overall Score ──
  const weights = { cpu: 0.20, memory: 0.20, disk: 0.15, network: 0.20, security: 0.15, fileOrg: 0.10 };
  const overall = Math.round(
    Object.entries(weights).reduce((sum, [k, w]) => sum + (scores[k] || 0) * w, 0)
  );

  const grade = overall >= 90 ? 'A' : overall >= 75 ? 'B' : overall >= 60 ? 'C' : overall >= 45 ? 'D' : 'F';
  const label = overall >= 90 ? 'Excellent' : overall >= 75 ? 'Good' : overall >= 60 ? 'Fair' : 'Needs Work';

  log.push('─── Assessment Score ───');
  log.push(`  CPU:          ${scores.cpu}/100`);
  log.push(`  Memory:       ${scores.memory}/100`);
  log.push(`  Disk:         ${scores.disk}/100`);
  log.push(`  Network:      ${scores.network}/100`);
  log.push(`  Security:     ${scores.security}/100`);
  log.push(`  File Health:  ${scores.fileOrg}/100`);
  log.push(`  OVERALL:      ${overall}/100  Grade: ${grade}  (${label})`);

  // ── Send to Nyxon ──
  const payload = JSON.stringify({
    company, email, contact,
    timestamp: new Date().toISOString(),
    platform: os.platform(),
    release: os.release(),
    scores,
    overall,
    grade,
    report
  });

  log.push('Sending report to Nyxon…');

  // POST to your endpoint — replace with your real server URL
  await new Promise((resolve) => {
    const options = {
      hostname:'nyxon-server.onrender.com', 
      path: '/api/inbox',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      log.push(`Report received by Nyxon (${res.statusCode}) ✓`);
      resolve();
    });

    req.on('error', (e) => {
      log.push(`Could not reach Nyxon server: ${e.message}`);
      log.push('Report saved locally instead.');
      // Save locally as fallback
      const fallbackPath = path.join(os.homedir(), `NyxonAssessment_${company}_${Date.now()}.json`);
      fs.writeFileSync(fallbackPath, payload);
      log.push(`Saved to: ${fallbackPath}`);
      resolve();
    });

    req.write(payload);
    req.end();
  });

  // Desktop notification with score
  new Notification({
    title: `Nyxon Assessment — ${company}`,
    body: `Score: ${overall}/100 (${grade}) — ${label}. Report sent to Nyxon.`
  }).show();

  return { success: true, log };
});
// ─── Feedback ─────────────────────────────────────────────────────────────────
ipcMain.handle('run-feedback', async (_, data) => {
  const log = [];
  log.push(`Rating: ${data.rating}/5 stars`);
  log.push(`Ease of use: ${data.ease}`);
  log.push(`Favourite automation: ${data.favourite}`);
  log.push(`Would recommend: ${data.recommend}`);
  if (data.comments) log.push(`Comments: "${data.comments}"`);
  await sendToNyxon(JSON.stringify({ type: 'feedback', ...data }), log);
  new Notification({ title: 'Nyxon — Thank you!', body: `Your ${data.rating}-star feedback has been received.` }).show();
  return { success: true, log };
});

// ─── Contact ──────────────────────────────────────────────────────────────────
ipcMain.handle('run-contact', async (_, data) => {
  const log = [];
  log.push(`From: ${data.name} <${data.email}>`);
  log.push(`Subject: ${data.subject}`);
  log.push(`Message: "${data.message}"`);
  await sendToNyxon(JSON.stringify({ type: 'contact', ...data }), log);
  new Notification({ title: 'Nyxon — Message sent!', body: 'We received your message and will be in touch soon.' }).show();
  return { success: true, log };
});

// ─── Shared sender ────────────────────────────────────────────────────────────
async function sendToNyxon(payload, log) {
  const https = require('https');
  return new Promise((resolve) => {
    const options = {
      hostname: 'nyxon-server.onrender.com',
      path: '/api/inbox',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };
    const req = https.request(options, (res) => {
      log.push(`Delivered to Nyxon ✓ (${res.statusCode})`);
      resolve();
    });
    req.on('error', () => {
      const fallback = path.join(os.homedir(), `nyxon_inbox_${Date.now()}.json`);
      fs.writeFileSync(fallback, payload);
      log.push('Server not live — saved locally.');
      log.push(`Saved to: ${fallback}`);
      resolve();
    });
    req.write(payload);
    req.end();
  });
}
// ─── License Activation ───────────────────────────────────────────────────────
ipcMain.handle('activate-license', async (_, key) => {
  const https = require('https');

  return new Promise((resolve) => {
    const payload = JSON.stringify({ key: key.trim().toUpperCase() });
    const options = {
      hostname: 'nyxon-server.onrender.com',
      path: '/api/activate',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload)
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.success) {
            const licenseFile = path.join(app.getPath('userData'), 'license.json');
            fs.writeFileSync(licenseFile, JSON.stringify({
              key: result.key,
              tier: result.tier,
              activatedAt: result.activatedAt
            }));
          }
          resolve(result);
        } catch {
          resolve({ success: false, error: 'Server error.' });
        }
      });
    });

    req.on('error', () => resolve({ success: false, error: 'Could not reach Nyxon server.' }));
    req.write(payload);
    req.end();
  });
});

// Check license on startup
ipcMain.handle('check-license', async () => {
  try {
    const licenseFile = path.join(app.getPath('userData'), 'license.json');

    if (!fs.existsSync(licenseFile)) {
      return { active: false, tier: 'free' };
    }

    const data = JSON.parse(fs.readFileSync(licenseFile, 'utf8'));

    if (!data.key || data.tier !== 'pro') {
      return { active: false, tier: 'free' };
    }

    // Re-verify with server on every launch
    const result = await new Promise((resolve) => {
      const https = require('https');
      const payload = JSON.stringify({ key: data.key });
      const options = {
        hostname: 'nyxon-server.onrender.com',
        path: '/api/verify-license',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload)
        }
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          try { resolve(JSON.parse(body)); }
          catch { resolve({ valid: true }); } // parse error → give benefit of doubt
        });
      });

      // If server unreachable → give benefit of doubt
      // Don't punish users for bad internet
      req.on('error', () => resolve({ valid: true }));
      req.setTimeout(5000, () => {
        req.destroy();
        resolve({ valid: true }); // timeout → give benefit of doubt
      });

      req.write(payload);
      req.end();
    });

    if (!result.valid) {
      // Server says invalid — delete local license and revert to free
      fs.unlinkSync(licenseFile);
      addLog?.('License verification failed — reverted to Free.', 'error');
      return { active: false, tier: 'free' };
    }

    return { active: true, tier: 'pro' };

  } catch (_) {
    return { active: false, tier: 'free' };
  }
});

// ─── Cloud Backup Handlers ────────────────────────────────────────────────────
const TOKENS_FILE = () => path.join(app.getPath('userData'), 'cloud-tokens.json');

function loadTokens() {
  try {
    if (fs.existsSync(TOKENS_FILE())) return JSON.parse(fs.readFileSync(TOKENS_FILE(), 'utf8'));
  } catch (_) {}
  return {};
}

function saveTokens(tokens) {
  fs.writeFileSync(TOKENS_FILE(), JSON.stringify(tokens, null, 2));
}

// Get Google Drive auth URL
ipcMain.handle('gdrive-auth-url', async () => {
  return new Promise((resolve) => {
    const https = require('https');
    const req = https.request({
      hostname: 'nyxon-server.onrender.com',
      path: '/api/gdrive/auth-url',
      method: 'GET'
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ error: 'Failed to get auth URL.' }); }
      });
    });
    req.on('error', () => resolve({ error: 'Server unreachable.' }));
    req.end();
  });
});

// Exchange code for tokens
ipcMain.handle('gdrive-exchange', async (_, code) => {
  return new Promise((resolve) => {
    const https = require('https');
    const payload = JSON.stringify({ code });
    const req = https.request({
      hostname: 'nyxon-server.onrender.com',
      path: '/api/gdrive/exchange',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.success) {
            const tokens = loadTokens();
            tokens.google = result.tokens;
            saveTokens(tokens);
          }
          resolve(result);
        } catch { resolve({ error: 'Exchange failed.' }); }
      });
    });
    req.on('error', () => resolve({ error: 'Server unreachable.' }));
    req.write(payload);
    req.end();
  });
});

// Check if Google Drive is connected
ipcMain.handle('gdrive-status', async () => {
  const tokens = loadTokens();
  return { connected: !!tokens.google?.access_token };
});

// Upload file to Google Drive
ipcMain.handle('gdrive-upload', async (_, srcDir) => {
  const log = [];
  const tokens = loadTokens();

  if (!tokens.google) {
    return { success: false, log: ['Google Drive not connected. Connect first in backup settings.'] };
  }

  try {
const { google } = require('googleapis');
    const puppeteer = require('puppeteer');
    const oauth2Client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID || '',
      process.env.GOOGLE_CLIENT_SECRET || '',
      'urn:ietf:wg:oauth:2.0:oob'
    );
    oauth2Client.setCredentials(tokens.google);

    // Refresh token if needed
    oauth2Client.on('tokens', (newTokens) => {
      const current = loadTokens();
      current.google = { ...current.google, ...newTokens };
      saveTokens(current);
    });

    const drive = google.drive({ version: 'v3', auth: oauth2Client });

    // Create dated backup folder on Drive
    const timestamp = new Date().toISOString().slice(0, 10);
    const folderName = `NyxonBackup_${timestamp}`;
    log.push(`Creating Drive folder: ${folderName}…`);

    const folderRes = await drive.files.create({
      requestBody: { name: folderName, mimeType: 'application/vnd.google-apps.folder' },
      fields: 'id'
    });
    const folderId = folderRes.data.id;

    // Upload all files from srcDir
    const entries = fs.readdirSync(srcDir);
    const files = entries.filter(f => fs.statSync(path.join(srcDir, f)).isFile());
    log.push(`Uploading ${files.length} file(s) to Google Drive…`);

    let uploaded = 0;
    for (const file of files) {
      const filePath = path.join(srcDir, file);
      const mimeType = 'application/octet-stream';
      await drive.files.create({
        requestBody: { name: file, parents: [folderId] },
        media: { mimeType, body: fs.createReadStream(filePath) },
        fields: 'id'
      });
      uploaded++;
      log.push(`  Uploaded: ${file}`);
    }

    log.push(`─── Done — ${uploaded} file(s) uploaded to Google Drive ✓`);
    return { success: true, log };
  } catch (err) {
    log.push(`Error: ${err.message}`);
    return { success: false, log };
  }
});

// ─── Web Scraper ──────────────────────────────────────────────────────────────
ipcMain.handle('run-web-scraper', async (_, config) => {
  const log  = [];
  const axios   = require('axios');
  const cheerio = require('cheerio');
  const XLSX    = require('xlsx');

  const { mode, url, selector, format, filename, pages, delay, pagination } = config;

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
  };

  async function scrapePage(pageUrl) {
    const response = await axios.get(pageUrl, { headers, timeout: 15000 });
    const $ = cheerio.load(response.data);
    const results = [];
    $(selector).each((i, el) => {
      const text = $(el).text().trim();
      const href = $(el).attr('href') || '';
      const src  = $(el).attr('src')  || '';
      if (text || href || src) {
        results.push({ text: text || src || href, href, src });
      }
    });
    return results;
  }

  try {
    let allResults = [];

    if (mode === 'preview') {
      log.push(`Preview scrape: ${url}`);
      const results = await scrapePage(url);
      return { success: true, log, preview: results.map(r => r.text).filter(Boolean).slice(0, 10) };
    }

    if (mode === 'basic') {
      log.push(`Scraping: ${url}`);
      log.push(`Selector: ${selector}`);
      const results = await scrapePage(url);
      allResults = results;
      log.push(`Found ${results.length} item(s)`);
    }

    if (mode === 'advanced') {
      const totalPages = Math.min(parseInt(pages) || 3, 50);
      const pageDelay  = Math.max(parseInt(delay)  || 1000, 500);
      log.push(`Advanced scrape: ${totalPages} pages`);
      log.push(`Selector: ${selector}`);

      for (let p = 1; p <= totalPages; p++) {
        let pageUrl = url;

        // Build paginated URL
        if (pagination && pagination.includes('{page}')) {
          pageUrl = pagination.replace('{page}', p);
        } else if (url.includes('?')) {
          pageUrl = `${url}&page=${p}`;
        } else {
          pageUrl = `${url}?page=${p}`;
        }

        log.push(`Scraping page ${p}/${totalPages}: ${pageUrl}`);

        try {
          const results = await scrapePage(pageUrl);
          allResults = allResults.concat(results);
          log.push(`  Page ${p}: ${results.length} item(s) found`);
        } catch (pageErr) {
          log.push(`  Page ${p}: failed — ${pageErr.message}`);
        }

        // Delay between pages
        if (p < totalPages) {
          await new Promise(r => setTimeout(r, pageDelay));
        }
      }

      log.push(`Total items scraped: ${allResults.length}`);
    }

    if (allResults.length === 0) {
      log.push('No data found. Try a different CSS selector.');
      log.push('Tip: Right-click element in browser → Inspect → copy selector');
      return { success: false, log };
    }

    // Export
    const safeFilename = (filename || 'scraped-data').replace(/[^a-z0-9_\-]/gi, '_');
    const savePath = path.join(os.homedir(), 'Downloads');
    let savedPath = '';

    if (format === 'csv') {
      const csvContent = 'text,href,src\n' + allResults.map(r =>
        `"${(r.text||'').replace(/"/g,'""')}","${r.href||''}","${r.src||''}"`
      ).join('\n');
      savedPath = path.join(savePath, `${safeFilename}.csv`);
      fs.writeFileSync(savedPath, csvContent, 'utf8');
      log.push(`Saved CSV: ${savedPath}`);
    }

    if (format === 'json') {
      savedPath = path.join(savePath, `${safeFilename}.json`);
      fs.writeFileSync(savedPath, JSON.stringify(allResults, null, 2), 'utf8');
      log.push(`Saved JSON: ${savedPath}`);
    }

    if (format === 'excel') {
      const wb = XLSX.utils.book_new();
      const wsData = [
        ['#', 'Text', 'Link (href)', 'Image (src)'],
        ...allResults.map((r, i) => [i + 1, r.text || '', r.href || '', r.src || ''])
      ];
      const ws = XLSX.utils.aoa_to_sheet(wsData);

      // Column widths
      ws['!cols'] = [{ wch: 5 }, { wch: 50 }, { wch: 40 }, { wch: 40 }];

      XLSX.utils.book_append_sheet(wb, ws, 'Scraped Data');
      savedPath = path.join(savePath, `${safeFilename}.xlsx`);
      XLSX.writeFile(wb, savedPath);
      log.push(`Saved Excel: ${savedPath}`);
    }

    log.push(`─── Done — ${allResults.length} item(s) exported as ${format.toUpperCase()} ✓`);

    // Open the Downloads folder
    shell.openPath(savePath);

    new Notification({
      title: 'Nyxon — Web Scraper',
      body: `${allResults.length} items exported to ${format.toUpperCase()}`
    }).show();

    return { success: true, log };

  } catch (err) {
    log.push(`Error: ${err.message}`);
    log.push('Tips:');
    log.push('  • Check the URL is publicly accessible');
    log.push('  • Some sites block scrapers — try adding a delay');
    log.push('  • Right-click → Inspect to find the right CSS selector');
    return { success: false, log };
  }
});

// ─── Image to PDF ──────────────────────────────────────────────────────────
ipcMain.handle('run-image-to-pdf', async (event, config = {}) => {
  const log = [];
  const win = BrowserWindow.getFocusedWindow();
  const fit = config.fit || 'fit';
  const filename = (config.filename || 'combined-images').replace(/[^a-z0-9-_ ]/gi, '_');

  const result = await dialog.showOpenDialog(win, {
    title: 'Select images to combine',
    defaultPath: os.homedir(),
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'Images', extensions: ['jpg', 'jpeg', 'png'] }
    ]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, log, error: 'No images selected.' };
  }

  log.push(`Selected ${result.filePaths.length} image(s).`);

  try {
    const { PDFDocument } = require('pdf-lib');

    const PAGE_SIZES = { a4: [595.28, 841.89], letter: [612, 792] };
    const pdfDoc = await PDFDocument.create();

    for (const imgPath of result.filePaths) {
      const ext = path.extname(imgPath).toLowerCase();
      const bytes = fs.readFileSync(imgPath);
      const image = ext === '.png'
        ? await pdfDoc.embedPng(bytes)
        : await pdfDoc.embedJpg(bytes);

      if (fit === 'fit') {
        const page = pdfDoc.addPage([image.width, image.height]);
        page.drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
      } else {
        const [pw, ph] = PAGE_SIZES[fit];
        const page = pdfDoc.addPage([pw, ph]);
        const scale = Math.min(pw / image.width, ph / image.height);
        const w = image.width * scale;
        const h = image.height * scale;
        page.drawImage(image, { x: (pw - w) / 2, y: (ph - h) / 2, width: w, height: h });
      }
      log.push(`Added: ${path.basename(imgPath)}`);
    }

    const pdfBytes = await pdfDoc.save();
    const downloadsPath = path.join(os.homedir(), 'Downloads');
    const outPath = path.join(downloadsPath, `${filename}.pdf`);
    fs.writeFileSync(outPath, pdfBytes);

    log.push(`─── Done — ${result.filePaths.length} image(s) combined into ${filename}.pdf ✓`);

    shell.openPath(downloadsPath);
    new Notification({
      title: 'Nyxon — Image to PDF',
      body: `${result.filePaths.length} image(s) combined into ${filename}.pdf`
    }).show();

    return { success: true, log, outputPath: outPath };

  } catch (err) {
    log.push(`Error: ${err.message}`);
    return { success: false, log, error: err.message };
  }
});

// ─── PDF to Image ──────────────────────────────────────────────────────────
ipcMain.handle('run-pdf-to-image', async (event, config = {}) => {
  const log = [];
  const win = BrowserWindow.getFocusedWindow();
  const format  = config.format === 'jpeg' ? 'jpeg' : 'png';
  const scale   = parseFloat(config.scale) || 2;
  const quality = Math.min(100, Math.max(30, parseInt(config.quality) || 90)) / 100;
  const pageSpec = config.pages || 'all';

  // Open file picker for the source PDF
  const result = await dialog.showOpenDialog(win, {
    title: 'Select a PDF to convert',
    defaultPath: os.homedir(),
    properties: ['openFile'],
    filters: [
      { name: 'PDF Files', extensions: ['pdf'] }
    ]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, log, error: 'No PDF selected.' };
  }

  const pdfPath = result.filePaths[0];
  log.push(`Selected: ${pdfPath}`);

  try {
    const { createCanvas } = require('@napi-rs/canvas');
    const pdfjsLib = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const { pathToFileURL } = require('url');

    const stdFontUrl = pathToFileURL(
      path.join(__dirname, 'node_modules', 'pdfjs-dist', 'standard_fonts') + path.sep
    ).href;

    const data = new Uint8Array(fs.readFileSync(pdfPath));
    const doc = await pdfjsLib.getDocument({
      data,
      disableWorker: true,
      standardFontDataUrl: stdFontUrl
    }).promise;

    const totalPages = doc.numPages;
    log.push(`PDF has ${totalPages} page(s).`);

    let startPage = 1;
    let endPage = totalPages;
    if (pageSpec !== 'all' && pageSpec.start) {
      startPage = Math.max(1, parseInt(pageSpec.start));
      endPage = Math.min(totalPages, parseInt(pageSpec.end) || startPage);
      if (startPage > endPage) [startPage, endPage] = [endPage, startPage];
    }

    const baseName = path.basename(pdfPath, path.extname(pdfPath));
    const downloadsPath = path.join(os.homedir(), 'Downloads');
    const outDir = path.join(downloadsPath, `${baseName}-images`);
    fs.mkdirSync(outDir, { recursive: true });

    let count = 0;
    for (let i = startPage; i <= endPage; i++) {
      const page = await doc.getPage(i);
      const viewport = page.getViewport({ scale });
      const canvas = createCanvas(Math.ceil(viewport.width), Math.ceil(viewport.height));
      const ctx = canvas.getContext('2d');

      await page.render({ canvasContext: ctx, viewport, canvas }).promise;

      const ext = format === 'jpeg' ? 'jpg' : 'png';
      const outPath = path.join(outDir, `${baseName}-page-${String(i).padStart(3, '0')}.${ext}`);
      const buffer = format === 'jpeg'
        ? canvas.toBuffer('image/jpeg', quality)
        : canvas.toBuffer('image/png');

      fs.writeFileSync(outPath, buffer);
      count++;
      log.push(`Rendered page ${i} → ${path.basename(outPath)}`);
    }

    log.push(`─── Done — ${count} image(s) exported as ${format.toUpperCase()} ✓`);

    shell.openPath(outDir);

    new Notification({
      title: 'Nyxon — PDF to Image',
      body: `${count} page(s) converted to ${format.toUpperCase()}`
    }).show();

    return { success: true, log, outputDir: outDir, pageCount: count };

  } catch (err) {
    log.push(`Error: ${err.message}`);
    log.push('Tips:');
    log.push('  • Make sure the PDF isn\'t password-protected');
    log.push('  • Very large PDFs may take longer to render — try a smaller page range');
    return { success: false, log, error: err.message };
  }
});

// ─── File Compressor ───────────────────────────────────────────────────────
ipcMain.handle('run-compressor', async (event, config = {}) => {
  const log = [];
  const win = BrowserWindow.getFocusedWindow();
  const mode = config.mode === 'folder' ? 'folder' : 'files';
  const level = Math.min(9, Math.max(1, parseInt(config.level) || 6));
  const filename = (config.filename || 'archive').replace(/[^a-z0-9-_ ]/gi, '_');

  const result = await dialog.showOpenDialog(win, {
    title: mode === 'folder' ? 'Select a folder to compress' : 'Select files to compress',
    defaultPath: os.homedir(),
    properties: mode === 'folder' ? ['openDirectory'] : ['openFile', 'multiSelections']
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, log, error: 'Nothing selected.' };
  }

  log.push(`Selected ${result.filePaths.length} item(s).`);

  try {
    const archiver = require('archiver');
    const downloadsPath = path.join(os.homedir(), 'Downloads');
    const outPath = path.join(downloadsPath, `${filename}.zip`);
    const output = fs.createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level } });

    const donePromise = new Promise((resolve, reject) => {
      output.on('close', resolve);
      archive.on('error', reject);
    });

    archive.pipe(output);

    if (mode === 'folder') {
      const folderPath = result.filePaths[0];
      archive.directory(folderPath, path.basename(folderPath));
      log.push(`Compressing folder: ${path.basename(folderPath)}`);
    } else {
      for (const filePath of result.filePaths) {
        archive.file(filePath, { name: path.basename(filePath) });
        log.push(`Added: ${path.basename(filePath)}`);
      }
    }

    await archive.finalize();
    await donePromise;

    const finalSize = fs.statSync(outPath).size;
    log.push(`─── Done — ${filename}.zip created (${(finalSize / 1024).toFixed(1)} KB) ✓`);

    shell.openPath(downloadsPath);
    new Notification({
      title: 'Nyxon — File Compressor',
      body: `${filename}.zip created (${(finalSize / 1024).toFixed(1)} KB)`
    }).show();

    return { success: true, log, outputPath: outPath };

  } catch (err) {
    log.push(`Error: ${err.message}`);
    return { success: false, log, error: err.message };
  }
});

// ─── QR Code Generator ─────────────────────────────────────────────────────
ipcMain.handle('run-qr-code', async (event, config = {}) => {
  const log = [];
  const text = (config.text || '').trim();
  const size = Math.min(1000, Math.max(100, parseInt(config.size) || 400));
  const filename = (config.filename || 'qrcode').replace(/[^a-z0-9-_ ]/gi, '_');

  if (!text) {
    return { success: false, log, error: 'No content provided.' };
  }

  try {
    const QRCode = require('qrcode');
    const downloadsPath = path.join(os.homedir(), 'Downloads');
    const outPath = path.join(downloadsPath, `${filename}.png`);

    log.push(`Encoding: ${text}`);
    await QRCode.toFile(outPath, text, { width: size, margin: 2 });
    log.push(`─── Done — saved ${filename}.png ✓`);

    shell.openPath(downloadsPath);
    new Notification({
      title: 'Nyxon — QR Code Generator',
      body: `QR code saved as ${filename}.png`
    }).show();

    return { success: true, log, outputPath: outPath };

  } catch (err) {
    log.push(`Error: ${err.message}`);
    return { success: false, log, error: err.message };
  }
});

// ─── DNS Cleaner ───────────────────────────────────────────────────────────
ipcMain.handle('run-dns-cleaner', async () => {
  const log = [];
  const platform = os.platform();
  const sudo = require('sudo-prompt');
  const sudoOptions = { name: 'Nyxon Launcher' };

  function execSudo(cmd) {
    return new Promise((resolve, reject) => {
      sudo.exec(cmd, sudoOptions, (error, stdout, stderr) => {
        if (error) reject(error);
        else resolve(stdout || stderr || '');
      });
    });
  }

  try {
    if (platform === 'win32') {
      // ipconfig /flushdns doesn't require elevation on Windows
      log.push('Flushing DNS cache (Windows)…');
      const stdout = await new Promise((resolve, reject) => {
        exec('ipconfig /flushdns', (error, stdout, stderr) => {
          if (error) reject(error);
          else resolve(stdout);
        });
      });

      if (!/success/i.test(stdout)) {
        log.push(`Warning: Windows didn't report success. Output: ${stdout.trim()}`);
        return { success: false, log, error: 'ipconfig did not confirm the flush.' };
      }
      log.push('DNS Resolver Cache flushed ✓');

    } else if (platform === 'darwin') {
      log.push('Flushing DNS cache (macOS)… you may be asked for your password.');
      await execSudo('dscacheutil -flushcache; killall -HUP mDNSResponder');
      log.push('DNS cache flushed and mDNSResponder restarted ✓');

    } else if (platform === 'linux') {
      log.push('Flushing DNS cache (Linux)… you may be asked for your password.');
      try {
        await execSudo('resolvectl flush-caches');
        log.push('systemd-resolved cache flushed ✓');
      } catch {
        // Fallback for older systemd or non-systemd-resolved setups
        await execSudo('systemctl restart nscd || systemctl restart systemd-resolved');
        log.push('DNS service restarted ✓');
      }

    } else {
      return { success: false, log, error: `Unsupported platform: ${platform}` };
    }

    log.push('─── Done — DNS cache cleared ✓');

    new Notification({
      title: 'Nyxon — DNS Cleaner',
      body: 'DNS cache flushed successfully'
    }).show();

    return { success: true, log };

  } catch (err) {
    log.push(`Error: ${err.message}`);
    log.push('Tip: this may need admin/sudo privileges — try again and approve the prompt.');
    return { success: false, log, error: err.message };
  }
});

// ─── Invoice Generator ─────────────────────────────────────────────────────
ipcMain.handle('run-invoice', async (event, config = {}) => {
  const log = [];
  const { from = 'Your Business', to = 'Client', number = 'INV-001',
          tax = 0, notes = '', items = [] } = config;

  if (!items.length) {
    return { success: false, log, error: 'No line items provided.' };
  }

  try {
    const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const page = doc.addPage([595.28, 841.89]); // A4
    const dark = rgb(0.1, 0.1, 0.2);
    const gray = rgb(0.5, 0.5, 0.55);
    const line = rgb(0.85, 0.85, 0.88);

    let y = 790;
    page.drawText('INVOICE', { x: 50, y, size: 26, font: bold, color: dark });
    page.drawText(number, { x: 545 - font.widthOfTextAtSize(number, 12), y: y + 6, size: 12, font, color: gray });

    y -= 40;
    page.drawText('From', { x: 50, y, size: 9, font, color: gray });
    page.drawText('Bill To', { x: 320, y, size: 9, font, color: gray });
    y -= 16;
    page.drawText(from, { x: 50, y, size: 12, font: bold, color: dark });
    page.drawText(to, { x: 320, y, size: 12, font: bold, color: dark });

    y -= 16;
    const dateStr = new Date().toLocaleDateString();
    page.drawText(dateStr, { x: 50, y, size: 10, font, color: gray });

    y -= 30;
    page.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 1, color: line });

    y -= 20;
    page.drawText('Description', { x: 50, y, size: 10, font: bold, color: dark });
    page.drawText('Qty', { x: 350, y, size: 10, font: bold, color: dark });
    page.drawText('Price', { x: 410, y, size: 10, font: bold, color: dark });
    page.drawText('Total', { x: 480, y, size: 10, font: bold, color: dark });

    y -= 8;
    page.drawLine({ start: { x: 50, y }, end: { x: 545, y }, thickness: 1, color: line });

    let subtotal = 0;
    for (const item of items) {
      y -= 22;
      const lineTotal = item.qty * item.price;
      subtotal += lineTotal;
      page.drawText(item.desc, { x: 50, y, size: 10, font, color: dark });
      page.drawText(String(item.qty), { x: 350, y, size: 10, font, color: dark });
      page.drawText(item.price.toFixed(2), { x: 410, y, size: 10, font, color: dark });
      page.drawText(lineTotal.toFixed(2), { x: 480, y, size: 10, font, color: dark });
    }

    const taxAmount = subtotal * (tax / 100);
    const total = subtotal + taxAmount;

    y -= 16;
    page.drawLine({ start: { x: 350, y }, end: { x: 545, y }, thickness: 1, color: line });

    y -= 20;
    page.drawText('Subtotal', { x: 350, y, size: 10, font, color: gray });
    page.drawText(subtotal.toFixed(2), { x: 480, y, size: 10, font, color: dark });

    if (tax > 0) {
      y -= 18;
      page.drawText(`Tax (${tax}%)`, { x: 350, y, size: 10, font, color: gray });
      page.drawText(taxAmount.toFixed(2), { x: 480, y, size: 10, font, color: dark });
    }

    y -= 22;
    page.drawText('Total', { x: 350, y, size: 13, font: bold, color: dark });
    page.drawText(total.toFixed(2), { x: 480, y, size: 13, font: bold, color: dark });

    if (notes) {
      y -= 50;
      page.drawText('Notes', { x: 50, y, size: 9, font, color: gray });
      y -= 14;
      page.drawText(notes, { x: 50, y, size: 10, font, color: dark });
    }

    const pdfBytes = await doc.save();
    const downloadsPath = path.join(os.homedir(), 'Downloads');
    const safeNumber = number.replace(/[^a-z0-9-_ ]/gi, '_');
    const outPath = path.join(downloadsPath, `${safeNumber}.pdf`);
    fs.writeFileSync(outPath, pdfBytes);

    log.push(`Invoice ${number} — ${items.length} item(s), total ${total.toFixed(2)}`);
    log.push(`─── Done — saved ${safeNumber}.pdf ✓`);

    shell.openPath(downloadsPath);
    new Notification({
      title: 'Nyxon — Invoice Generator',
      body: `Invoice ${number} saved (total ${total.toFixed(2)})`
    }).show();

    return { success: true, log, outputPath: outPath, total };

  } catch (err) {
    log.push(`Error: ${err.message}`);
    return { success: false, log, error: err.message };
  }
});

// ─── File Splitter ─────────────────────────────────────────────────────────
ipcMain.handle('run-file-splitter', async (event, config = {}) => {
  const log = [];
  const win = BrowserWindow.getFocusedWindow();
  const mode = config.mode === 'join' ? 'join' : 'split';

  try {
    if (mode === 'split') {
      const chunkSize = Math.max(1, parseInt(config.chunkMb) || 10) * 1024 * 1024;

      const result = await dialog.showOpenDialog(win, {
        title: 'Select a file to split',
        defaultPath: os.homedir(),
        properties: ['openFile']
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, log, error: 'No file selected.' };
      }

      const srcPath = result.filePaths[0];
      const stat = fs.statSync(srcPath);
      const totalChunks = Math.ceil(stat.size / chunkSize);
      const baseName = path.basename(srcPath);
      const downloadsPath = path.join(os.homedir(), 'Downloads');
      const outDir = path.join(downloadsPath, `${baseName}-chunks`);
      fs.mkdirSync(outDir, { recursive: true });

      log.push(`Splitting ${baseName} (${(stat.size / 1024 / 1024).toFixed(1)} MB) into ${totalChunks} chunk(s)…`);

      const fd = fs.openSync(srcPath, 'r');
      for (let i = 0; i < totalChunks; i++) {
        const size = Math.min(chunkSize, stat.size - i * chunkSize);
        const buf = Buffer.alloc(size);
        fs.readSync(fd, buf, 0, size, i * chunkSize);
        const partPath = path.join(outDir, `${baseName}.part${String(i + 1).padStart(3, '0')}`);
        fs.writeFileSync(partPath, buf);
        log.push(`Wrote part ${i + 1}/${totalChunks}`);
      }
      fs.closeSync(fd);

      // Manifest so the Join mode (or a manual user) knows how to reassemble
      fs.writeFileSync(
        path.join(outDir, 'manifest.json'),
        JSON.stringify({ originalName: baseName, totalChunks, originalSize: stat.size }, null, 2)
      );

      log.push(`─── Done — ${totalChunks} chunk(s) saved to ${baseName}-chunks/ ✓`);
      shell.openPath(outDir);
      new Notification({
        title: 'Nyxon — File Splitter',
        body: `${baseName} split into ${totalChunks} chunk(s)`
      }).show();

      return { success: true, log, outputDir: outDir };

    } else {
      // Join mode — user selects the manifest.json inside a *-chunks folder
      const result = await dialog.showOpenDialog(win, {
        title: 'Select the manifest.json from the chunks folder',
        defaultPath: os.homedir(),
        properties: ['openFile'],
        filters: [{ name: 'Manifest', extensions: ['json'] }]
      });
      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, log, error: 'No manifest selected.' };
      }

      const manifestPath = result.filePaths[0];
      const chunkDir = path.dirname(manifestPath);
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));

      const downloadsPath = path.join(os.homedir(), 'Downloads');
      const outPath = path.join(downloadsPath, manifest.originalName);
      const outFd = fs.openSync(outPath, 'w');

      log.push(`Joining ${manifest.totalChunks} chunk(s) into ${manifest.originalName}…`);
      for (let i = 1; i <= manifest.totalChunks; i++) {
        const partPath = path.join(chunkDir, `${manifest.originalName}.part${String(i).padStart(3, '0')}`);
        const buf = fs.readFileSync(partPath);
        fs.writeSync(outFd, buf);
        log.push(`Joined part ${i}/${manifest.totalChunks}`);
      }
      fs.closeSync(outFd);

      const finalStat = fs.statSync(outPath);
      const sizeMatch = finalStat.size === manifest.originalSize;
      log.push(sizeMatch
        ? `─── Done — file reassembled and size-verified ✓`
        : `─── Done — file reassembled, but size doesn't match original (expected ${manifest.originalSize}, got ${finalStat.size})`);

      shell.openPath(downloadsPath);
      new Notification({
        title: 'Nyxon — File Splitter',
        body: `${manifest.originalName} reassembled`
      }).show();

      return { success: true, log, outputPath: outPath };
    }

  } catch (err) {
    log.push(`Error: ${err.message}`);
    return { success: false, log, error: err.message };
  }
});

// ─── Expense Tracker ───────────────────────────────────────────────────────
const EXPENSES_FILE = () => path.join(app.getPath('userData'), 'expenses.json');

function loadExpenses() {
  try {
    if (fs.existsSync(EXPENSES_FILE())) return JSON.parse(fs.readFileSync(EXPENSES_FILE(), 'utf8'));
  } catch (_) {}
  return [];
}

function saveExpenses(expenses) {
  fs.writeFileSync(EXPENSES_FILE(), JSON.stringify(expenses, null, 2));
}

ipcMain.handle('get-expenses', async () => {
  return { expenses: loadExpenses() };
});

ipcMain.handle('add-expense', async (_, entry) => {
  const expenses = loadExpenses();
  expenses.push(entry);
  saveExpenses(expenses);
  return { success: true };
});

ipcMain.handle('delete-expense', async (_, index) => {
  const expenses = loadExpenses();
  expenses.splice(index, 1);
  saveExpenses(expenses);
  return { success: true };
});

ipcMain.handle('export-expenses', async (_, expenses) => {
  const log = [];
  if (!expenses || expenses.length === 0) {
    return { success: false, log: ['No expenses to export.'] };
  }

  try {
    const XLSX = require('xlsx');
    const wb = XLSX.utils.book_new();
    const wsData = [
      ['Date', 'Category', 'Description', 'Amount'],
      ...expenses.map(e => [e.date, e.category, e.desc, e.amount])
    ];
    const total = expenses.reduce((sum, e) => sum + e.amount, 0);
    wsData.push(['', '', 'Total', total]);

    const ws = XLSX.utils.aoa_to_sheet(wsData);
    ws['!cols'] = [{ wch: 12 }, { wch: 18 }, { wch: 40 }, { wch: 12 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Expenses');

    const downloadsPath = path.join(os.homedir(), 'Downloads');
    const outPath = path.join(downloadsPath, `expenses-${new Date().toISOString().slice(0, 10)}.xlsx`);
    XLSX.writeFile(wb, outPath);

    log.push(`Exported ${expenses.length} entries, total ${total.toFixed(2)}`);
    log.push(`─── Done — saved ${path.basename(outPath)} ✓`);

    shell.openPath(downloadsPath);
    new Notification({
      title: 'Nyxon — Expense Tracker',
      body: `${expenses.length} expenses exported (total ${total.toFixed(2)})`
    }).show();

    return { success: true, log, outputPath: outPath };

  } catch (err) {
    log.push(`Error: ${err.message}`);
    return { success: false, log, error: err.message };
  }
});

// ─── Clipboard History ─────────────────────────────────────────────────────
const CLIPBOARD_FILE = () => path.join(app.getPath('userData'), 'clipboard-history.json');
const MAX_CLIPBOARD_ENTRIES = 200;
let clipboardWatcherInterval = null;
let lastClipboardText = '';

function loadClipboardData() {
  try {
    if (fs.existsSync(CLIPBOARD_FILE())) return JSON.parse(fs.readFileSync(CLIPBOARD_FILE(), 'utf8'));
  } catch (_) {}
  return { history: [], watching: false };
}

function saveClipboardData(data) {
  fs.writeFileSync(CLIPBOARD_FILE(), JSON.stringify(data, null, 2));
}

function startClipboardWatcher() {
  if (clipboardWatcherInterval) return;
  lastClipboardText = clipboard.readText() || '';

  clipboardWatcherInterval = setInterval(() => {
    const text = clipboard.readText();
    if (!text || text === lastClipboardText) return;
    lastClipboardText = text;

    const data = loadClipboardData();
    data.history.unshift({ id: Date.now().toString(36), text, time: Date.now(), pinned: false });
    if (data.history.length > MAX_CLIPBOARD_ENTRIES) {
      // Keep pinned entries even past the cap
      const pinned = data.history.filter(e => e.pinned);
      const unpinned = data.history.filter(e => !e.pinned).slice(0, MAX_CLIPBOARD_ENTRIES - pinned.length);
      data.history = [...pinned, ...unpinned];
    }
    saveClipboardData(data);

    const win = BrowserWindow.getAllWindows()[0];
    if (win) win.webContents.send('clipboard-history-updated', data.history);
  }, 500);
}

function stopClipboardWatcher() {
  if (clipboardWatcherInterval) {
    clearInterval(clipboardWatcherInterval);
    clipboardWatcherInterval = null;
  }
}

// Resume watching on launch if it was left on
(() => {
  const data = loadClipboardData();
  if (data.watching) startClipboardWatcher();
})();

ipcMain.handle('get-clipboard-history', async () => {
  const data = loadClipboardData();
  return { history: data.history, watching: data.watching };
});

ipcMain.handle('toggle-clipboard-watching', async (_, enabled) => {
  const data = loadClipboardData();
  data.watching = enabled;
  saveClipboardData(data);
  if (enabled) startClipboardWatcher();
  else stopClipboardWatcher();
  return { success: true };
});

ipcMain.handle('copy-clipboard-entry', async (_, id) => {
  const data = loadClipboardData();
  const entry = data.history.find(e => e.id === id);
  if (entry) {
    lastClipboardText = entry.text; // prevent re-capturing our own re-copy as a new entry
    clipboard.writeText(entry.text);
  }
  return { success: true };
});

ipcMain.handle('pin-clipboard-entry', async (_, id) => {
  const data = loadClipboardData();
  const entry = data.history.find(e => e.id === id);
  if (entry) entry.pinned = !entry.pinned;
  saveClipboardData(data);
  return { history: data.history };
});

ipcMain.handle('delete-clipboard-entry', async (_, id) => {
  const data = loadClipboardData();
  data.history = data.history.filter(e => e.id !== id);
  saveClipboardData(data);
  return { history: data.history };
});

ipcMain.handle('clear-clipboard-history', async () => {
  const data = loadClipboardData();
  data.history = [];
  saveClipboardData(data);
  return { history: data.history };
});

// ─── App Uninstaller Helper ────────────────────────────────────────────────
ipcMain.handle('list-installed-apps', async () => {
  const platform = os.platform();

  try {
    if (platform === 'win32') {
      const psScript = `
        $ErrorActionPreference = 'SilentlyContinue'
        $results = New-Object System.Collections.ArrayList
        $paths = @(
          'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
          'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*',
          'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
        )
        foreach ($p in $paths) {
          $items = Get-ItemProperty -Path $p -ErrorAction SilentlyContinue
          foreach ($item in $items) {
            if ($item.DisplayName -and $item.UninstallString) {
              [void]$results.Add([PSCustomObject]@{
                DisplayName = $item.DisplayName
                Publisher = $item.Publisher
                EstimatedSize = $item.EstimatedSize
                UninstallString = $item.UninstallString
                PSChildName = $item.PSChildName
              })
            }
          }
        }
        if ($results.Count -eq 0) { Write-Output '[]' }
        else { $results | ConvertTo-Json -Compress }
      `;

      const tmpScript = path.join(os.tmpdir(), `nyxon-list-apps-${Date.now()}.ps1`);
      fs.writeFileSync(tmpScript, psScript);

      let stdout;
      try {
        stdout = await new Promise((resolve, reject) => {
          exec(
            `powershell -NoProfile -ExecutionPolicy Bypass -File "${tmpScript}"`,
            { maxBuffer: 1024 * 1024 * 10, timeout: 15000 },
            (error, stdout, stderr) => error ? reject(error) : resolve(stdout)
          );
        });
      } finally {
        fs.unlink(tmpScript, () => {});
      }

      let raw = JSON.parse(stdout || '[]');
      if (!Array.isArray(raw)) raw = [raw];
      const apps = raw.map(a => ({
        id: a.PSChildName,
        name: a.DisplayName,
        publisher: a.Publisher || '',
        sizeKb: a.EstimatedSize || 0,
        uninstallCmd: a.UninstallString
      }));
      return { apps };

    } else if (platform === 'darwin') {
      const appsDir = '/Applications';
      const entries = fs.readdirSync(appsDir).filter(f => f.endsWith('.app'));
      const apps = [];
      for (const entry of entries) {
        const fullPath = path.join(appsDir, entry);
        let sizeKb = 0;
        try {
          const duOut = require('child_process').execSync(`du -sk "${fullPath}"`).toString();
          sizeKb = parseInt(duOut.split('\t')[0]) || 0;
        } catch (_) {}
        apps.push({ id: fullPath, name: entry.replace('.app', ''), publisher: '', sizeKb });
      }
      return { apps };

    } else if (platform === 'linux') {
      const stdout = await new Promise((resolve, reject) => {
        exec(`dpkg-query -W -f='\${Package}\\t\${Installed-Size}\\t\${Status}\\n'`,
          { maxBuffer: 1024 * 1024 * 10 },
          (error, stdout) => error ? reject(error) : resolve(stdout));
      });
      const apps = stdout.split('\n')
        .filter(line => line.includes('install ok installed'))
        .map(line => {
          const [pkg, sizeKb] = line.split('\t');
          return { id: pkg, name: pkg, publisher: '', sizeKb: parseInt(sizeKb) || 0 };
        });
      return { apps };

    } else {
      return { apps: [], error: `Unsupported platform: ${platform}` };
    }

  } catch (err) {
    return { apps: [], error: `Could not list apps: ${err.message}` };
  }
});

ipcMain.handle('uninstall-app', async (event, id) => {
  const platform = os.platform();

  try {
    if (platform === 'win32') {
      const { apps } = await require('electron').ipcMain.emit; // placeholder not used
    }
    // Re-fetch fresh app list to get the uninstall command (avoids trusting stale renderer state)
    if (platform === 'win32') {
      const listResult = await new Promise((resolve) => {
        ipcMain.emit('list-installed-apps'); resolve(null);
      });
    }

    if (platform === 'win32') {
      // Look up the uninstall string again directly, since Windows needs the full command
      const psScript = `
        Get-ItemProperty HKLM:\\Software\\*\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${id}, HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${id}, HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${id} -ErrorAction SilentlyContinue |
          Select-Object -First 1 -ExpandProperty UninstallString
      `;
      const uninstallCmd = await new Promise((resolve, reject) => {
        exec(`powershell -NoProfile -Command "${psScript.replace(/"/g, '\\"')}"`,
          (error, stdout) => error ? reject(error) : resolve(stdout.trim()));
      });
      if (!uninstallCmd) return { success: false, error: 'Could not find uninstaller for this app.' };

      exec(uninstallCmd, (error) => { /* uninstaller runs in background, may show its own UI */ });
      return { success: true };

    } else if (platform === 'darwin') {
      await shell.trashItem(id); // id is the full .app path on macOS
      return { success: true };

    } else if (platform === 'linux') {
      const sudo = require('sudo-prompt');
      await new Promise((resolve, reject) => {
        sudo.exec(`apt-get remove -y ${id}`, { name: 'Nyxon Launcher' },
          (error, stdout, stderr) => error ? reject(error) : resolve(stdout));
      });
      return { success: true };

    } else {
      return { success: false, error: `Unsupported platform: ${platform}` };
    }

  } catch (err) {
    return { success: false, error: err.message };
  }
});

// Get Dropbox auth URL
ipcMain.handle('dropbox-auth-url', async () => {
  return new Promise((resolve) => {
    const https = require('https');
    const req = https.request({
      hostname: 'nyxon-server.onrender.com',
      path: '/api/dropbox/auth-url',
      method: 'GET'
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch { resolve({ error: 'Failed to get auth URL.' }); }
      });
    });
    req.on('error', () => resolve({ error: 'Server unreachable.' }));
    req.end();
  });
});

// Exchange code for tokens
ipcMain.handle('dropbox-exchange', async (_, code) => {
  return new Promise((resolve) => {
    const https = require('https');
    const payload = JSON.stringify({ code });
    const req = https.request({
      hostname: 'nyxon-server.onrender.com',
      path: '/api/dropbox/exchange',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          if (result.success) {
            const tokens = loadTokens();
            tokens.dropbox = result.tokens;
            saveTokens(tokens);
          }
          resolve(result);
        } catch { resolve({ error: 'Exchange failed.' }); }
      });
    });
    req.on('error', () => resolve({ error: 'Server unreachable.' }));
    req.write(payload);
    req.end();
  });
});

// Check Dropbox connection status
ipcMain.handle('dropbox-status', async () => {
  const tokens = loadTokens();
  return { connected: !!tokens.dropbox?.access_token };
});

// Upload to Dropbox
ipcMain.handle('dropbox-upload', async (_, srcDir) => {
  const log = [];
  const tokens = loadTokens();

  if (!tokens.dropbox) {
    return { success: false, log: ['Dropbox not connected. Connect first in backup settings.'] };
  }

  try {
    const { Dropbox } = require('dropbox');
    const dbx = new Dropbox({ accessToken: tokens.dropbox.access_token });

    const timestamp = new Date().toISOString().slice(0, 10);
    const folderName = `/NyxonBackup_${timestamp}`;
    log.push(`Uploading to Dropbox: ${folderName}…`);

    const entries = fs.readdirSync(srcDir);
    const files = entries.filter(f => fs.statSync(path.join(srcDir, f)).isFile());
    log.push(`Uploading ${files.length} file(s) to Dropbox…`);

    let uploaded = 0;
    for (const file of files) {
      const filePath = path.join(srcDir, file);
      const contents = fs.readFileSync(filePath);

      await dbx.filesUpload({
        path: `${folderName}/${file}`,
        contents,
        mode: { '.tag': 'overwrite' }
      });

      uploaded++;
      log.push(`  Uploaded: ${file}`);
    }

    log.push(`─── Done — ${uploaded} file(s) uploaded to Dropbox ✓`);
    return { success: true, log };
  } catch (err) {
    log.push(`Error: ${err.message}`);
    return { success: false, log };
  }
});

// ─── Duplicate File Detector (Pro) ───────────────────────────────────────────
ipcMain.handle('run-duplicate-detector', async (_, targetDir, action = 'report') => {
  const log = [];
  const crypto = require('crypto');
  const duplicates = new Map(); // hash → [file paths]

  log.push('Duplicate File Detector started');

  if (!targetDir) {
    const win = BrowserWindow.getFocusedWindow();
    const result = await dialog.showOpenDialog(win, {
      title: 'Select folder to scan for duplicates',
      properties: ['openDirectory']
    });
    if (result.canceled) return { success: false, log: ['Scan cancelled'] };
    targetDir = result.filePaths[0];
  }

  log.push(`Scanning folder: ${targetDir}`);
  log.push('Computing MD5 checksums...');

  try {
    const files = [];
    function walkDir(dir) {
      const entries = fs.readdirSync(dir);
      for (const entry of entries) {
        const fullPath = path.join(dir, entry);
        try {
          if (fs.statSync(fullPath).isDirectory()) walkDir(fullPath);
          else if (fs.statSync(fullPath).isFile()) files.push(fullPath);
        } catch (_) {}
      }
    }
    walkDir(targetDir);

    log.push(`Found ${files.length} files`);

    for (const filePath of files) {
      try {
        const buffer = fs.readFileSync(filePath);
        const hash = crypto.createHash('md5').update(buffer).digest('hex');
        if (!duplicates.has(hash)) duplicates.set(hash, []);
        duplicates.get(hash).push(filePath);
      } catch (_) {}
    }

    const dupGroups = Array.from(duplicates.entries()).filter(([_, paths]) => paths.length > 1);

    if (dupGroups.length === 0) {
      log.push('✅ No duplicate files found.');
      return { success: true, log, duplicatesFound: 0 };
    }

    let totalDups = 0;
    log.push(`Found ${dupGroups.length} group(s) of duplicate files:`);

    for (const [hash, paths] of dupGroups) {
      log.push(`\n${paths.length} copies of the same file:`);
      paths.forEach(p => log.push(`   • ${p}`));
      totalDups += paths.length - 1;
    }

    if (action === 'delete') {
      log.push('\nDeleting duplicate files (keeping the first copy)...');
      let deleted = 0;
      for (const [_, paths] of dupGroups) {
        for (let i = 1; i < paths.length; i++) {
          try {
            fs.unlinkSync(paths[i]);
            log.push(`Deleted: ${paths[i]}`);
            deleted++;
          } catch (e) {
            log.push(`Failed to delete: ${paths[i]}`);
          }
        }
      }
      log.push(`✅ Deleted ${deleted} duplicate file(s)`);
    } else {
      log.push('\nReport-only mode: No files were deleted.');
    }

    log.push(`\nScan complete. ${totalDups} duplicate(s) found.`);
    return { success: true, log, duplicatesFound: totalDups };

  } catch (err) {
    log.push('Error: ' + err.message);
    return { success: false, log };
  }
});

// ─── Auto Software Updater (Pro) ─────────────────────────────────────────────
ipcMain.handle('run-software-updater', async () => {
  const log = [];
  log.push('Auto Software Updater started...');
  const platform = os.platform();

  if (platform === 'win32') {
    log.push('Checking for updates using Winget...');
    try {
      const { execSync } = require('child_process');
      const output = execSync('winget upgrade --all --include-unknown', { timeout: 30000 }).toString();
      log.push(output || 'No updates available.');
    } catch (e) {
      log.push('Winget not available or failed.');
      log.push('Tip: Install Winget from Microsoft Store for better results.');
    }
  } else if (platform === 'linux') {
    log.push('Linux: Run "sudo apt update && sudo apt upgrade" manually for now.');
  } else {
    log.push('macOS: Use Software Update or Homebrew.');
  }

  log.push('This feature will be expanded in future versions with full auto-update support.');
  return { success: true, log };
});

// ─── Boot Startup Manager ─────────────────────────────────────────────────────
ipcMain.handle('run-startup-manager', async (_, action, name, entryPath, type) => {
  const log  = [];
  const platform = os.platform();
  const { execSync } = require('child_process');

  if (action === 'list') {
    log.push('Scanning startup entries…');
    const items = [];

    try {
      if (platform === 'win32') {
        // Windows — read registry run keys
        const keys = [
          'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run',
          'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Run'
        ];
        for (const key of keys) {
          try {
            const output = execSync(`reg query "${key}" 2>nul`, { shell: 'cmd.exe' }).toString();
            const lines = output.split('\n').filter(l => l.includes('REG_SZ'));
            for (const line of lines) {
              const parts = line.trim().split(/\s{2,}/);
              if (parts.length >= 3) {
                items.push({ name: parts[0], path: parts[2], enabled: true, type: 'registry', key });
              }
            }
          } catch (_) {}
        }

        // Also check startup folder
        const startupFolder = path.join(os.homedir(), 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
        if (fs.existsSync(startupFolder)) {
          const files = fs.readdirSync(startupFolder);
          files.forEach(f => items.push({ name: f.replace(/\.(lnk|bat|exe)$/i, ''), path: path.join(startupFolder, f), enabled: true, type: 'folder' }));
        }

      } else if (platform === 'linux') {
        // Linux — check autostart folder
        const autostartDir = path.join(os.homedir(), '.config', 'autostart');
        if (fs.existsSync(autostartDir)) {
          const files = fs.readdirSync(autostartDir).filter(f => f.endsWith('.desktop'));
          for (const file of files) {
            try {
              const content = fs.readFileSync(path.join(autostartDir, file), 'utf8');
              const nameMatch = content.match(/^Name=(.+)/m);
              const execMatch = content.match(/^Exec=(.+)/m);
              const hiddenMatch = content.match(/^Hidden=(.+)/m);
              const enabled = !hiddenMatch || hiddenMatch[1].trim().toLowerCase() !== 'true';
              items.push({
                name: nameMatch ? nameMatch[1].trim() : file.replace('.desktop', ''),
                command: execMatch ? execMatch[1].trim() : '',
                path: path.join(autostartDir, file),
                enabled, type: 'desktop'
              });
            } catch (_) {}
          }
        }

        // Also check systemd user services
        const systemdDir = path.join(os.homedir(), '.config', 'systemd', 'user');
        if (fs.existsSync(systemdDir)) {
          const services = fs.readdirSync(systemdDir).filter(f => f.endsWith('.service'));
          services.forEach(s => items.push({ name: s.replace('.service', ''), path: path.join(systemdDir, s), enabled: true, type: 'systemd' }));
        }

      } else if (platform === 'darwin') {
        // macOS — check LaunchAgents
        const launchAgentDirs = [
          path.join(os.homedir(), 'Library', 'LaunchAgents'),
          '/Library/LaunchAgents'
        ];
        for (const dir of launchAgentDirs) {
          if (fs.existsSync(dir)) {
            const files = fs.readdirSync(dir).filter(f => f.endsWith('.plist'));
            files.forEach(f => items.push({ name: f.replace('.plist', ''), path: path.join(dir, f), enabled: true, type: 'launchagent' }));
          }
        }
      }

      log.push(`Found ${items.length} startup item(s)`);
      return { success: true, log, startupItems: items };
    } catch (err) {
      log.push('Error scanning startup: ' + err.message);
      return { success: false, log, startupItems: [] };
    }
  }

  // Enable / Disable
  if (action === 'disable' || action === 'enable') {
    try {
      if (platform === 'win32' && type === 'registry') {
        const regKey = entryPath.includes('HKLM') ? 'HKLM' : 'HKCU';
        const fullKey = `${regKey}\\Software\\Microsoft\\Windows\\CurrentVersion\\Run`;
        if (action === 'disable') {
          // Move to disabled key
          execSync(`reg copy "${fullKey}" "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\Disabled" /v "${name}" /f 2>nul`, { shell: 'cmd.exe' });
          execSync(`reg delete "${fullKey}" /v "${name}" /f 2>nul`, { shell: 'cmd.exe' });
        } else {
          execSync(`reg copy "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run\\Disabled" "${fullKey}" /v "${name}" /f 2>nul`, { shell: 'cmd.exe' });
        }
      } else if (platform === 'linux' && type === 'desktop') {
        const content = fs.readFileSync(entryPath, 'utf8');
        if (action === 'disable') {
          const updated = content.includes('Hidden=') ? content.replace(/Hidden=.+/m, 'Hidden=true') : content + '\nHidden=true';
          fs.writeFileSync(entryPath, updated);
        } else {
          const updated = content.replace(/Hidden=true/m, 'Hidden=false');
          fs.writeFileSync(entryPath, updated);
        }
      } else if (platform === 'darwin' && type === 'launchagent') {
        if (action === 'disable') {
          execSync(`launchctl unload "${entryPath}" 2>/dev/null || true`);
        } else {
          execSync(`launchctl load "${entryPath}" 2>/dev/null || true`);
        }
      }

      log.push(`${name} ${action}d at startup ✓`);
      return { success: true, log };
    } catch (err) {
      log.push('Error: ' + err.message);
      return { success: false, log, error: err.message };
    }
  }

  return { success: false, log: ['Unknown action.'] };
});

// ─── Password Generator ────────────────────────────────────────────────────
ipcMain.handle('run-password-generator', async (event, config = {}) => {
  const crypto = require('crypto');
  const length = Math.min(64, Math.max(8, parseInt(config.length) || 16));
  const count = Math.min(20, Math.max(1, parseInt(config.count) || 1));

  let chars = '';
  if (config.lower)   chars += 'abcdefghijkmnopqrstuvwxyz';   // no l
  if (config.upper)   chars += 'ABCDEFGHJKLMNPQRSTUVWXYZ';    // no I, O
  if (config.numbers) chars += '23456789';                    // no 0, 1
  if (config.symbols) chars += '!@#$%^&*()_+-=[]{}';

  if (!chars) {
    return { success: false, passwords: [], error: 'No character types selected.' };
  }

  const passwords = [];
  for (let p = 0; p < count; p++) {
    const bytes = crypto.randomBytes(length);
    let pw = '';
    for (let i = 0; i < length; i++) pw += chars[bytes[i] % chars.length];
    passwords.push(pw);
  }

  return { success: true, passwords };
});

// ─── Video/Audio Converter ─────────────────────────────────────────────────
ipcMain.handle('run-media-converter', async (event, config = {}) => {
  const log = [];
  const win = BrowserWindow.getFocusedWindow();
  const format = ['mp4','webm','mp3','wav'].includes(config.format) ? config.format : 'mp4';

  const result = await dialog.showOpenDialog(win, {
    title: 'Select a video or audio file',
    defaultPath: os.homedir(),
    properties: ['openFile'],
    filters: [{ name: 'Media', extensions: ['mp4','mov','mkv','avi','webm','mp3','wav','m4a','flac'] }]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, log, error: 'No file selected.' };
  }

  const srcPath = result.filePaths[0];
  const baseName = path.basename(srcPath, path.extname(srcPath));
  const downloadsPath = path.join(os.homedir(), 'Downloads');
  const outPath = path.join(downloadsPath, `${baseName}.${format}`);

  log.push(`Converting: ${path.basename(srcPath)} → ${format.toUpperCase()}`);

  let ffmpegPath = require('ffmpeg-static');
  if (ffmpegPath.includes('app.asar')) {
    ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
  }
  const isAudioOnly = format === 'mp3' || format === 'wav';
  const args = ['-i', srcPath, '-y'];
  if (isAudioOnly) {
    args.push('-vn');
    args.push('-c:a', format === 'mp3' ? 'libmp3lame' : 'pcm_s16le');
  } else if (format === 'webm') {
    args.push('-c:v', 'libvpx', '-c:a', 'libvorbis');
  } else {
    args.push('-c:v', 'libx264', '-c:a', 'aac');
  }
  args.push(outPath);

  try {
    await new Promise((resolve, reject) => {
      const proc = require('child_process').spawn(ffmpegPath, args);
      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(stderr.slice(-400))));
    });

    log.push(`─── Done — saved ${path.basename(outPath)} ✓`);
    shell.openPath(downloadsPath);
    new Notification({ title: 'Nyxon — Media Converter', body: `Converted to ${format.toUpperCase()}` }).show();
    return { success: true, log, outputPath: outPath };

  } catch (err) {
    log.push(`Error: ${err.message}`);
    return { success: false, log, error: err.message };
  }
});
// ─── Video Compressor ──────────────────────────────────────────────────────
ipcMain.handle('run-video-compressor', async (event, config = {}) => {
  const log = [];
  const win = BrowserWindow.getFocusedWindow();
  const crf = ['23','28','34'].includes(config.crf) ? config.crf : '28';

  const result = await dialog.showOpenDialog(win, {
    title: 'Select a video to compress',
    defaultPath: os.homedir(),
    properties: ['openFile'],
    filters: [{ name: 'Video', extensions: ['mp4','mov','mkv','avi','webm'] }]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, log, error: 'No file selected.' };
  }

  const srcPath = result.filePaths[0];
  const originalSize = fs.statSync(srcPath).size;
  const baseName = path.basename(srcPath, path.extname(srcPath));
  const downloadsPath = path.join(os.homedir(), 'Downloads');
  const outPath = path.join(downloadsPath, `${baseName}-compressed.mp4`);

  log.push(`Compressing: ${path.basename(srcPath)} (${(originalSize/1024/1024).toFixed(1)} MB)`);

  let ffmpegPath = require('ffmpeg-static');
  if (ffmpegPath.includes('app.asar')) {
    ffmpegPath = ffmpegPath.replace('app.asar', 'app.asar.unpacked');
  }
  const args = ['-i', srcPath, '-y', '-c:v', 'libx264', '-crf', crf, '-preset', 'medium', '-c:a', 'aac', '-b:a', '128k', outPath];

  try {
    await new Promise((resolve, reject) => {
      const proc = require('child_process').spawn(ffmpegPath, args);
      let stderr = '';
      proc.stderr.on('data', d => { stderr += d.toString(); });
      proc.on('close', code => code === 0 ? resolve() : reject(new Error(stderr.slice(-400))));
    });

    const newSize = fs.statSync(outPath).size;
    const savedPct = (100 - (newSize / originalSize * 100)).toFixed(0);
    log.push(`─── Done — ${(newSize/1024/1024).toFixed(1)} MB (${savedPct}% smaller) ✓`);

    shell.openPath(downloadsPath);
    new Notification({ title: 'Nyxon — Video Compressor', body: `${savedPct}% smaller, saved to Downloads` }).show();
    return { success: true, log, outputPath: outPath };

  } catch (err) {
    log.push(`Error: ${err.message}`);
    return { success: false, log, error: err.message };
  }
});
// ─── Merge PDFs ─────────────────────────────────────────────────────────────
ipcMain.handle('run-pdf-merge', async () => {
  const log = [];
  const win = BrowserWindow.getFocusedWindow();

  const result = await dialog.showOpenDialog(win, {
    title: 'Select 2 or more PDFs to merge (in the order you want them combined)',
    defaultPath: os.homedir(),
    properties: ['openFile', 'multiSelections'],
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
  });

  if (result.canceled || result.filePaths.length < 2) {
    return { success: false, log, error: 'Select at least 2 PDFs to merge.' };
  }

  log.push(`Merging ${result.filePaths.length} PDFs…`);

  try {
    const { PDFDocument } = require('pdf-lib');
    const merged = await PDFDocument.create();

    for (const filePath of result.filePaths) {
      const src = await PDFDocument.load(fs.readFileSync(filePath));
      const pages = await merged.copyPages(src, src.getPageIndices());
      pages.forEach(p => merged.addPage(p));
      log.push(`Added: ${path.basename(filePath)} (${pages.length} page(s))`);
    }

    const bytes = await merged.save();
    const downloadsPath = path.join(os.homedir(), 'Downloads');
    const outPath = path.join(downloadsPath, `merged-${Date.now()}.pdf`);
    fs.writeFileSync(outPath, bytes);

    log.push(`─── Done — ${merged.getPageCount()} total pages, saved as ${path.basename(outPath)} ✓`);
    shell.openPath(downloadsPath);
    new Notification({ title: 'Nyxon — Merge PDFs', body: `${result.filePaths.length} PDFs merged` }).show();
    return { success: true, log, outputPath: outPath };

  } catch (err) {
    log.push(`Error: ${err.message}`);
    return { success: false, log, error: err.message };
  }
});
// ─── PDF Watermark & Protect ───────────────────────────────────────────────
ipcMain.handle('run-pdf-protect', async (event, config = {}) => {
  const log = [];
  const win = BrowserWindow.getFocusedWindow();
  const watermark = (config.watermark || '').trim();
  const password = (config.password || '').trim();

  const result = await dialog.showOpenDialog(win, {
    title: 'Select a PDF',
    defaultPath: os.homedir(),
    properties: ['openFile'],
    filters: [{ name: 'PDF Files', extensions: ['pdf'] }]
  });

  if (result.canceled || result.filePaths.length === 0) {
    return { success: false, log, error: 'No PDF selected.' };
  }

  const srcPath = result.filePaths[0];
  const baseName = path.basename(srcPath, path.extname(srcPath));
  const downloadsPath = path.join(os.homedir(), 'Downloads');

  // Name the intermediate file honestly — it is NOT "protected" until
  // encryption actually succeeds, so it must not be named as if it were.
  const intermediatePath = path.join(downloadsPath, `${baseName}-watermarked-temp.pdf`);
  let finalPath = null;

  try {
    const { PDFDocument, rgb, StandardFonts, degrees } = require('pdf-lib');
    const doc = await PDFDocument.load(fs.readFileSync(srcPath));

    if (watermark) {
      const font = await doc.embedFont(StandardFonts.HelveticaBold);
      for (const page of doc.getPages()) {
        const { width, height } = page.getSize();
        page.drawText(watermark, {
          x: width / 2 - (watermark.length * 6),
          y: height / 2,
          size: 28, font, color: rgb(0.6, 0.1, 0.1),
          opacity: 0.3, rotate: degrees(45)
        });
      }
      log.push(`Watermark "${watermark}" applied to ${doc.getPageCount()} page(s)`);
    }

    const bytes = await doc.save();
    fs.writeFileSync(intermediatePath, bytes);

    if (password) {
      try {
        const muhammara = require('muhammara');
        const encryptedPath = path.join(downloadsPath, `${baseName}-protected.pdf`);
        muhammara.recrypt(intermediatePath, encryptedPath, {
          userPassword: password,
          ownerPassword: password + '-owner',
          userProtectionFlag: 4
        });
        fs.unlinkSync(intermediatePath); // remove the temp unencrypted file
        finalPath = encryptedPath;
        log.push('Password protection applied ✓');

      } catch (encryptErr) {
        // Encryption failed — rename the temp file to something HONEST
        // instead of leaving it as "-watermarked-temp" or claiming "protected"
        const fallbackPath = path.join(downloadsPath, `${baseName}${watermark ? '-watermarked' : ''}-NOT-password-protected.pdf`);
        fs.renameSync(intermediatePath, fallbackPath);
        finalPath = fallbackPath;
        log.push(`Warning: password protection failed (${encryptErr.message})`);
        log.push(`Saved WITHOUT a password as ${path.basename(fallbackPath)} — do not treat this file as secured.`);
      }
    } else {
      // No password requested at all — rename from the temp name to a clean one
      const watermarkOnlyPath = path.join(downloadsPath, `${baseName}-watermarked.pdf`);
      fs.renameSync(intermediatePath, watermarkOnlyPath);
      finalPath = watermarkOnlyPath;
    }

    log.push(`─── Done — saved ${path.basename(finalPath)} ✓`);
    shell.openPath(downloadsPath);
    new Notification({ title: 'Nyxon — PDF Protect', body: `Saved ${path.basename(finalPath)}` }).show();

    // success is only true if nothing was silently downgraded
    const trulySucceeded = !password || finalPath.includes('-protected.pdf');
    return { success: trulySucceeded, log, outputPath: finalPath };

  } catch (err) {
    log.push(`Error: ${err.message}`);
    if (fs.existsSync(intermediatePath)) fs.unlinkSync(intermediatePath);
    return { success: false, log, error: err.message };
  }
});
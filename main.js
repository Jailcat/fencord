const { app, BrowserWindow, session } = require('electron')
const path = require('path')
const https = require('https')

const SCRIPT_URL = 'https://raw.githubusercontent.com/Jailcat/fencord/main/fencord.user.js'
const ALLOWED_ORIGIN = 'https://fenrid.com'

function fetchScript() {
  return new Promise((resolve, reject) => {
    https.get(SCRIPT_URL, (res) => {
      let data = ''
      res.on('data', chunk => data += chunk)
      res.on('end', () => resolve(data))
    }).on('error', reject)
  })
}

app.whenReady().then(async () => {
  let script = ''
  try {
    script = await fetchScript()
  } catch (e) {
    console.error('failed to fetch fencord script:', e)
  }

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    title: 'Fencord',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: false,
      nodeIntegration: false,
    }
  })

  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(ALLOWED_ORIGIN)) e.preventDefault()
  })

  win.webContents.on('did-finish-load', () => {
    if (script) win.webContents.executeJavaScript(script).catch(console.error)
  })

  win.webContents.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36')
  win.loadURL(ALLOWED_ORIGIN)
  win.setMenuBarVisibility(false)
})

app.on('window-all-closed', () => app.quit())

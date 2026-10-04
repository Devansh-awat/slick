// Keep Slick's windows visible when macOS Screen Time hits an app limit.
//
// Screen Time suppression is applied per process, but exemption is checked per
// window: the window server skips any window carrying the SkyLight
// "IgnoreScreenTimeLockout" property when it would otherwise yank it off every
// Space. That property is only settable from inside the process that owns the
// window, through the private SLSSetWindowProperty, so we set it here on each
// window Slack opens.
//
// Everything here is best-effort and macOS-only. A missing symbol, a future
// macOS that drops the property, or koffi not being shipped just means the
// property is never set; it never breaks a window.

import { app, type BrowserWindow } from 'electron';

const KEY = 'IgnoreScreenTimeLockout';
const kCFStringEncodingUTF8 = 0x08000100;

let apply: ((win: BrowserWindow) => void) | null = null;
let built = false;

function build(): ((win: BrowserWindow) => void) | null {
  // koffi is a native module shipped beside the bundle; require lazily so a
  // build without it (or a non-macOS one) simply no-ops.
  const koffi = require('koffi');
  const objc = koffi.load('/usr/lib/libobjc.A.dylib');
  const cf = koffi.load('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation');
  const sky = koffi.load('/System/Library/PrivateFrameworks/SkyLight.framework/SkyLight');

  const getClass = objc.func('objc_getClass', 'void *', ['str']);
  const sel = objc.func('sel_registerName', 'void *', ['str']);
  const msgSendObj = objc.func('objc_msgSend', 'void *', ['void *', 'void *']);
  const msgSendNum = objc.func('objc_msgSend', 'long', ['void *', 'void *']);
  const msgSendBool = objc.func('objc_msgSend', 'void *', ['void *', 'void *', 'bool']);

  const CFStringCreateWithCString = cf.func('CFStringCreateWithCString', 'void *', ['void *', 'str', 'uint32']);
  const SLSMainConnectionID = sky.func('SLSMainConnectionID', 'int', []);
  const SLSSetWindowProperty = sky.func('SLSSetWindowProperty', 'int', ['int', 'uint32', 'void *', 'void *']);

  const cid = SLSMainConnectionID();
  const key = CFStringCreateWithCString(null, KEY, kCFStringEncodingUTF8);
  // @YES is a __NSCFBoolean, toll-free bridged to kCFBooleanTrue, which is the
  // CFBoolean the exemption predicate reads back with SLCFDictionaryGetBoolean.
  const yes = msgSendBool(getClass('NSNumber'), sel('numberWithBool:'), true);
  const windowSel = sel('window');
  const windowNumberSel = sel('windowNumber');
  if (!cid || !key || !yes) return null;

  return (win) => {
    if (win.isDestroyed()) return;
    // The macOS handle is the content NSView*; its window's windowNumber is the
    // id the window server (and SkyLight) knows the window by.
    const view = koffi.decode(win.getNativeWindowHandle(), 'void *');
    if (!view) return;
    const nsWindow = msgSendObj(view, windowSel);
    if (!nsWindow) return;
    const wid = Number(msgSendNum(nsWindow, windowNumberSel));
    if (wid > 0) SLSSetWindowProperty(cid, wid, key, yes);
  };
}

/** Exempt every window Slack opens from Screen Time app-limit suppression. */
export function keepVisibleUnderScreenTime() {
  if (process.platform !== 'darwin') return;
  app.on('browser-window-created', (_event, win) => {
    try {
      if (!built) {
        apply = build();
        built = true;
      }
      if (!apply) return;
      apply(win);
      // windowNumber is only assigned once a window is ordered on screen, so a
      // window created hidden has none yet; re-apply the first time it shows.
      win.once('show', () => {
        try {
          apply?.(win);
        } catch {}
      });
    } catch (error) {
      console.error('[slick] screen-time exemption unavailable:', error);
      apply = null; // give up quietly rather than throw per window
    }
  });
}

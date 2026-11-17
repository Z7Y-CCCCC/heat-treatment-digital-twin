// Installer-only Win32 chrome. No service, filesystem, networking or input
// injection. A native subclass keeps dragging working on every wizard page.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <commctrl.h>
#include "installer-window-chrome-policy.h"

#define CHROME_SUBCLASS 0x48544348
static UINT WindowDpi(HWND window) {
    typedef UINT (WINAPI *GetDpi)(HWND);
    GetDpi fn=(GetDpi)GetProcAddress(GetModuleHandleW(L"user32.dll"),"GetDpiForWindow");
    if(fn) return fn(window);
    { HDC dc=GetDC(window); UINT dpi=dc?(UINT)GetDeviceCaps(dc,LOGPIXELSX):96;
      if(dc) ReleaseDC(window,dc); return dpi?dpi:96; }
}
static void ShapeAndClose(HWND window) {
    static BOOL shaping=FALSE;
    RECT client,outer; HWND close=GetDlgItem(window,2); UINT dpi=WindowDpi(window);
    if(shaping||!GetClientRect(window,&client)||!GetWindowRect(window,&outer)) return;
    shaping=TRUE;
    if(close) { int size=ChromeScale(32,dpi); SetWindowPos(close,HWND_TOP,ChromeCloseLeft(client.right,dpi),0,size,size,SWP_NOACTIVATE); }
    { int diameter=ChromeScale(24,dpi);
      HRGN region=CreateRoundRectRgn(0,0,outer.right-outer.left+1,outer.bottom-outer.top+1,diameter,diameter);
      // Windows owns the region after success. Delete only on failure.
      if(region&&!SetWindowRgn(window,region,TRUE)) DeleteObject(region); }
    shaping=FALSE;
}
static LRESULT CALLBACK HeroProc(HWND window,UINT msg,WPARAM wp,LPARAM lp,UINT_PTR id,DWORD_PTR data) {
    if(msg==WM_NCHITTEST) return HTTRANSPARENT;
    if(msg==WM_NCDESTROY) RemoveWindowSubclass(window,HeroProc,id);
    return DefSubclassProc(window,msg,wp,lp);
}
static LRESULT CALLBACK FrameProc(HWND window,UINT msg,WPARAM wp,LPARAM lp,UINT_PTR id,DWORD_PTR data) {
    if(msg==WM_NCHITTEST) {
        LRESULT hit=DefSubclassProc(window,msg,wp,lp);
        POINT point; RECT hero,close; HWND image=GetDlgItem(window,1036),button=GetDlgItem(window,2);
        point.x=(short)LOWORD(lp); point.y=(short)HIWORD(lp);
        if(hit==HTCLIENT&&image&&GetWindowRect(image,&hero)) {
            int visible=button&&IsWindowVisible(button)&&GetWindowRect(button,&close);
            if(!visible) close.left=close.top=close.right=close.bottom=0;
            if(ChromeCaptionHit(point.x,point.y,hero.left,hero.top,hero.right,hero.bottom,visible,close.left,close.top,close.right,close.bottom)) return HTCAPTION;
        }
        return hit;
    }
    if(msg==WM_SIZE||msg==WM_DPICHANGED) { LRESULT result=DefSubclassProc(window,msg,wp,lp); ShapeAndClose(window); return result; }
    if(msg==WM_NCDESTROY) RemoveWindowSubclass(window,FrameProc,id);
    return DefSubclassProc(window,msg,wp,lp);
}
__declspec(dllexport) int __stdcall Attach(HWND window) {
    HWND hero;
    if(!IsWindow(window)||!SetWindowSubclass(window,FrameProc,CHROME_SUBCLASS,0)) return 0;
    hero=GetDlgItem(window,1036);
    if(!hero||!SetWindowSubclass(hero,HeroProc,CHROME_SUBCLASS,0)) {RemoveWindowSubclass(window,FrameProc,CHROME_SUBCLASS);return 0;}
    ShapeAndClose(window);
    return 1;
}

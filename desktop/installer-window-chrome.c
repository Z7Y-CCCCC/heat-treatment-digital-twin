// Installer-only Win32 chrome and UTF-8 diagnostic log. No service control,
// networking or input injection; cancellation is cooperative, never a kill.
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <commctrl.h>
#include "installer-window-chrome-policy.h"

#define CHROME_SUBCLASS 0x48544348
#define MINIMIZE_ID 1240
#define CLOSE_ID 1241
static volatile LONG busy, cancelRequested;
static HWND progressText;
static DWORD startedTick;
static WCHAR logPath[1024];
#define STATUS_TIMER 0x4854
static HANDLE logFile=INVALID_HANDLE_VALUE;
static void LogLine(LPCWSTR text) {
    char *bytes; DWORD written; int count;
    if(logFile==INVALID_HANDLE_VALUE||!text||text==(LPCWSTR)-1) return;
    count=WideCharToMultiByte(CP_UTF8,0,text,-1,NULL,0,NULL,NULL);
    if(count<=1) return;
    bytes=(char*)HeapAlloc(GetProcessHeap(),0,count);
    if(!bytes) return;
    if(WideCharToMultiByte(CP_UTF8,0,text,-1,bytes,count,NULL,NULL)) {
        WriteFile(logFile,bytes,count-1,&written,NULL); WriteFile(logFile,"\r\n",2,&written,NULL); FlushFileBuffers(logFile);
    }
    HeapFree(GetProcessHeap(),0,bytes);
}
static LRESULT CALLBACK DetailProc(HWND window,UINT msg,WPARAM wp,LPARAM lp,UINT_PTR id,DWORD_PTR data) {
    if(msg==LVM_INSERTITEMW||msg==LVM_SETITEMTEXTW) {
        LVITEMW *item=(LVITEMW*)lp;
        if(item&&(msg==LVM_SETITEMTEXTW||(item->mask&LVIF_TEXT))) LogLine(item->pszText);
    }
    if(msg==WM_NCDESTROY) RemoveWindowSubclass(window,DetailProc,id);
    return DefSubclassProc(window,msg,wp,lp);
}
static UINT WindowDpi(HWND window) {
    typedef UINT (WINAPI *GetDpi)(HWND);
    GetDpi fn=(GetDpi)GetProcAddress(GetModuleHandleW(L"user32.dll"),"GetDpiForWindow");
    if(fn) return fn(window);
    { HDC dc=GetDC(window); UINT dpi=dc?(UINT)GetDeviceCaps(dc,LOGPIXELSX):96;
      if(dc) ReleaseDC(window,dc); return dpi?dpi:96; }
}
static void ShapeAndClose(HWND window) {
    static BOOL shaping=FALSE;
    RECT client,outer; HWND close=GetDlgItem(window,CLOSE_ID),minimize=GetDlgItem(window,MINIMIZE_ID); UINT dpi=WindowDpi(window);
    if(shaping||!GetClientRect(window,&client)||!GetWindowRect(window,&outer)) return;
    shaping=TRUE;
    if(close) { int size=ChromeScale(32,dpi); SetWindowPos(close,HWND_TOP,ChromeCloseLeft(client.right,dpi),0,size,size,SWP_NOACTIVATE); }
    if(minimize) { int size=ChromeScale(32,dpi); SetWindowPos(minimize,HWND_TOP,ChromeCloseLeft(client.right,dpi)-size,0,size,size,SWP_NOACTIVATE); }
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
    if(msg==WM_TIMER&&wp==STATUS_TIMER) {
        WCHAR status[1200]; HWND label=GetDlgItem(GetParent(progressText),1230);
        wsprintfW(status,L"已用 %lu 秒 · 日志：%s",(GetTickCount()-startedTick)/1000,logPath);
        SetWindowTextW(label,status);
        // Never invent percentages while an external installer is running.
        wsprintfW(status,L"热处理数字孪生大屏安装 · 已用 %lu 秒",(GetTickCount()-startedTick)/1000);
        SetWindowTextW(window,status);
        return 0;
    }
    if(msg==WM_COMMAND&&LOWORD(wp)==MINIMIZE_ID) { ShowWindow(window,SW_MINIMIZE); return 0; }
    if(msg==WM_COMMAND&&LOWORD(wp)==CLOSE_ID) { PostMessage(window,WM_CLOSE,0,0); return 0; }
    if(msg==WM_CLOSE&&InterlockedCompareExchange(&busy,0,0)) {
        // Record the request immediately. A modal confirmation here allows
        // the worker to finish behind it before the answer arrives.
        if(!InterlockedExchange(&cancelRequested,1)) {
            SetWindowTextW(progressText,L"已请求取消，等待当前步骤安全结束（可最小化）");
            LogLine(L"用户请求取消；等待当前步骤安全结束。");
        }
        return 0;
    }
    if(msg==WM_DRAWITEM&&(wp==MINIMIZE_ID||wp==CLOSE_ID)) {
        DRAWITEMSTRUCT *draw=(DRAWITEMSTRUCT*)lp;
        HBRUSH brush=CreateSolidBrush((draw->itemState&ODS_SELECTED)?RGB(0,142,160):RGB(17,59,87));
        HPEN pen=CreatePen(PS_SOLID,2,RGB(255,255,255)); HGDIOBJ previous;
        int cx=(draw->rcItem.right+draw->rcItem.left)/2,cy=(draw->rcItem.bottom+draw->rcItem.top)/2;
        FillRect(draw->hDC,&draw->rcItem,brush); DeleteObject(brush);
        previous=SelectObject(draw->hDC,pen);
        if(wp==MINIMIZE_ID) {MoveToEx(draw->hDC,cx-5,cy,NULL);LineTo(draw->hDC,cx+5,cy);}
        else {MoveToEx(draw->hDC,cx-4,cy-4,NULL);LineTo(draw->hDC,cx+5,cy+5);MoveToEx(draw->hDC,cx+4,cy-4,NULL);LineTo(draw->hDC,cx-5,cy+5);}
        SelectObject(draw->hDC,previous);DeleteObject(pen);
        if(draw->itemState&ODS_FOCUS) DrawFocusRect(draw->hDC,&draw->rcItem);
        return TRUE;
    }
    if(msg==WM_NCHITTEST) {
        LRESULT hit=DefSubclassProc(window,msg,wp,lp);
        POINT point; RECT hero,close; HWND image=GetDlgItem(window,1036),button=GetDlgItem(window,CLOSE_ID);
        point.x=(short)LOWORD(lp); point.y=(short)HIWORD(lp);
        if(hit==HTCLIENT&&image&&GetWindowRect(image,&hero)) {
            int visible=button&&IsWindowVisible(button)&&GetWindowRect(button,&close);
            if(visible) close.left-=ChromeScale(32,WindowDpi(window));
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
    if(!CreateWindowExW(0,L"BUTTON",L"最小化",WS_CHILD|WS_VISIBLE|WS_TABSTOP|BS_OWNERDRAW,0,0,32,32,window,(HMENU)MINIMIZE_ID,GetModuleHandleW(NULL),NULL)||
       !CreateWindowExW(0,L"BUTTON",L"关闭",WS_CHILD|WS_VISIBLE|WS_TABSTOP|BS_OWNERDRAW,0,0,32,32,window,(HMENU)CLOSE_ID,GetModuleHandleW(NULL),NULL)) return 0;
    ShapeAndClose(window);
    return 1;
}
__declspec(dllexport) int __stdcall BeginInstall(HWND page,LPCWSTR filename) {
    HWND details=GetDlgItem(page,1016);
    progressText=GetDlgItem(page,1006);
    lstrcpynW(logPath,filename,1024);
    logFile=CreateFileW(filename,GENERIC_WRITE,FILE_SHARE_READ,NULL,CREATE_NEW,FILE_ATTRIBUTE_NORMAL,NULL);
    if(logFile==INVALID_HANDLE_VALUE) return 0;
    if(!details||!SetWindowSubclass(details,DetailProc,CHROME_SUBCLASS,0)) {CloseHandle(logFile);logFile=INVALID_HANDLE_VALUE;return 0;}
    InterlockedExchange(&busy,1);
    startedTick=GetTickCount(); SetTimer(GetParent(page),STATUS_TIMER,1000,NULL);
    LogLine(L"安装开始；日志为 UTF-8，关闭窗口不会中断正在执行的系统安装步骤。");
    return 1;
}
__declspec(dllexport) int __stdcall IsCancelRequested(void) { return InterlockedCompareExchange(&cancelRequested,0,0); }
__declspec(dllexport) void __stdcall EndInstall(void) {
    InterlockedExchange(&busy,0);
    KillTimer(GetParent(GetParent(progressText)),STATUS_TIMER);
    if(logFile!=INVALID_HANDLE_VALUE) {CloseHandle(logFile);logFile=INVALID_HANDLE_VALUE;}
}

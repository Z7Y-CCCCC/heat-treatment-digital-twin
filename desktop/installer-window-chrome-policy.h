/* Pure geometry shared by native chrome and command-line tests. */
static int ChromeScale(int value,unsigned dpi) { return (value*(int)dpi+48)/96; }
static int ChromeCloseLeft(int width,unsigned dpi) { int left=width-ChromeScale(32,dpi);return left>0?left:0; }
static int ChromeInside(int x,int y,int left,int top,int right,int bottom) { return x>=left&&x<right&&y>=top&&y<bottom; }
static int ChromeCaptionHit(int x,int y,int hl,int ht,int hr,int hb,int closeVisible,int cl,int ct,int cr,int cb) {
    return ChromeInside(x,y,hl,ht,hr,hb)&&!(closeVisible&&ChromeInside(x,y,cl,ct,cr,cb));
}

using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace HeatTreatmentCollectorCenter
{
    internal sealed class RoundedSurface : Panel
    {
        [DllImport("user32.dll",CharSet=CharSet.Unicode)]
        static extern IntPtr SendMessage(IntPtr hWnd,int msg,IntPtr wParam,string lParam);
        internal static void SetHint(TextBox box,string hint){box.HandleCreated+=(s,e)=>SendMessage(box.Handle,0x1501,(IntPtr)1,hint);if(box.IsHandleCreated)SendMessage(box.Handle,0x1501,(IntPtr)1,hint);}
        internal Color SurfaceColor=Color.White,BorderColor=Color.FromArgb(219,219,226),AccentBarColor=Color.Empty;
        internal int CornerRadius=12;
        internal RoundedSurface(){DoubleBuffered=true;BackColor=Color.White;ResizeRedraw=true;}
        internal static GraphicsPath RoundedRect(int x,int y,int w,int h,int r)
        {
            var path=new GraphicsPath();
            int d=Math.Min(Math.Max(r*2,2),Math.Min(w,h));
            if(d<2){path.AddRectangle(new Rectangle(x,y,Math.Max(w,1),Math.Max(h,1)));return path;}
            path.AddArc(x,y,d,d,180,90);path.AddArc(x+w-d,y,d,d,270,90);
            path.AddArc(x+w-d,y+h-d,d,d,0,90);path.AddArc(x,y+h-d,d,d,90,90);
            path.CloseFigure();return path;
        }
        internal static Color ResolveBack(Control c)
        {
            for(var cur=c==null?null:c.Parent;cur!=null;cur=cur.Parent){
                var rs=cur as RoundedSurface;if(rs!=null)return rs.SurfaceColor;
                if(cur.BackColor!=Color.Transparent && cur.BackColor.A==255)return cur.BackColor;
            }
            return Color.FromArgb(244,244,246);
        }
        protected override void OnPaintBackground(PaintEventArgs e){e.Graphics.Clear(ResolveBack(this));}
        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;e.Graphics.PixelOffsetMode=PixelOffsetMode.HighQuality;
            int w=Width-1,h=Height-1;if(w<4||h<4)return;
            using(var path=RoundedRect(0,0,w,h,CornerRadius)){
                using(var brush=new SolidBrush(SurfaceColor))e.Graphics.FillPath(brush,path);
                if(AccentBarColor!=Color.Empty && Height>28){
                    using(var bar=RoundedRect(12,11,4,Height-22,2))using(var brush=new SolidBrush(AccentBarColor))e.Graphics.FillPath(brush,bar);
                }
                if(BorderColor!=Color.Transparent)using(var pen=new Pen(BorderColor))e.Graphics.DrawPath(pen,path);
            }
        }
    }
    internal sealed class WorkspaceDeck : Panel
    {
        internal readonly List<Panel> TabPages=new List<Panel>();private int selected=-1;
        internal event EventHandler SelectedIndexChanged;
        internal int SelectedIndex {get{return selected;}set{selected=value;SuspendLayout();for(int n=0;n<TabPages.Count;n++){var page=TabPages[n];if(page.Parent!=this){page.Dock=DockStyle.Fill;Controls.Add(page);}page.Visible=n==value;}ResumeLayout();if(SelectedIndexChanged!=null)SelectedIndexChanged(this,EventArgs.Empty);}}
    }
    internal sealed class SoftButton : Button
    {
        bool hover;
        internal int CornerRadius=8;
        internal Color HoverBack=Color.Empty;
        internal SoftButton(){FlatStyle=FlatStyle.Flat;FlatAppearance.BorderColor=Color.FromArgb(227,227,232);SetStyle(ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer,true);}
        protected override void OnMouseEnter(EventArgs e){hover=true;Invalidate();base.OnMouseEnter(e);}
        protected override void OnMouseLeave(EventArgs e){hover=false;Invalidate();base.OnMouseLeave(e);}
        protected override void OnPaint(PaintEventArgs e)
        {
            e.Graphics.Clear(RoundedSurface.ResolveBack(this));
            e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;e.Graphics.PixelOffsetMode=PixelOffsetMode.HighQuality;
            int w=Width-1,h=Height-1;if(w<4||h<4)return;
            using(var path=RoundedSurface.RoundedRect(0,0,w,h,CornerRadius)){
                bool primary=ForeColor==Color.White;
                Color bg=!Enabled?(primary?Color.FromArgb(196,194,238):Color.FromArgb(241,241,244)):hover?(HoverBack!=Color.Empty?HoverBack:(primary?Color.FromArgb(67,56,202):BackColor==Color.White?Color.FromArgb(246,246,250):Color.FromArgb(238,238,243))):BackColor;
                using(var brush=new SolidBrush(bg))e.Graphics.FillPath(brush,path);
                if(FlatAppearance.BorderSize>0)using(var pen=new Pen(Enabled?FlatAppearance.BorderColor:Color.FromArgb(227,227,232)))e.Graphics.DrawPath(pen,path);
                TextRenderer.DrawText(e.Graphics,Text,Font,ClientRectangle,Enabled?ForeColor:(primary?Color.White:Color.FromArgb(164,164,173)),TextFormatFlags.HorizontalCenter|TextFormatFlags.VerticalCenter|TextFormatFlags.SingleLine|TextFormatFlags.EndEllipsis);
            }
        }
    }
    internal sealed class CenterForm : Form
    {
        readonly Label headline=new Label(), summary=new Label(), footer=new Label();
        readonly Label workspaceCaption=new Label(), sharedServiceNote=new Label();
        readonly List<string> navigationSelections=new List<string>();
        readonly List<object> navigationStates=new List<object>();
        string workspace="points";
        readonly bool navigationSmoke;
        readonly Button install=new SoftButton(), start=new SoftButton(), stop=new SoftButton(), restart=new SoftButton(), authorize=new SoftButton();
        readonly WorkspaceDeck tabs=new WorkspaceDeck();
        readonly DataGridView grid=new DataGridView();
        readonly ComboBox level=new ComboBox(), component=new ComboBox();
        readonly TextBox search=new TextBox();
        readonly CheckBox pause=new CheckBox();
        readonly System.Windows.Forms.Timer timer=new System.Windows.Forms.Timer { Interval=2000 };
        readonly Label[] values=new Label[4], serviceValues=new Label[8];
        readonly Label serviceHeadline=new Label(),serviceSummary=new Label();
        readonly Label[] serviceMetrics={new Label(),new Label(),new Label()};
        readonly ToolTip details=new ToolTip();
        readonly Label normalValue=new Label(),abnormalValue=new Label(),sampleValue=new Label(),modeLabel=new Label();
        readonly Button[] navigation=new Button[2];
        readonly int[] navigationPages=new int[2];
        readonly PointPanel points;
        readonly RoundedSurface statusHero=new RoundedSurface(), serviceHero=new RoundedSurface(), modeBadge=new RoundedSurface();
        readonly Font tabBoldFont=new Font("Microsoft YaHei UI",9F,FontStyle.Bold);
        Snapshot snapshot=new Snapshot(); List<LogLine> entries=new List<LogLine>();
        bool refreshing,busy,protectedLogs,authorizedSnapshot; string logError="";
        readonly string smokePath;
        static readonly Color Green=Color.FromArgb(24,154,88), Muted=Color.FromArgb(133,133,141);
        static readonly Color Canvas=Color.FromArgb(244,244,246), Ink=Color.FromArgb(28,28,33), InkSub=Color.FromArgb(75,75,83), HairBorder=Color.FromArgb(219,219,226), SegTrack=Color.FromArgb(230,230,235), Indigo=Color.FromArgb(79,70,229), WarnAmber=Color.FromArgb(180,83,9), ErrRed=Color.FromArgb(214,69,69);

        internal CenterForm(string smoke, string initialView=null, bool navigationSmoke=false)
        {
            smokePath=smoke; this.navigationSmoke=navigationSmoke; Text="采集运行中心"; Name="CollectorCenter";
            Font=new Font("Microsoft YaHei UI",9F); BackColor=Canvas; ForeColor=Ink;
            ClientSize=new Size(720,600); MinimumSize=new Size(700,590);
            StartPosition=FormStartPosition.CenterScreen; AutoScaleMode=AutoScaleMode.Dpi;
            if(smokePath!=null){Text="采集运行中心 · 界面测试";ShowInTaskbar=false;StartPosition=FormStartPosition.Manual;Location=new Point(-30000,-30000);}
            try { Icon=Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            var root=new TableLayoutPanel { Dock=DockStyle.Fill,Padding=new Padding(20,14,20,10),ColumnCount=1,RowCount=4,BackColor=Canvas };
            foreach(int height in new[]{50,42})root.RowStyles.Add(new RowStyle(SizeType.Absolute,height));
            root.RowStyles.Add(new RowStyle(SizeType.Percent,100));root.RowStyles.Add(new RowStyle(SizeType.Absolute,24));
            var header=new TableLayoutPanel {Dock=DockStyle.Fill,ColumnCount=2,RowCount=2,Margin=Padding.Empty};
            header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,112));
            header.RowStyles.Add(new RowStyle(SizeType.Absolute,30));header.RowStyles.Add(new RowStyle(SizeType.Absolute,20));
            workspaceCaption.Text=CenterNavigation.Caption(initialView);workspaceCaption.Font=new Font(Font.FontFamily,14.5F,FontStyle.Bold);workspaceCaption.Dock=DockStyle.Fill;workspaceCaption.TextAlign=ContentAlignment.MiddleLeft;workspaceCaption.ForeColor=Ink;header.Controls.Add(workspaceCaption,0,0);
            modeBadge.SurfaceColor=Color.FromArgb(236,236,241);modeBadge.BorderColor=Color.FromArgb(214,214,222);modeBadge.CornerRadius=13;modeBadge.Dock=DockStyle.Fill;modeBadge.Margin=new Padding(8,2,0,2);modeBadge.Padding=new Padding(8,0,8,0);
            modeLabel.Text="自动检测";modeLabel.Dock=DockStyle.Fill;modeLabel.TextAlign=ContentAlignment.MiddleCenter;modeLabel.Font=new Font(Font.FontFamily,8.5F,FontStyle.Bold);modeLabel.ForeColor=InkSub;modeLabel.BackColor=modeBadge.SurfaceColor;modeBadge.Controls.Add(modeLabel);header.Controls.Add(modeBadge,1,0);
            sharedServiceNote.Dock=DockStyle.Fill;sharedServiceNote.ForeColor=Muted;sharedServiceNote.Font=new Font(Font.FontFamily,8.5F);sharedServiceNote.TextAlign=ContentAlignment.MiddleLeft;sharedServiceNote.AutoEllipsis=true;header.SetColumnSpan(sharedServiceNote,2);header.Controls.Add(sharedServiceNote,0,1);
            root.Controls.Add(header,0,0);
            var toolbar=new TableLayoutPanel {Dock=DockStyle.Fill,ColumnCount=2,RowCount=1,Margin=new Padding(0,4,0,4)};
            toolbar.ColumnStyles.Add(new ColumnStyle(SizeType.AutoSize));toolbar.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));
            var segWrap=new RoundedSurface {SurfaceColor=SegTrack,BorderColor=Color.FromArgb(212,212,220),CornerRadius=10,Size=new Size(184,34),Padding=new Padding(3),Margin=new Padding(0,0,8,0)};
            var nav=new FlowLayoutPanel {Dock=DockStyle.Fill,WrapContents=false,BackColor=SegTrack,Margin=Padding.Empty};
            for(int index=0;index<2;index++){int selected=index;var b=new SoftButton();Setup(b,"",async()=>{tabs.SelectedIndex=navigationPages[selected];await Task.FromResult(0);});b.Size=new Size(88,28);b.Margin=new Padding(0,0,index==0?2:0,0);b.CornerRadius=7;navigation[index]=b;nav.Controls.Add(b);}
            segWrap.Controls.Add(nav);toolbar.Controls.Add(segWrap,0,0);
            var buttons=new FlowLayoutPanel {Dock=DockStyle.Fill,WrapContents=false,FlowDirection=FlowDirection.RightToLeft,Padding=new Padding(0,3,0,0),Margin=Padding.Empty};
            Setup(install,"安装服务",async()=>await ServiceAction("install"));Setup(start,"启动后台",async()=>await ServiceAction("start"));Setup(stop,"停止后台",async()=>await ServiceAction("stop"));Setup(restart,"重启后台",async()=>await ServiceAction("restart"));
            start.BackColor=Indigo;start.ForeColor=Color.White;start.FlatAppearance.BorderSize=0;
            var more=new SoftButton();Setup(more,"更多 ···",async()=>await Task.FromResult(0));more.Width=64;var menu=new ContextMenuStrip();
            menu.Items.Add("设备采集管理 · 状态 / 点位",null,(s,e)=>SelectWorkspace("points"));
            menu.Items.Add("数据服务管理 · API / 数据库",null,(s,e)=>SelectWorkspace("overview"));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add("刷新状态",null,async(s,e)=>await RefreshAll());
            menu.Items.Add("后台配置说明",null,(s,e)=>MessageBox.Show(this,"请打开大屏软件的「后台管理」进行工程配置。\n\n「设备采集」查看设备采集状态和点位；「数据服务」查看 API、数据库、数据通道及后台日志，并管理共用后台的启停。关闭窗口或大屏不会停止采集。",Text,MessageBoxButtons.OK,MessageBoxIcon.Information));
            menu.Items.Add("导出共用后台诊断",null,async(s,e)=>{try{await Export();}catch(Exception error){MessageBox.Show(this,Ops.Redact(error.Message),Text);}});
            var refresh=new SoftButton();Setup(refresh,"刷新状态",RefreshAll);
            more.Click+=(s,e)=>menu.Show(more,new Point(0,more.Height));
            foreach(var btn in new Button[]{install,start,stop,restart,refresh,more})btn.Margin=new Padding(6,0,0,0);
            buttons.Controls.AddRange(new Control[]{more,refresh,restart,stop,start,install});toolbar.Controls.Add(buttons,1,0);root.Controls.Add(toolbar,0,1);
            tabs.Dock=DockStyle.Fill;tabs.BackColor=Canvas;
            var statusTab=new Panel(){BackColor=Canvas,Padding=new Padding(0,4,0,4)};
            var status=new TableLayoutPanel {Dock=DockStyle.Fill,ColumnCount=1,RowCount=3};
            status.RowStyles.Add(new RowStyle(SizeType.Absolute,74));status.RowStyles.Add(new RowStyle(SizeType.Absolute,96));status.RowStyles.Add(new RowStyle(SizeType.Percent,100));
            statusHero.Dock=DockStyle.Fill;statusHero.Padding=new Padding(22,11,16,11);statusHero.Margin=new Padding(0,0,0,10);statusHero.AccentBarColor=Green;
            var heroInner=new TableLayoutPanel {Dock=DockStyle.Fill,ColumnCount=1,RowCount=2,BackColor=Color.White,Margin=Padding.Empty};
            heroInner.RowStyles.Add(new RowStyle(SizeType.Absolute,24));heroInner.RowStyles.Add(new RowStyle(SizeType.Percent,100));
            headline.Text="正在检测采集进程…";headline.Font=new Font(Font.FontFamily,13F,FontStyle.Bold);headline.Dock=DockStyle.Fill;headline.TextAlign=ContentAlignment.MiddleLeft;headline.ForeColor=Green;headline.BackColor=Color.White;
            summary.Dock=DockStyle.Fill;summary.ForeColor=Muted;summary.TextAlign=ContentAlignment.MiddleLeft;summary.AutoEllipsis=true;summary.BackColor=Color.White;
            heroInner.Controls.Add(headline,0,0);heroInner.Controls.Add(summary,0,1);statusHero.Controls.Add(heroInner);status.Controls.Add(statusHero,0,0);
            var cards=new TableLayoutPanel {Dock=DockStyle.Fill,ColumnCount=3,RowCount=1,Margin=Padding.Empty};for(int n=0;n<3;n++)cards.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,33.333f));
            Label[] metrics={normalValue,abnormalValue,sampleValue};string[] captions={"正常设备","异常设备","最近采样"};
            for(int n=0;n<3;n++){var card=new RoundedSurface {Dock=DockStyle.Fill,Padding=new Padding(16,12,14,10),Margin=new Padding(0,0,n==2?0:10,10)};
                var label=new Label {Text=captions[n],Dock=DockStyle.Fill,ForeColor=Muted,Font=new Font(Font.FontFamily,8.5F),BackColor=Color.White,Margin=Padding.Empty};metrics[n].Text="—";metrics[n].Font=new Font(Font.FontFamily,n==2?13.5F:20F,FontStyle.Bold);metrics[n].ForeColor=Ink;metrics[n].BackColor=Color.White;var content=new TableLayoutPanel {Dock=DockStyle.Fill,ColumnCount=1,RowCount=2,BackColor=Color.White,Margin=Padding.Empty};content.RowStyles.Add(new RowStyle(SizeType.Absolute,20));content.RowStyles.Add(new RowStyle(SizeType.Percent,100));metrics[n].Dock=DockStyle.Fill;metrics[n].TextAlign=ContentAlignment.MiddleLeft;metrics[n].Margin=Padding.Empty;content.Controls.Add(label,0,0);content.Controls.Add(metrics[n],0,1);card.Controls.Add(content);cards.Controls.Add(card,n,0);}status.Controls.Add(cards,0,1);
            var detailCard=new RoundedSurface {Dock=DockStyle.Top,Height=104,Padding=new Padding(18,8,18,8),Margin=Padding.Empty};
            var table=new TableLayoutPanel {Dock=DockStyle.Fill,ColumnCount=4,RowCount=2,BackColor=Color.White,Margin=Padding.Empty};
            table.Paint+=(s,pe)=>{using(var div=new Pen(Color.FromArgb(236,236,240)))pe.Graphics.DrawLine(div,0,table.Height/2,table.Width,table.Height/2);};
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,80));table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,50));table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,80));table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,50));
            for(int n=0;n<2;n++)table.RowStyles.Add(new RowStyle(SizeType.Percent,50));
            string[] names={"采集进程","数据来源","后台依赖","采集范围"};
            for(int n=0;n<4;n++){int row=n/2,col=n%2*2;table.Controls.Add(new Label {Text=names[n],Dock=DockStyle.Fill,ForeColor=Muted,BackColor=Color.White,TextAlign=ContentAlignment.MiddleLeft},col,row);values[n]=new Label {Text="—",Dock=DockStyle.Fill,AutoEllipsis=true,TextAlign=ContentAlignment.MiddleLeft,ForeColor=Ink,BackColor=Color.White,AccessibleName=names[n]};table.Controls.Add(values[n],col+1,row);}detailCard.Controls.Add(table);status.Controls.Add(detailCard,0,2);statusTab.Controls.Add(status);tabs.TabPages.Add(statusTab);
            points=new PointPanel(()=>snapshot);var pointTab=new Panel(){BackColor=Canvas};pointTab.Controls.Add(points);tabs.TabPages.Add(pointTab);
            var logTab=new Panel(){BackColor=Canvas,Padding=new Padding(0,4,0,4)};
            var logCard=new RoundedSurface {Dock=DockStyle.Fill,Padding=new Padding(14,10,14,10),Margin=Padding.Empty};
            var logLayout=new TableLayoutPanel {Dock=DockStyle.Fill,RowCount=2,ColumnCount=1,BackColor=Color.White,Margin=Padding.Empty};logLayout.RowStyles.Add(new RowStyle(SizeType.Absolute,36));logLayout.RowStyles.Add(new RowStyle(SizeType.Percent,100));
            var filters=new FlowLayoutPanel {Dock=DockStyle.Fill,WrapContents=false,BackColor=Color.White,Padding=new Padding(0,2,0,0),Margin=Padding.Empty};level.DropDownStyle=ComboBoxStyle.DropDownList;level.Items.AddRange(new object[]{"全部日志","警告/错误","错误","信息"});level.SelectedIndex=0;level.Width=104;level.Margin=new Padding(0,2,8,0);
            component.DropDownStyle=ComboBoxStyle.DropDownList;component.Items.Add("全部组件");component.SelectedIndex=0;
            var searchWrap=new RoundedSurface {SurfaceColor=Color.White,BorderColor=Color.FromArgb(214,214,222),CornerRadius=8,Size=new Size(186,27),Padding=new Padding(9,5,9,3),Margin=new Padding(0,1,8,0)};
            search.BorderStyle=BorderStyle.None;search.Dock=DockStyle.Fill;search.BackColor=Color.White;search.ForeColor=Ink;search.AccessibleName="搜索日志";RoundedSurface.SetHint(search,"搜索日志关键词…");searchWrap.Controls.Add(search);
            pause.Text="暂停";pause.AutoSize=true;pause.ForeColor=InkSub;pause.BackColor=Color.White;pause.Padding=new Padding(2,4,8,0);
            Setup(authorize,"授权读取",async()=>await ReadLogs(true));authorize.Visible=false;authorize.Margin=new Padding(0,1,6,0);
            var copy=new SoftButton();Setup(copy,"复制",async()=>{string text=string.Join(Environment.NewLine,Filtered().Select(x=>x.Message).ToArray());if(text.Length>0)Clipboard.SetText(text);await Task.FromResult(0);});copy.Size=new Size(58,27);copy.Margin=new Padding(0,1,0,0);
            filters.Controls.AddRange(new Control[]{level,searchWrap,pause,authorize,copy});
            grid.Dock=DockStyle.Fill;grid.Margin=new Padding(0,4,0,0);grid.ReadOnly=true;grid.AllowUserToAddRows=false;grid.AllowUserToDeleteRows=false;grid.RowHeadersVisible=false;grid.BackgroundColor=Color.White;grid.BorderStyle=BorderStyle.None;grid.SelectionMode=DataGridViewSelectionMode.FullRowSelect;grid.AutoSizeRowsMode=DataGridViewAutoSizeRowsMode.None;grid.RowTemplate.Height=29;grid.EnableHeadersVisualStyles=false;grid.ColumnHeadersHeight=32;grid.ColumnHeadersHeightSizeMode=DataGridViewColumnHeadersHeightSizeMode.DisableResizing;
            grid.ColumnHeadersDefaultCellStyle.BackColor=Color.FromArgb(249,249,251);grid.ColumnHeadersDefaultCellStyle.ForeColor=Muted;grid.ColumnHeadersDefaultCellStyle.Font=new Font(Font.FontFamily,8.5F,FontStyle.Bold);grid.ColumnHeadersDefaultCellStyle.Padding=new Padding(6,0,6,0);grid.GridColor=Color.FromArgb(236,236,240);grid.DefaultCellStyle.ForeColor=Ink;grid.DefaultCellStyle.Padding=new Padding(6,0,6,0);grid.DefaultCellStyle.SelectionBackColor=Color.FromArgb(238,237,253);grid.DefaultCellStyle.SelectionForeColor=Color.FromArgb(55,48,163);
            grid.ColumnHeadersBorderStyle=DataGridViewHeaderBorderStyle.None;grid.CellBorderStyle=DataGridViewCellBorderStyle.SingleHorizontal;grid.Columns.Add("time","时间");grid.Columns.Add("level","级别");grid.Columns.Add("message","内容");grid.Columns[0].Width=112;grid.Columns[1].Width=65;grid.Columns[2].AutoSizeMode=DataGridViewAutoSizeColumnMode.Fill;
            logLayout.Controls.Add(filters,0,0);logLayout.Controls.Add(grid,0,1);logCard.Controls.Add(logLayout);logTab.Controls.Add(logCard);tabs.TabPages.Add(logTab);
            level.SelectedIndexChanged+=(s,e)=>RenderLogs();search.TextChanged+=(s,e)=>RenderLogs();
            tabs.TabPages.Add(CreateServiceOverview());
            tabs.SelectedIndexChanged+=async(s,e)=>{UpdateNavigationVisuals();if(smokePath!=null)return;if(tabs.SelectedIndex==2)await ReadLogs(false);if(tabs.SelectedIndex==1)await points.RefreshPoints();};
            SelectWorkspace(CenterNavigation.IsView(initialView)?initialView:"points");
            if(!CenterNavigation.IsView(initialView))tabs.SelectedIndex=0;
            root.Controls.Add(tabs,0,2);footer.Dock=DockStyle.Fill;footer.TextAlign=ContentAlignment.BottomLeft;footer.Font=new Font(Font.FontFamily,8.5F);footer.ForeColor=Muted;root.Controls.Add(footer,0,3);Controls.Add(root);
            timer.Tick+=async(s,e)=>await RefreshAll();Shown+=async(s,e)=>{if(navigationSmoke)await NavigationSmoke();else if(smokePath!=null)await Smoke();else{await RefreshAll();timer.Start();}};FormClosed+=(s,e)=>{timer.Dispose();menu.Dispose();details.Dispose();tabBoldFont.Dispose();};
        }
        void UpdateNavigationVisuals()
        {
            for(int n=0;n<navigation.Length;n++){
                bool active=navigationPages[n]==tabs.SelectedIndex;
                navigation[n].BackColor=active?Color.White:SegTrack;
                navigation[n].ForeColor=active?Ink:InkSub;
                navigation[n].Font=active?tabBoldFont:Font;
                navigation[n].FlatAppearance.BorderSize=active?1:0;
                navigation[n].FlatAppearance.BorderColor=active?Color.FromArgb(212,212,222):SegTrack;
            }
        }
        Panel CreateServiceOverview()
        {
            var page=new Panel {BackColor=Canvas,Padding=new Padding(0,4,0,4)};
            var layout=new TableLayoutPanel {Dock=DockStyle.Fill,ColumnCount=1,RowCount=3};
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute,74));layout.RowStyles.Add(new RowStyle(SizeType.Absolute,96));layout.RowStyles.Add(new RowStyle(SizeType.Percent,100));
            serviceHero.Dock=DockStyle.Fill;serviceHero.Padding=new Padding(22,11,16,11);serviceHero.Margin=new Padding(0,0,0,10);serviceHero.AccentBarColor=Green;
            var heroInner=new TableLayoutPanel {Dock=DockStyle.Fill,ColumnCount=1,RowCount=2,BackColor=Color.White,Margin=Padding.Empty};
            heroInner.RowStyles.Add(new RowStyle(SizeType.Absolute,24));heroInner.RowStyles.Add(new RowStyle(SizeType.Percent,100));
            serviceHeadline.Dock=DockStyle.Fill;serviceHeadline.Font=new Font(Font.FontFamily,13F,FontStyle.Bold);serviceHeadline.TextAlign=ContentAlignment.MiddleLeft;serviceHeadline.BackColor=Color.White;
            serviceSummary.Dock=DockStyle.Fill;serviceSummary.ForeColor=Muted;serviceSummary.TextAlign=ContentAlignment.MiddleLeft;serviceSummary.AutoEllipsis=true;serviceSummary.BackColor=Color.White;
            heroInner.Controls.Add(serviceHeadline,0,0);heroInner.Controls.Add(serviceSummary,0,1);serviceHero.Controls.Add(heroInner);layout.Controls.Add(serviceHero,0,0);
            var cards=new TableLayoutPanel {Dock=DockStyle.Fill,ColumnCount=3,RowCount=1,Margin=Padding.Empty};
            string[] captions={"后台 API","数据库","大屏数据通道"};
            for(int n=0;n<3;n++){
                cards.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,33.333f));
                var card=new RoundedSurface {Dock=DockStyle.Fill,Padding=new Padding(16,12,14,10),Margin=new Padding(0,0,n==2?0:10,10)};
                var content=new TableLayoutPanel {Dock=DockStyle.Fill,BackColor=Color.White,ColumnCount=1,RowCount=2,Margin=Padding.Empty};
                content.RowStyles.Add(new RowStyle(SizeType.Absolute,20));content.RowStyles.Add(new RowStyle(SizeType.Percent,100));
                content.Controls.Add(new Label {Text=captions[n],Dock=DockStyle.Fill,ForeColor=Muted,Font=new Font(Font.FontFamily,8.5F),BackColor=Color.White,Margin=Padding.Empty},0,0);
                var metric=serviceMetrics[n];metric.Dock=DockStyle.Fill;metric.Margin=Padding.Empty;metric.TextAlign=ContentAlignment.MiddleLeft;metric.Font=new Font(Font.FontFamily,13.5F,FontStyle.Bold);metric.BackColor=Color.White;metric.AutoEllipsis=true;
                content.Controls.Add(metric,0,1);card.Controls.Add(content);cards.Controls.Add(card,n,0);
            }
            layout.Controls.Add(cards,0,1);
            var detailCard=new RoundedSurface {Dock=DockStyle.Top,Height=196,Padding=new Padding(18,8,18,8),Margin=Padding.Empty};
            var table=new TableLayoutPanel {Dock=DockStyle.Fill,ColumnCount=4,RowCount=4,BackColor=Color.White,Margin=Padding.Empty};
            table.Paint+=(s,pe)=>{using(var div=new Pen(Color.FromArgb(236,236,240)))for(int i=1;i<4;i++){int y=table.Height*i/4;pe.Graphics.DrawLine(div,0,y,table.Width,y);}};
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,80));table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,50));table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,80));table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,50));
            for(int n=0;n<4;n++)table.RowStyles.Add(new RowStyle(SizeType.Percent,25));
            string[] names={"后台服务","API 状态","数据库","服务地址","大屏连接","最后通信","通道说明","管理范围"};
            for(int n=0;n<8;n++){
                int row=n/2,col=n%2*2;
                table.Controls.Add(new Label {Text=names[n],Dock=DockStyle.Fill,ForeColor=Muted,BackColor=Color.White,TextAlign=ContentAlignment.MiddleLeft},col,row);
                serviceValues[n]=new Label {Text="—",Dock=DockStyle.Fill,ForeColor=Ink,BackColor=Color.White,TextAlign=ContentAlignment.MiddleLeft,AutoEllipsis=true,AccessibleName=names[n]};
                table.Controls.Add(serviceValues[n],col+1,row);
            }
            detailCard.Controls.Add(table);layout.Controls.Add(detailCard,0,2);page.Controls.Add(layout);return page;
        }
        void SelectWorkspace(string view)
        {
            workspace=view=="overview"?"overview":"points";
            bool data=workspace=="overview";
            workspaceCaption.Text=data?"数据服务 · API / 数据库":"设备采集 · 状态 / 点位";
            sharedServiceNote.Text=data?"管理 API、数据库及数据通道；后台启停会同时影响设备采集。":"管理设备采集状态与点位；后台 API / 数据库请从「数据服务」进入。";
            navigationPages[0]=data?3:0;navigationPages[1]=data?2:1;
            navigation[0].Text=data?"API / 数据库":"采集状态";navigation[1].Text=data?"后台日志":"采集点位";
            start.Visible=stop.Visible=restart.Visible=data;
            tabs.SelectedIndex=CenterNavigation.TabIndex(view);
            UpdateNavigationVisuals();
            RenderStatus();
        }
        void CaptureNavigationState(string view)
        {
            navigationStates.Add(new {view,workspace,selectedIndex=tabs.SelectedIndex,caption=workspaceCaption.Text,
                navigation=navigation.Select(b=>b.Text).ToArray(),pages=navigationPages.ToArray(),serviceControlsVisible=start.Visible,
                headline=workspace=="overview"?serviceHeadline.Text:headline.Text,summary=workspace=="overview"?serviceSummary.Text:summary.Text,
                metrics=workspace=="overview"?serviceMetrics.Select(m=>m.Text).ToArray():new[]{normalValue.Text,abnormalValue.Text,sampleValue.Text}});
            using(var bitmap=new Bitmap(Width,Height)){DrawToBitmap(bitmap,new Rectangle(0,0,Width,Height));bitmap.Save(Path.Combine(smokePath,"navigation-"+view+".png"));}
        }
        void VerifyWorkspace()
        {
            bool data=workspace=="overview";
            if(start.Visible!=data || stop.Visible!=data || restart.Visible!=data || install.Visible!= (data && !snapshot.Installed))throw new Exception("Cross-workspace service controls");
            if(data && (navigationPages.Contains(0) || navigationPages.Contains(1)))throw new Exception("Device pages exposed in data service workspace");
            if(!data && (navigationPages.Contains(2) || navigationPages.Contains(3)))throw new Exception("Data service pages exposed in device workspace");
            // Exercise the real buttons, not just caption/route metadata.
            int selected=tabs.SelectedIndex;
            foreach(var button in navigation){button.PerformClick();if(!navigationPages.Contains(tabs.SelectedIndex))throw new Exception("Cross-workspace navigation");}
            tabs.SelectedIndex=selected;
        }
        internal Task<string> SelectNavigationViewAsync(string view)
        {
            if(!CenterNavigation.IsView(view) || IsDisposed || !IsHandleCreated)return Task.FromResult("unconfirmed");
            var completion=new TaskCompletionSource<string>();
            try { BeginInvoke(new Action(()=>{
                if(IsDisposed){completion.TrySetResult("unconfirmed");return;}
                SelectWorkspace(view);
                if(smokePath==null){if(WindowState==FormWindowState.Minimized)WindowState=FormWindowState.Normal;Show();BringToFront();Activate();}
                navigationSelections.Add(view);
                if(navigationSmoke){VerifyWorkspace();CaptureNavigationState(view);}
                completion.TrySetResult(tabs.SelectedIndex==CenterNavigation.TabIndex(view)?view:"unconfirmed");
            })); } catch(InvalidOperationException){completion.TrySetResult("unconfirmed");}
            return completion.Task;
        }
        async Task NavigationSmoke()
        {
            try {
                Directory.CreateDirectory(smokePath);points.SmokeFixture();
                snapshot=new Snapshot {Installed=true,Running=true,Service="运行中",Api="可达",Database="已连接",Healthy=false,HealthLabel="采集异常",Error="9 台设备异常",Normal=0,Abnormal=9,Collection="88.1 秒前",Mode="现场采集"};RenderStatus();
                await Task.Delay(200);
                VerifyWorkspace();
                File.WriteAllText(Path.Combine(smokePath,"navigation-ready.json"),Ops.Serialize(new{processId=Process.GetCurrentProcess().Id,selectedIndex=tabs.SelectedIndex,caption=workspaceCaption.Text,fixtureOnly=true}));
                var deadline=DateTime.UtcNow.AddSeconds(25);
                while(navigationSelections.Count<3 && DateTime.UtcNow<deadline)await Task.Delay(100);
                if(navigationSelections.Count!=3 || navigationSelections[0]!="points" || navigationSelections[1]!="overview" || navigationSelections[2]!="points")throw new Exception("Same-instance view selection not confirmed");
                using(var bitmap=new Bitmap(Width,Height)){DrawToBitmap(bitmap,new Rectangle(0,0,Width,Height));bitmap.Save(Path.Combine(smokePath,"navigation-points.png"));}
                // PLC failure must not become an API/database failure, and vice versa.
                SelectWorkspace("overview");
                if(serviceHeadline.Text!="数据服务正常" || serviceSummary.Text.Contains("9 台"))throw new Exception("Collection failure leaked into data service health");
                snapshot.Database="异常";RenderStatus();
                if(serviceHeadline.Text!="数据库连接异常" || serviceMetrics[1].Text!="异常")throw new Exception("Database failure hidden by API availability");
                CaptureNavigationState("database-error");
                snapshot.Api="不可达";snapshot.Database="未知";RenderStatus();
                if(serviceHeadline.Text!="后台 API 不可达" || serviceMetrics[1].Text!="未知")throw new Exception("Unavailable API reported as healthy");
                CaptureNavigationState("api-error");
                snapshot.Api="可达";snapshot.Database="已连接";SelectWorkspace("points");VerifyWorkspace();
                File.WriteAllText(Path.Combine(smokePath,"navigation-result.json"),Ops.Serialize(new{success=true,processId=Process.GetCurrentProcess().Id,views=navigationSelections.ToArray(),states=navigationStates.ToArray(),selectedIndex=tabs.SelectedIndex,caption=workspaceCaption.Text,sharedServiceNote=sharedServiceNote.Text,fixtureOnly=true,serviceOperations=0}));
            }catch(Exception error){File.WriteAllText(Path.Combine(smokePath,"navigation-result.json"),Ops.Serialize(new{success=false,error=error.ToString(),fixtureOnly=true}));}
            finally{Close();}
        }
        void Setup(Button button,string caption,Func<Task> action)
        {
            button.Text=caption; button.AutoSize=false; button.Size=new Size(68,28); button.Margin=new Padding(6,0,0,0);
            button.FlatStyle=FlatStyle.Flat;button.BackColor=Color.White;button.ForeColor=InkSub;button.FlatAppearance.BorderColor=HairBorder;button.FlatAppearance.MouseOverBackColor=Color.FromArgb(246,246,250);
            button.Click+=async(s,e)=>{ try { await action(); } catch(Exception error) { if(!IsDisposed) MessageBox.Show(this,Ops.Redact(error.Message),Text,MessageBoxButtons.OK,MessageBoxIcon.Warning); } };
        }
        async Task RefreshAll()
        {
            if(refreshing || IsDisposed) return; refreshing=true;
            try { snapshot=await Ops.Status(); if(IsDisposed) return; RenderStatus();
                if(tabs.SelectedIndex==2 && !pause.Checked && !protectedLogs && !busy) await ReadLogs(false);
                if(tabs.SelectedIndex==1 && !busy)await points.RefreshPoints(); }
            finally { refreshing=false; }
        }
        void RenderStatus()
        {
            headline.Text=snapshot.Api=="可达"?snapshot.HealthLabel:!snapshot.Installed?"未安装开机采集服务":!snapshot.Running?"采集服务"+snapshot.Service:"采集进程未连接";
            Color statusColor=snapshot.Healthy?Green:snapshot.Api=="可达"?WarnAmber:ErrRed;
            headline.ForeColor=statusColor;statusHero.AccentBarColor=statusColor;statusHero.Invalidate();
            modeLabel.Text=workspace=="overview"?"后台服务":snapshot.Api=="可达"?snapshot.Mode:"未连接";
            bool modeAccent=workspace=="overview"||snapshot.Api=="可达";
            modeBadge.SurfaceColor=workspace=="overview"?Color.FromArgb(238,237,253):snapshot.Api=="可达"?Color.FromArgb(228,246,236):Color.FromArgb(236,236,241);
            modeBadge.BorderColor=workspace=="overview"?Color.FromArgb(215,213,247):snapshot.Api=="可达"?Color.FromArgb(193,234,212):Color.FromArgb(220,220,228);
            modeLabel.BackColor=modeBadge.SurfaceColor;modeLabel.ForeColor=workspace=="overview"?Indigo:modeAccent?Green:InkSub;modeBadge.Invalidate();
            string[] text={snapshot.Process,snapshot.Mode,snapshot.Api,"本机全部工厂"};for(int n=0;n<values.Length;n++){values[n].Text=text[n];details.SetToolTip(values[n],text[n]);}
            string[] serviceText={snapshot.Service,snapshot.Api,snapshot.Database,snapshot.Origin,snapshot.DisplayConnection,snapshot.DisplayLastCommunication,snapshot.DisplayNote,"API / 数据库 / 数据通道"};
            for(int n=0;n<serviceValues.Length;n++){serviceValues[n].Text=serviceText[n];details.SetToolTip(serviceValues[n],serviceText[n]);}
            details.SetToolTip(serviceValues[4],"后台观测到的大屏实时 WebSocket；每 5 秒心跳，15 秒超时；管理网页或接口检测不计为大屏");
            if(snapshot.DisplayState=="unknown")details.SetToolTip(serviceValues[6],"服务未连接或未提供新版心跳字段，不能确认大屏状态；更新服务版本后再检查");
            serviceValues[4].ForeColor=snapshot.DisplayState=="online"?Green:WarnAmber;
            bool apiReady=snapshot.Api=="可达",databaseReady=snapshot.Database=="已连接";
            serviceHeadline.Text=!apiReady?"后台 API 不可达":!databaseReady?"数据库连接异常":"数据服务正常";
            Color svcColor=apiReady && databaseReady?Green:!apiReady?ErrRed:WarnAmber;
            serviceHeadline.ForeColor=svcColor;serviceHero.AccentBarColor=svcColor;serviceHero.Invalidate();
            serviceSummary.Text=!apiReady?snapshot.Error:!databaseReady?"API 可达，但数据库连接异常；请检查数据库。":"API 可达，数据库已连接；设备采集状态请从「设备采集」查看。";
            string[] metricText={snapshot.Api,snapshot.Database,snapshot.DisplayState=="online"?"已连接":snapshot.DisplayState=="offline"?"未连接":snapshot.DisplayState=="stale"?"通信超时":"未知"};
            bool[] metricReady={apiReady,databaseReady,snapshot.DisplayState=="online"};
            for(int n=0;n<serviceMetrics.Length;n++){serviceMetrics[n].Text=metricText[n];serviceMetrics[n].ForeColor=metricReady[n]?Green:WarnAmber;}
            normalValue.Text=snapshot.Normal<0?"—":snapshot.Normal.ToString();normalValue.ForeColor=snapshot.Normal>0?Green:Ink;
            abnormalValue.Text=snapshot.Abnormal<0?"—":snapshot.Abnormal.ToString();abnormalValue.ForeColor=snapshot.Abnormal>0?ErrRed:Ink;
            sampleValue.Text=snapshot.Collection;
            summary.Text=snapshot.Error;
            bool pending=snapshot.Installed && snapshot.Service!="已停止" && !snapshot.Running;
            install.Visible=workspace=="overview" && !snapshot.Installed; install.Enabled=!busy && snapshot.Service!="无法查询" && snapshot.RuntimeReady;
            start.Enabled=!busy && snapshot.Installed && snapshot.Service=="已停止";
            stop.Enabled=!busy && snapshot.Running; restart.Enabled=!busy && snapshot.Installed && !pending;
            footer.Text=snapshot.CheckedAt.ToString("HH:mm:ss")+" 更新  ·  "+(snapshot.Installed?(workspace=="overview"?"范围：本机后台 · 关闭窗口不停止服务":"范围：本机全部工厂 · 关闭窗口不停止采集"):"服务未安装，不会使用大屏内采集进程");
        }
        async Task ServiceAction(string action)
        {
            if(workspace!="overview")throw new InvalidOperationException("后台服务启停请从「数据服务」进入。");
            if(busy) return;
            if(action=="install" && !snapshot.RuntimeReady) throw new InvalidOperationException("需要完整的独立采集运行中心安装包；不能从大屏资源目录安装服务。");
            string caption=action=="install" ? "安装并启动后台服务" : action=="start" ? "启动后台服务" : action=="stop" ? "停止后台服务" : "重启后台服务";
            string detail=action=="install" ? "将采集程序安装到独立目录。首次安装需先保存并退出大屏，再导入当前工程；原数据保留。需要管理员授权。" : action=="stop" || action=="restart" ? "设备采集与数据服务共用此后台服务。此操作将同时中断全部设备采集、API、数据库访问及大屏数据通道。需要管理员授权。" : "将启动共用后台，恢复 API、数据库访问和设备采集。需要管理员授权。";
            if(MessageBox.Show(this,detail,caption,MessageBoxButtons.OKCancel,MessageBoxIcon.Warning,MessageBoxDefaultButton.Button2)!=DialogResult.OK) return;
            busy=true; RenderStatus(); footer.Text="正在操作，请稍候…";
            try { await Ops.Elevated(action); entries.Clear(); protectedLogs=false; authorizedSnapshot=false; }
            catch(Win32Exception ex) { if(ex.NativeErrorCode!=1223) throw; }
            finally { busy=false; RenderStatus(); }
            await RefreshAll();
        }
        async Task ReadLogs(bool elevated)
        {
            if(busy || IsDisposed) return;
            try {
                if(elevated) {
                    if(MessageBox.Show(this,"授权读取日志快照？",Text,MessageBoxButtons.OKCancel,MessageBoxIcon.Question,MessageBoxDefaultButton.Button2)!=DialogResult.OK) return;
                    busy=true;
                    var result=await Ops.Elevated("logs");
                    entries=Ops.ParseLogs(Ops.Items(Ops.Get(result,"files")).Select(f=>new KeyValuePair<string,string>(Ops.Str(f,"name"),Ops.Str(f,"text"))));
                    protectedLogs=true; authorizedSnapshot=true;
                } else {
                    if(authorizedSnapshot) { RenderLogs(); return; }
                    entries=await Task.Run(()=>Ops.Logs()); protectedLogs=false;
                }
                logError=""; authorize.Visible=protectedLogs; RenderLogs();
                footer.Text=DateTime.Now.ToString("HH:mm:ss")+(authorizedSnapshot ? " 授权快照" : " 日志已更新");
            } catch(Exception error) {
                protectedLogs=true; authorize.Visible=true; logError=Ops.Redact(error.Message);
                footer.Text=authorizedSnapshot ? "上次日志快照 · 点击授权刷新" : "日志受保护 · 点击授权读取";
            } finally { busy=false; }
        }
        IEnumerable<LogLine> Filtered()
        {
            var result=entries.AsEnumerable();
            if(level.SelectedIndex==1) result=result.Where(e=>e.Level=="WARN" || e.Level=="ERROR" || e.Level=="FATAL");
            if(level.SelectedIndex==2) result=result.Where(e=>e.Level=="ERROR");
            if(level.SelectedIndex==3) result=result.Where(e=>e.Level=="INFO");
            if(component.SelectedIndex>0) result=result.Where(e=>e.File==Ops.LogFiles[component.SelectedIndex-1]);
            if(search.Text!="") result=result.Where(e=>e.Message.IndexOf(search.Text,StringComparison.OrdinalIgnoreCase)>=0);
            return result;
        }
        void RenderLogs()
        {
            if(IsDisposed) return;
            grid.SuspendLayout(); grid.Rows.Clear();
            foreach(var entry in Filtered().Reverse().Take(500).Reverse()) {
                int row=grid.Rows.Add(entry.Time,entry.Level,entry.Message); grid.Rows[row].Tag=entry.File;
                if(entry.Level=="ERROR") grid.Rows[row].DefaultCellStyle.ForeColor=ErrRed;
                else if(entry.Level=="WARN") grid.Rows[row].DefaultCellStyle.ForeColor=WarnAmber;
            }
            if(!pause.Checked && grid.Rows.Count>0) grid.FirstDisplayedScrollingRowIndex=grid.Rows.Count-1;
            grid.ResumeLayout();
        }
        async Task Export()
        {
            if(busy) return;
            using(var save=new SaveFileDialog { Title="导出诊断",Filter="压缩诊断包|*.json.gz",FileName="采集诊断-"+DateTime.Now.ToString("yyyyMMdd-HHmmss")+".json.gz" }) {
                if(save.ShowDialog(this)!=DialogResult.OK) return;
                await ReadLogs(false); Ops.Export(save.FileName,snapshot,entries,logError);
                footer.Text="诊断已保存"+(entries.Count==0 ? "（无日志）" : "");
            }
        }
        async Task Smoke()
        {
            try {
                await Task.Delay(1200); Directory.CreateDirectory(smokePath);
                using(var bitmap=new Bitmap(Width,Height)) { DrawToBitmap(bitmap,new Rectangle(0,0,Width,Height)); bitmap.Save(Path.Combine(smokePath,"native-overview.png")); }
                var fixture=Ops.Parse("{\"db\":{\"connected\":true},\"collectorFactories\":[{\"mode\":\"integrated_plc\"}],\"collectorHealth\":{\"state\":\"degraded\",\"label\":\"部分采集异常\",\"reason\":\"1 台设备异常，其余设备继续采集\",\"counts\":{\"normal\":16,\"abnormal\":1},\"lastSampleAgeMs\":46,\"process\":{\"pid\":1234,\"memoryRssBytes\":67108864}}}");
                ((IDictionary<string,object>)fixture)["components"]=Ops.Parse("{\"displayConnection\":{\"status\":\"online\",\"connectedClients\":2,\"sceneReadyClients\":2,\"ageMs\":820}}");
                snapshot=Ops.Summarize(new Snapshot {Installed=true,Running=true,Service="运行中"},fixture,DateTime.UtcNow);RenderStatus();
                using(var bitmap=new Bitmap(Width,Height)) { DrawToBitmap(bitmap,new Rectangle(0,0,Width,Height)); bitmap.Save(Path.Combine(smokePath,"native-overview-fixture.png")); }
                foreach(var state in new[]{"offline","stale"}) {
                    ((IDictionary<string,object>)fixture)["components"]=Ops.Parse("{\"displayConnection\":{\"status\":\""+state+"\",\"connectedClients\":0,\"sceneReadyClients\":0,\"ageMs\":16000}}");
                    snapshot=Ops.Summarize(new Snapshot {Installed=true,Running=true,Service="运行中"},fixture,DateTime.UtcNow);RenderStatus();
                    using(var bitmap=new Bitmap(Width,Height)){DrawToBitmap(bitmap,new Rectangle(0,0,Width,Height));bitmap.Save(Path.Combine(smokePath,"native-overview-"+state+".png"));}
                }
                ((IDictionary<string,object>)fixture)["components"]=Ops.Parse("{\"displayConnection\":{\"status\":\"online\",\"connectedClients\":2,\"sceneReadyClients\":2,\"ageMs\":820}}");
                snapshot=Ops.Summarize(new Snapshot {Installed=true,Running=true,Service="运行中"},fixture,DateTime.UtcNow);RenderStatus();
                SelectWorkspace("overview");tabs.SelectedIndex=2; await Task.Delay(500);
                entries=Ops.ParseLogs(new[]{new KeyValuePair<string,string>("backend.log","[2026-10-30T12:00:00Z] 中文警告 <script>alert(1)</script>\n[2026-10-30T12:00:01Z] password=SECRET 连接失败\n[2026-10-30T12:00:02Z] Ready")});
                level.SelectedIndex=1; search.Text="中文"; RenderLogs();
                if(grid.Rows.Count!=1) throw new Exception("日志筛选失败");
                search.Text=""; level.SelectedIndex=0; RenderLogs(); pause.Checked=true;
                if(grid.Rows.Count!=3 || entries.Any(x=>x.Message.Contains("SECRET"))) throw new Exception("日志脱敏失败");
                using(var bitmap=new Bitmap(Width,Height)) { DrawToBitmap(bitmap,new Rectangle(0,0,Width,Height)); bitmap.Save(Path.Combine(smokePath,"native-logs-fixture.png")); }
                Ops.Export(Path.Combine(smokePath,"native-diagnostic-fixture.json.gz"),snapshot,entries,"");
                SelectWorkspace("points");points.SmokeFixture();
                using(var bitmap=new Bitmap(Width,Height)) { DrawToBitmap(bitmap,new Rectangle(0,0,Width,Height)); bitmap.Save(Path.Combine(smokePath,"native-points-fixture.png")); }
                tabs.SelectedIndex=0; timer.Stop(); var samples=new List<object>();
                TimeSpan cpu=Process.GetCurrentProcess().TotalProcessorTime; DateTime startTime=DateTime.UtcNow;
                for(int i=0;i<12;i++) { await Task.Delay(2500); RenderStatus(); var process=Process.GetCurrentProcess(); samples.Add(new {workingSetMiB=Math.Round(process.WorkingSet64/1048576.0,2),privateMiB=Math.Round(process.PrivateMemorySize64/1048576.0,2)}); }
                ClientSize=new Size(684,551);PerformLayout();
                using(var bitmap=new Bitmap(Width,Height)){DrawToBitmap(bitmap,new Rectangle(0,0,Width,Height));bitmap.Save(Path.Combine(smokePath,"native-overview-minimum.png"));}
                Scale(new SizeF(1.5F,1.5F));PerformLayout();
                using(var bitmap=new Bitmap(Width,Height)){DrawToBitmap(bitmap,new Rectangle(0,0,Width,Height));bitmap.Save(Path.Combine(smokePath,"native-overview-scaled.png"));}
                double cpuPercent=(Process.GetCurrentProcess().TotalProcessorTime-cpu).TotalMilliseconds/(DateTime.UtcNow-startTime).TotalMilliseconds/Environment.ProcessorCount*100;
                File.WriteAllText(Path.Combine(smokePath,"native-ui-result.json"),Ops.Serialize(new {success=true,ui="WinForms / .NET Framework",snapshot.Service,samples,cpuPercent=Math.Round(cpuPercent,3),fixtureLogs=true,fixtureOnly=true}),System.Text.Encoding.UTF8);
            } catch(Exception error) { File.WriteAllText(Path.Combine(smokePath,"native-ui-error.txt"),error.ToString()); }
            finally { Close(); }
        }
    }
}

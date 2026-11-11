using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace HeatTreatmentCollectorCenter
{
    internal sealed class RoundedSurface : Panel
    {
        internal RoundedSurface(){DoubleBuffered=true;BackColor=Color.Transparent;}
        protected override void OnPaintBackground(PaintEventArgs e){e.Graphics.Clear(Parent==null?Color.White:Parent.BackColor);}
        protected override void OnPaint(PaintEventArgs e){e.Graphics.SmoothingMode=System.Drawing.Drawing2D.SmoothingMode.AntiAlias;using(var path=new System.Drawing.Drawing2D.GraphicsPath()){int r=16,w=Width-1,h=Height-1;if(w<r||h<r)return;path.AddArc(0,0,r,r,180,90);path.AddArc(w-r,0,r,r,270,90);path.AddArc(w-r,h-r,r,r,0,90);path.AddArc(0,h-r,r,r,90,90);path.CloseFigure();e.Graphics.FillPath(Brushes.White,path);using(var pen=new Pen(Color.FromArgb(226,232,242)))e.Graphics.DrawPath(pen,path);}}
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
        internal SoftButton(){FlatStyle=FlatStyle.Flat;FlatAppearance.BorderColor=Color.FromArgb(217,226,239);SetStyle(ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|ControlStyles.OptimizedDoubleBuffer,true);}
        protected override void OnMouseEnter(EventArgs e){hover=true;Invalidate();base.OnMouseEnter(e);}
        protected override void OnMouseLeave(EventArgs e){hover=false;Invalidate();base.OnMouseLeave(e);}
        protected override void OnPaint(PaintEventArgs e){e.Graphics.Clear(Parent==null?Color.White:Parent.BackColor);e.Graphics.SmoothingMode=System.Drawing.Drawing2D.SmoothingMode.AntiAlias;int r=10,w=Width-1,h=Height-1;using(var path=new System.Drawing.Drawing2D.GraphicsPath()){path.AddArc(0,0,r,r,180,90);path.AddArc(w-r,0,r,r,270,90);path.AddArc(w-r,h-r,r,r,0,90);path.AddArc(0,h-r,r,r,90,90);path.CloseFigure();var color=!Enabled?Color.FromArgb(238,242,248):hover?(ForeColor==Color.White?Color.FromArgb(69,130,225):Color.FromArgb(235,242,254)):BackColor;using(var brush=new SolidBrush(color))e.Graphics.FillPath(brush,path);if(FlatAppearance.BorderSize>0)using(var pen=new Pen(Enabled?FlatAppearance.BorderColor:Color.FromArgb(225,231,239)))e.Graphics.DrawPath(pen,path);TextRenderer.DrawText(e.Graphics,Text,Font,ClientRectangle,Enabled?ForeColor:Color.FromArgb(151,162,179),TextFormatFlags.HorizontalCenter|TextFormatFlags.VerticalCenter|TextFormatFlags.SingleLine);}}
    }
    internal sealed class CenterForm : Form
    {
        readonly Label headline=new Label(), summary=new Label(), footer=new Label();
        readonly Button install=new SoftButton(), start=new SoftButton(), stop=new SoftButton(), restart=new SoftButton(), authorize=new SoftButton();
        readonly WorkspaceDeck tabs=new WorkspaceDeck();
        readonly DataGridView grid=new DataGridView();
        readonly ComboBox level=new ComboBox(), component=new ComboBox();
        readonly TextBox search=new TextBox();
        readonly CheckBox pause=new CheckBox();
        readonly System.Windows.Forms.Timer timer=new System.Windows.Forms.Timer { Interval=2000 };
        readonly Label[] values=new Label[4];
        readonly Label normalValue=new Label(),abnormalValue=new Label(),sampleValue=new Label(),modeLabel=new Label();
        readonly Button[] navigation=new Button[3];
        readonly PointPanel points;
        Snapshot snapshot=new Snapshot(); List<LogLine> entries=new List<LogLine>();
        bool refreshing,busy,protectedLogs,authorizedSnapshot; string logError="";
        readonly string smokePath;
        static readonly Color Green=Color.FromArgb(34,100,76), Muted=Color.FromArgb(108,119,116);

        internal CenterForm(string smoke)
        {
            smokePath=smoke; Text="采集运行中心"; Name="CollectorCenter";
            Font=new Font("Microsoft YaHei UI",9F); BackColor=Color.FromArgb(246,248,252);
            ClientSize=new Size(720,480); MinimumSize=new Size(700,470);
            StartPosition=FormStartPosition.CenterScreen; AutoScaleMode=AutoScaleMode.Dpi;
            if(smokePath!=null){Text="采集运行中心 · 界面测试";ShowInTaskbar=false;StartPosition=FormStartPosition.Manual;Location=new Point(-30000,-30000);}
            try { Icon=Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            var root=new TableLayoutPanel { Dock=DockStyle.Fill,Padding=new Padding(22,16,22,8),ColumnCount=1,RowCount=5 };
            foreach(int height in new[]{48,38,42})root.RowStyles.Add(new RowStyle(SizeType.Absolute,height));
            root.RowStyles.Add(new RowStyle(SizeType.Percent,100));root.RowStyles.Add(new RowStyle(SizeType.Absolute,26));
            var header=new TableLayoutPanel {Dock=DockStyle.Fill,ColumnCount=2,RowCount=1};header.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));header.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,110));
            header.Controls.Add(new Label {Text="数据采集",Font=new Font(Font.FontFamily,18F,FontStyle.Bold),Dock=DockStyle.Fill,TextAlign=ContentAlignment.MiddleLeft,ForeColor=Color.FromArgb(37,51,73)},0,0);
            modeLabel.Text="自动检测";modeLabel.Dock=DockStyle.Fill;modeLabel.TextAlign=ContentAlignment.MiddleRight;modeLabel.ForeColor=Muted;header.Controls.Add(modeLabel,1,0);root.Controls.Add(header,0,0);
            var buttons=new FlowLayoutPanel {Dock=DockStyle.Fill,WrapContents=false};
            Setup(install,"安装服务",async()=>await ServiceAction("install"));Setup(start,"启动",async()=>await ServiceAction("start"));Setup(stop,"停止",async()=>await ServiceAction("stop"));Setup(restart,"重启",async()=>await ServiceAction("restart"));
            start.BackColor=Color.FromArgb(56,116,216);start.ForeColor=Color.White;start.FlatAppearance.BorderSize=0;
            var more=new SoftButton();Setup(more,"更多 ···",async()=>await Task.FromResult(0));var menu=new ContextMenuStrip();
            menu.Items.Add("刷新状态",null,async(s,e)=>await RefreshAll());
            menu.Items.Add("后台配置说明",null,(s,e)=>MessageBox.Show(this,"请打开大屏软件的「后台管理」进行工程配置。\n\n本运行中心只管理独立采集服务和查看点位，不包含大屏或后台网页；关闭大屏不会停止采集。",Text,MessageBoxButtons.OK,MessageBoxIcon.Information));
            menu.Items.Add("导出诊断",null,async(s,e)=>{try{await Export();}catch(Exception error){MessageBox.Show(this,Ops.Redact(error.Message),Text);}});
            more.Click+=(s,e)=>menu.Show(more,new Point(0,more.Height));buttons.Controls.AddRange(new Control[]{install,start,stop,restart,more});root.Controls.Add(buttons,0,1);
            tabs.Dock=DockStyle.Fill;
            var nav=new FlowLayoutPanel {Dock=DockStyle.Fill,WrapContents=false,Padding=new Padding(0,2,0,0)};
            var titles=new[]{"概览","点位","日志"};
            for(int index=0;index<3;index++){int selected=index;var b=new SoftButton();Setup(b,titles[index],async()=>{tabs.SelectedIndex=selected;await Task.FromResult(0);});b.Width=82;navigation[index]=b;nav.Controls.Add(b);}root.Controls.Add(nav,0,2);
            var statusTab=new Panel(){BackColor=BackColor,Padding=new Padding(0)};
            var status=new TableLayoutPanel {Dock=DockStyle.Fill,ColumnCount=1,RowCount=3,Padding=new Padding(0,4,0,0)};
            status.RowStyles.Add(new RowStyle(SizeType.Absolute,56));status.RowStyles.Add(new RowStyle(SizeType.Absolute,88));status.RowStyles.Add(new RowStyle(SizeType.Percent,100));
            var hero=new Panel {Dock=DockStyle.Fill,BackColor=BackColor};headline.Text="正在检测采集进程…";headline.Font=new Font(Font.FontFamily,14F,FontStyle.Bold);headline.Dock=DockStyle.Top;headline.Height=29;headline.ForeColor=Green;
            summary.Dock=DockStyle.Bottom;summary.Height=22;summary.ForeColor=Muted;summary.AutoEllipsis=true;hero.Controls.Add(headline);hero.Controls.Add(summary);status.Controls.Add(hero,0,0);
            var cards=new TableLayoutPanel {Dock=DockStyle.Fill,ColumnCount=3,RowCount=1};for(int n=0;n<3;n++)cards.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,33.333f));
            Label[] metrics={normalValue,abnormalValue,sampleValue};string[] captions={"正常设备","异常设备","最近采样"};
            for(int n=0;n<3;n++){var card=new RoundedSurface {Dock=DockStyle.Fill,Padding=new Padding(16,10,12,8),Margin=new Padding(0,0,n==2?0:10,6)};
                var label=new Label {Text=captions[n],Dock=DockStyle.Top,Height=22,ForeColor=Muted,BackColor=Color.White};metrics[n].Text="—";metrics[n].Dock=DockStyle.Bottom;metrics[n].Height=29;metrics[n].Font=new Font(Font.FontFamily,n==2?14F:20F,FontStyle.Bold);metrics[n].ForeColor=Color.FromArgb(49,69,97);metrics[n].BackColor=Color.White;var content=new TableLayoutPanel {Dock=DockStyle.Fill,ColumnCount=1,RowCount=2,BackColor=Color.White,Margin=Padding.Empty};content.RowStyles.Add(new RowStyle(SizeType.Absolute,20));content.RowStyles.Add(new RowStyle(SizeType.Percent,100));label.Dock=DockStyle.Fill;label.Margin=Padding.Empty;metrics[n].Dock=DockStyle.Fill;metrics[n].TextAlign=ContentAlignment.MiddleLeft;metrics[n].Margin=Padding.Empty;content.Controls.Add(label,0,0);content.Controls.Add(metrics[n],0,1);card.Controls.Add(content);cards.Controls.Add(card,n,0);}status.Controls.Add(cards,0,1);
            var table=new TableLayoutPanel {Dock=DockStyle.Top,Height=112,ColumnCount=4,RowCount=2,Padding=new Padding(0,8,0,0)};
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,88));table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,50));table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,88));table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,50));
            string[] names={"开机服务","采集进程","数据库","数据来源"};
            for(int n=0;n<4;n++){int row=n/2,col=n%2*2;table.Controls.Add(new Label {Text=names[n],Dock=DockStyle.Fill,ForeColor=Muted,TextAlign=ContentAlignment.MiddleLeft},col,row);values[n]=new Label {Text="—",Dock=DockStyle.Fill,AutoEllipsis=true,TextAlign=ContentAlignment.MiddleLeft,ForeColor=Color.FromArgb(63,78,99)};table.Controls.Add(values[n],col+1,row);}status.Controls.Add(table,0,2);statusTab.Controls.Add(status);tabs.TabPages.Add(statusTab);
            points=new PointPanel(()=>snapshot);var pointTab=new Panel(){BackColor=Color.White};pointTab.Controls.Add(points);tabs.TabPages.Add(pointTab);
            var logTab=new Panel(){BackColor=Color.White,Padding=new Padding(8)};
            var logLayout=new TableLayoutPanel {Dock=DockStyle.Fill,RowCount=2,ColumnCount=1};logLayout.RowStyles.Add(new RowStyle(SizeType.Absolute,38));logLayout.RowStyles.Add(new RowStyle(SizeType.Percent,100));
            var filters=new FlowLayoutPanel {Dock=DockStyle.Fill,WrapContents=false};level.DropDownStyle=ComboBoxStyle.DropDownList;level.Items.AddRange(new object[]{"全部日志","警告/错误","错误","信息"});level.SelectedIndex=0;level.Width=100;
            component.DropDownStyle=ComboBoxStyle.DropDownList;component.Items.Add("全部组件");component.SelectedIndex=0;search.Width=180;search.AccessibleName="搜索日志";pause.Text="暂停";pause.AutoSize=true;pause.Padding=new Padding(0,4,0,0);
            Setup(authorize,"授权读取",async()=>await ReadLogs(true));authorize.Visible=false;
            var copy=new SoftButton();Setup(copy,"复制",async()=>{string text=string.Join(Environment.NewLine,Filtered().Select(x=>x.Message).ToArray());if(text.Length>0)Clipboard.SetText(text);await Task.FromResult(0);});copy.Width=58;
            filters.Controls.AddRange(new Control[]{level,search,pause,authorize,copy});
            grid.Dock=DockStyle.Fill;grid.ReadOnly=true;grid.AllowUserToAddRows=false;grid.AllowUserToDeleteRows=false;grid.RowHeadersVisible=false;grid.BackgroundColor=Color.White;grid.BorderStyle=BorderStyle.None;grid.SelectionMode=DataGridViewSelectionMode.FullRowSelect;grid.AutoSizeRowsMode=DataGridViewAutoSizeRowsMode.None;grid.RowTemplate.Height=27;grid.EnableHeadersVisualStyles=false;
            grid.ColumnHeadersDefaultCellStyle.BackColor=Color.FromArgb(244,247,251);grid.ColumnHeadersDefaultCellStyle.ForeColor=Muted;grid.GridColor=Color.FromArgb(235,239,245);grid.DefaultCellStyle.SelectionBackColor=Color.FromArgb(232,241,255);grid.DefaultCellStyle.SelectionForeColor=Color.FromArgb(37,61,90);
            grid.ColumnHeadersBorderStyle=DataGridViewHeaderBorderStyle.None;grid.CellBorderStyle=DataGridViewCellBorderStyle.SingleHorizontal;grid.Columns.Add("time","时间");grid.Columns.Add("level","级别");grid.Columns.Add("message","内容");grid.Columns[0].Width=112;grid.Columns[1].Width=65;grid.Columns[2].AutoSizeMode=DataGridViewAutoSizeColumnMode.Fill;
            logLayout.Controls.Add(filters,0,0);logLayout.Controls.Add(grid,0,1);logTab.Controls.Add(logLayout);tabs.TabPages.Add(logTab);
            level.SelectedIndexChanged+=(s,e)=>RenderLogs();search.TextChanged+=(s,e)=>RenderLogs();
            tabs.SelectedIndexChanged+=async(s,e)=>{for(int n=0;n<navigation.Length;n++){navigation[n].BackColor=n==tabs.SelectedIndex?Color.White:BackColor;navigation[n].ForeColor=n==tabs.SelectedIndex?Color.FromArgb(47,106,200):Muted;}if(tabs.SelectedIndex==2)await ReadLogs(false);if(tabs.SelectedIndex==1)await points.RefreshPoints();};
            tabs.SelectedIndex=0;navigation[0].BackColor=Color.White;navigation[0].ForeColor=Color.FromArgb(47,106,200);
            root.Controls.Add(tabs,0,3);footer.Dock=DockStyle.Fill;footer.TextAlign=ContentAlignment.BottomLeft;footer.ForeColor=Muted;root.Controls.Add(footer,0,4);Controls.Add(root);
            timer.Tick+=async(s,e)=>await RefreshAll();Shown+=async(s,e)=>{await RefreshAll();timer.Start();if(smokePath!=null)await Smoke();};FormClosed+=(s,e)=>{timer.Dispose();menu.Dispose();};
        }
        void Setup(Button button,string caption,Func<Task> action)
        {
            button.Text=caption; button.AutoSize=false; button.Size=new Size(76,29); button.Margin=new Padding(0,0,6,0);
            button.FlatStyle=FlatStyle.Flat;button.BackColor=Color.White;button.ForeColor=Color.FromArgb(66,89,122);button.FlatAppearance.BorderColor=Color.FromArgb(217,226,239);button.FlatAppearance.MouseOverBackColor=Color.FromArgb(235,242,254);
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
            headline.ForeColor=snapshot.Healthy?Green:Color.FromArgb(145,114,68);modeLabel.Text=snapshot.Api=="可达"?snapshot.Mode:"未连接";
            string[] text={snapshot.Service,snapshot.Process,snapshot.Database,snapshot.Mode};for(int n=0;n<values.Length;n++)values[n].Text=text[n];
            normalValue.Text=snapshot.Normal<0?"—":snapshot.Normal.ToString();abnormalValue.Text=snapshot.Abnormal<0?"—":snapshot.Abnormal.ToString();abnormalValue.ForeColor=snapshot.Abnormal>0?Color.FromArgb(185,92,73):Color.FromArgb(49,69,97);sampleValue.Text=snapshot.Collection;
            summary.Text=snapshot.Error;
            bool pending=snapshot.Installed && snapshot.Service!="已停止" && !snapshot.Running;
            install.Visible=!snapshot.Installed; install.Enabled=!busy && snapshot.Service!="无法查询" && snapshot.RuntimeReady;
            start.Enabled=!busy && snapshot.Installed && snapshot.Service=="已停止";
            stop.Enabled=!busy && snapshot.Running; restart.Enabled=!busy && snapshot.Installed && !pending;
            footer.Text=snapshot.CheckedAt.ToString("HH:mm:ss")+" 更新  ·  "+(snapshot.Installed?"范围：本机全部工厂 · 关闭窗口不停止服务":"服务未安装，不会使用大屏内采集进程");
        }
        async Task ServiceAction(string action)
        {
            if(busy) return;
            if(action=="install" && !snapshot.RuntimeReady) throw new InvalidOperationException("需要完整的独立采集运行中心安装包；不能从大屏资源目录安装服务。");
            string caption=action=="install" ? "安装并启动服务" : action=="start" ? "启动服务" : action=="stop" ? "停止服务" : "重启服务";
            string detail=action=="install" ? "将采集程序安装到独立目录。首次安装需先保存并退出大屏，再导入当前工程；原数据保留。需要管理员授权。" : action=="stop" || action=="restart" ? "将影响所有设备采集。需要管理员授权。" : "需要管理员授权。";
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
                if(entry.Level=="ERROR") grid.Rows[row].DefaultCellStyle.ForeColor=Color.Firebrick;
                else if(entry.Level=="WARN") grid.Rows[row].DefaultCellStyle.ForeColor=Color.DarkGoldenrod;
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
                snapshot=Ops.Summarize(new Snapshot {Installed=true,Running=true,Service="运行中"},fixture,DateTime.UtcNow);RenderStatus();
                using(var bitmap=new Bitmap(Width,Height)) { DrawToBitmap(bitmap,new Rectangle(0,0,Width,Height)); bitmap.Save(Path.Combine(smokePath,"native-overview-fixture.png")); }
                tabs.SelectedIndex=2; await Task.Delay(500);
                entries=Ops.ParseLogs(new[]{new KeyValuePair<string,string>("backend.log","[2026-10-30T12:00:00Z] 中文警告 <script>alert(1)</script>\n[2026-10-30T12:00:01Z] password=SECRET 连接失败\n[2026-10-30T12:00:02Z] Ready")});
                level.SelectedIndex=1; search.Text="中文"; RenderLogs();
                if(grid.Rows.Count!=1) throw new Exception("日志筛选失败");
                search.Text=""; level.SelectedIndex=0; RenderLogs(); pause.Checked=true;
                if(grid.Rows.Count!=3 || entries.Any(x=>x.Message.Contains("SECRET"))) throw new Exception("日志脱敏失败");
                using(var bitmap=new Bitmap(Width,Height)) { DrawToBitmap(bitmap,new Rectangle(0,0,Width,Height)); bitmap.Save(Path.Combine(smokePath,"native-logs-fixture.png")); }
                Ops.Export(Path.Combine(smokePath,"native-diagnostic-fixture.json.gz"),snapshot,entries,"");
                tabs.SelectedIndex=1;points.SmokeFixture();
                using(var bitmap=new Bitmap(Width,Height)) { DrawToBitmap(bitmap,new Rectangle(0,0,Width,Height)); bitmap.Save(Path.Combine(smokePath,"native-points-fixture.png")); }
                tabs.SelectedIndex=0; timer.Stop(); var samples=new List<object>();
                TimeSpan cpu=Process.GetCurrentProcess().TotalProcessorTime; DateTime startTime=DateTime.UtcNow;
                for(int i=0;i<12;i++) { await Task.Delay(2500); await RefreshAll(); var process=Process.GetCurrentProcess(); samples.Add(new {workingSetMiB=Math.Round(process.WorkingSet64/1048576.0,2),privateMiB=Math.Round(process.PrivateMemorySize64/1048576.0,2)}); }
                double cpuPercent=(Process.GetCurrentProcess().TotalProcessorTime-cpu).TotalMilliseconds/(DateTime.UtcNow-startTime).TotalMilliseconds/Environment.ProcessorCount*100;
                File.WriteAllText(Path.Combine(smokePath,"native-ui-result.json"),Ops.Serialize(new {success=true,ui="WinForms / .NET Framework",snapshot.Service,samples,cpuPercent=Math.Round(cpuPercent,3),fixtureLogs=true}),System.Text.Encoding.UTF8);
            } catch(Exception error) { File.WriteAllText(Path.Combine(smokePath,"native-ui-error.txt"),error.ToString()); }
            finally { Close(); }
        }
    }
}

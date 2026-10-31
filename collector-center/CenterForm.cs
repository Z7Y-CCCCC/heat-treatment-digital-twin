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
    internal sealed class CenterForm : Form
    {
        readonly Label headline=new Label(), summary=new Label(), footer=new Label();
        readonly Button install=new Button(), start=new Button(), stop=new Button(), restart=new Button(), authorize=new Button();
        readonly TabControl tabs=new TabControl();
        readonly DataGridView grid=new DataGridView();
        readonly ComboBox level=new ComboBox(), component=new ComboBox();
        readonly TextBox search=new TextBox();
        readonly CheckBox pause=new CheckBox();
        readonly System.Windows.Forms.Timer timer=new System.Windows.Forms.Timer { Interval=5000 };
        readonly Label[] values=new Label[6];
        readonly PointPanel points;
        Snapshot snapshot=new Snapshot(); List<LogLine> entries=new List<LogLine>();
        bool refreshing,busy,protectedLogs,authorizedSnapshot; string logError="";
        readonly string smokePath;
        static readonly Color Green=Color.FromArgb(34,100,76), Muted=Color.FromArgb(108,119,116);

        internal CenterForm(string smoke)
        {
            smokePath=smoke; Text="采集运行中心"; Name="CollectorCenter";
            Font=new Font("Microsoft YaHei UI",9F); BackColor=Color.White;
            ClientSize=new Size(700,440); MinimumSize=new Size(660,430);
            StartPosition=FormStartPosition.CenterScreen; AutoScaleMode=AutoScaleMode.Dpi;
            try { Icon=Icon.ExtractAssociatedIcon(Application.ExecutablePath); } catch { }
            var root=new TableLayoutPanel { Dock=DockStyle.Fill,Padding=new Padding(18,12,18,8),ColumnCount=1,RowCount=4 };
            root.RowStyles.Add(new RowStyle(SizeType.Absolute,42)); root.RowStyles.Add(new RowStyle(SizeType.Absolute,42));
            root.RowStyles.Add(new RowStyle(SizeType.Percent,100)); root.RowStyles.Add(new RowStyle(SizeType.Absolute,26));
            headline.Text="正在检查…"; headline.Font=new Font(Font.FontFamily,14F,FontStyle.Bold); headline.Dock=DockStyle.Fill; headline.TextAlign=ContentAlignment.MiddleLeft;
            root.Controls.Add(headline,0,0);
            var buttons=new FlowLayoutPanel { Dock=DockStyle.Fill,WrapContents=false,AutoSize=false };
            Setup(install,"安装服务",async()=>await ServiceAction("install")); Setup(start,"启动",async()=>await ServiceAction("start"));
            Setup(stop,"停止",async()=>await ServiceAction("stop")); Setup(restart,"重启",async()=>await ServiceAction("restart"));
            var refresh=new Button(); Setup(refresh,"刷新",async()=>await RefreshAll());
            var admin=new Button(); Setup(admin,"管理后台",async()=>{ if(snapshot.Api!="可达") throw new Exception("管理接口不可达"); Process.Start(new ProcessStartInfo(snapshot.Origin+"/admin") { UseShellExecute=true }); await Task.FromResult(0); });
            var export=new Button(); Setup(export,"导出诊断",async()=>await Export());
            buttons.Controls.AddRange(new Control[]{install,start,stop,restart,refresh,admin,export}); root.Controls.Add(buttons,0,1);
            tabs.Dock=DockStyle.Fill;
            var statusTab=new TabPage("状态") { BackColor=Color.White,Padding=new Padding(14) };
            var table=new TableLayoutPanel { Dock=DockStyle.Fill,ColumnCount=2,RowCount=7 };
            table.ColumnStyles.Add(new ColumnStyle(SizeType.Absolute,110)); table.ColumnStyles.Add(new ColumnStyle(SizeType.Percent,100));
            var names=new[]{"Windows 服务","管理接口","数据库","数据模式","最近采样","采集进程"};
            for(int i=0;i<names.Length;i++) {
                table.RowStyles.Add(new RowStyle(SizeType.Absolute,32));
                table.Controls.Add(new Label { Text=names[i],Dock=DockStyle.Fill,ForeColor=Muted,TextAlign=ContentAlignment.MiddleLeft },0,i);
                values[i]=new Label { Text="—",Dock=DockStyle.Fill,TextAlign=ContentAlignment.MiddleLeft,AutoEllipsis=true };
                table.Controls.Add(values[i],1,i);
            }
            table.RowStyles.Add(new RowStyle(SizeType.Percent,100)); summary.Dock=DockStyle.Fill; summary.ForeColor=Muted; summary.AutoEllipsis=true;
            table.Controls.Add(summary,0,6); table.SetColumnSpan(summary,2); statusTab.Controls.Add(table); tabs.TabPages.Add(statusTab);
            var logTab=new TabPage("日志") { BackColor=Color.White,Padding=new Padding(6) };
            var logLayout=new TableLayoutPanel { Dock=DockStyle.Fill,RowCount=2,ColumnCount=1 };
            logLayout.RowStyles.Add(new RowStyle(SizeType.Absolute,38)); logLayout.RowStyles.Add(new RowStyle(SizeType.Percent,100));
            var filters=new FlowLayoutPanel { Dock=DockStyle.Fill,WrapContents=false };
            level.DropDownStyle=ComboBoxStyle.DropDownList; level.Items.AddRange(new object[]{"全部","警告/错误","错误","信息"}); level.SelectedIndex=0; level.Width=84;
            component.DropDownStyle=ComboBoxStyle.DropDownList; component.Items.AddRange(new object[]{"全部组件","服务宿主","后台采集","后台错误","服务操作"}); component.SelectedIndex=0; component.Width=94;
            search.Width=120; search.AccessibleName="搜索日志";
            pause.Text="暂停"; pause.AutoSize=true; pause.Padding=new Padding(0,4,0,0);
            Setup(authorize,"授权读取",async()=>await ReadLogs(true)); authorize.Visible=false;
            var copy=new Button(); Setup(copy,"复制",async()=>{ string text=string.Join(Environment.NewLine,Filtered().Select(x=>x.Message).ToArray()); if(text.Length>0) Clipboard.SetText(text); await Task.FromResult(0); }); copy.Width=58;
            filters.Controls.AddRange(new Control[]{level,component,search,pause,authorize,copy});
            grid.Dock=DockStyle.Fill; grid.ReadOnly=true; grid.AllowUserToAddRows=false; grid.AllowUserToDeleteRows=false;
            grid.RowHeadersVisible=false; grid.BackgroundColor=Color.White; grid.BorderStyle=BorderStyle.FixedSingle; grid.SelectionMode=DataGridViewSelectionMode.FullRowSelect;
            grid.AutoSizeRowsMode=DataGridViewAutoSizeRowsMode.None; grid.RowTemplate.Height=25;
            grid.Columns.Add("time","时间"); grid.Columns.Add("level","级别"); grid.Columns.Add("message","内容");
            grid.Columns[0].Width=112; grid.Columns[1].Width=65; grid.Columns[2].AutoSizeMode=DataGridViewAutoSizeColumnMode.Fill;
            logLayout.Controls.Add(filters,0,0); logLayout.Controls.Add(grid,0,1); logTab.Controls.Add(logLayout); tabs.TabPages.Add(logTab);
            level.SelectedIndexChanged+=(s,e)=>RenderLogs(); component.SelectedIndexChanged+=(s,e)=>RenderLogs(); search.TextChanged+=(s,e)=>RenderLogs();
            tabs.SelectedIndexChanged+=async(s,e)=>{ if(tabs.SelectedIndex==1) await ReadLogs(false); };
            points=new PointPanel(()=>snapshot);var pointsTab=new TabPage("点位") {BackColor=Color.White};pointsTab.Controls.Add(points);tabs.TabPages.Add(pointsTab);
            tabs.SelectedIndexChanged+=async(s,e)=>{if(tabs.SelectedIndex==2)await points.RefreshPoints();};
            root.Controls.Add(tabs,0,2); footer.Dock=DockStyle.Fill; footer.TextAlign=ContentAlignment.BottomLeft; footer.ForeColor=Muted; root.Controls.Add(footer,0,3);
            Controls.Add(root); timer.Tick+=async(s,e)=>await RefreshAll();
            Shown+=async(s,e)=>{ await RefreshAll(); timer.Start(); if(smokePath!=null) await Smoke(); };
            FormClosed+=(s,e)=>timer.Dispose();
        }
        void Setup(Button button,string caption,Func<Task> action)
        {
            button.Text=caption; button.AutoSize=false; button.Size=new Size(76,29); button.Margin=new Padding(0,0,6,0);
            button.FlatStyle=FlatStyle.System;
            button.Click+=async(s,e)=>{ try { await action(); } catch(Exception error) { if(!IsDisposed) MessageBox.Show(this,Ops.Redact(error.Message),Text,MessageBoxButtons.OK,MessageBoxIcon.Warning); } };
        }
        async Task RefreshAll()
        {
            if(refreshing || IsDisposed) return; refreshing=true;
            try { snapshot=await Ops.Status(); if(IsDisposed) return; RenderStatus();
                if(tabs.SelectedIndex==1 && !pause.Checked && !protectedLogs && !busy) await ReadLogs(false);
                if(tabs.SelectedIndex==2 && !busy)await points.RefreshPoints(); }
            finally { refreshing=false; }
        }
        void RenderStatus()
        {
            headline.Text=!snapshot.Installed ? snapshot.Service=="无法查询" ? "无法查询服务" : "采集服务未安装" : !snapshot.Running ? "采集服务"+snapshot.Service : snapshot.Healthy ? "采集正常" : "采集需检查";
            headline.ForeColor=snapshot.Healthy ? Green : Color.FromArgb(125,90,44);
            string[] text={snapshot.Service,snapshot.Api,snapshot.Database,snapshot.Mode,snapshot.Collection,snapshot.Process};
            for(int i=0;i<values.Length;i++) values[i].Text=text[i];
            values[3].ForeColor=snapshot.Mode.Contains("模拟") ? Color.DarkGoldenrod : ForeColor;
            summary.Text=snapshot.Error;
            bool pending=snapshot.Installed && snapshot.Service!="已停止" && !snapshot.Running;
            install.Visible=!snapshot.Installed; install.Enabled=!busy && snapshot.Service!="无法查询";
            start.Enabled=!busy && snapshot.Installed && snapshot.Service=="已停止";
            stop.Enabled=!busy && snapshot.Running; restart.Enabled=!busy && snapshot.Installed && !pending;
            footer.Text=snapshot.CheckedAt.ToString("HH:mm:ss")+" 更新  ·  关闭窗口不影响采集";
        }
        async Task ServiceAction(string action)
        {
            if(busy) return;
            string caption=action=="install" ? "安装并启动服务" : action=="start" ? "启动服务" : action=="stop" ? "停止服务" : "重启服务";
            string detail=action=="install" ? "安装开机采集服务，使用独立数据目录。需要管理员授权。" : action=="stop" || action=="restart" ? "将影响所有设备采集。需要管理员授权。" : "需要管理员授权。";
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
                tabs.SelectedIndex=1; await Task.Delay(500);
                entries=Ops.ParseLogs(new[]{new KeyValuePair<string,string>("backend.log","[2026-10-30T12:00:00Z] 中文警告 <script>alert(1)</script>\n[2026-10-30T12:00:01Z] password=SECRET 连接失败\n[2026-10-30T12:00:02Z] Ready")});
                level.SelectedIndex=1; search.Text="中文"; RenderLogs();
                if(grid.Rows.Count!=1) throw new Exception("日志筛选失败");
                search.Text=""; level.SelectedIndex=0; RenderLogs(); pause.Checked=true;
                if(grid.Rows.Count!=3 || entries.Any(x=>x.Message.Contains("SECRET"))) throw new Exception("日志脱敏失败");
                using(var bitmap=new Bitmap(Width,Height)) { DrawToBitmap(bitmap,new Rectangle(0,0,Width,Height)); bitmap.Save(Path.Combine(smokePath,"native-logs-fixture.png")); }
                Ops.Export(Path.Combine(smokePath,"native-diagnostic-fixture.json.gz"),snapshot,entries,"");
                tabs.SelectedIndex=2;points.SmokeFixture();
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

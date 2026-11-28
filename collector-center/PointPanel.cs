using System;
using System.Collections.Generic;
using System.Drawing;
using System.Linq;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace HeatTreatmentCollectorCenter
{
    internal sealed class PointPanel : UserControl
    {
        readonly Func<Snapshot> status;
        readonly ComboBox factories=new ComboBox(),devices=new ComboBox();
        readonly TextBox search=new TextBox();
        readonly Button login=new SoftButton();
        readonly Label info=new Label();
        readonly DataGridView grid=new DataGridView();
        PointClient client;
        List<PointRow> rows=new List<PointRow>(),visible=new List<PointRow>();
        bool loading,updating;
        int generation;
        internal PointPanel(Func<Snapshot> getStatus)
        {
            status=getStatus; Dock=DockStyle.Fill; BackColor=Color.FromArgb(244,244,246); Padding=new Padding(0,4,0,4);
            var card=new RoundedSurface { Dock=DockStyle.Fill,Padding=new Padding(14,10,14,10) };
            var layout=new TableLayoutPanel { Dock=DockStyle.Fill,ColumnCount=1,RowCount=3,BackColor=Color.White,Margin=Padding.Empty };
            layout.RowStyles.Add(new RowStyle(SizeType.Absolute,36)); layout.RowStyles.Add(new RowStyle(SizeType.Absolute,34));layout.RowStyles.Add(new RowStyle(SizeType.Percent,100));
            var bar=new FlowLayoutPanel { Dock=DockStyle.Fill,WrapContents=false,BackColor=Color.White,Padding=new Padding(0,2,0,0),Margin=Padding.Empty };
            factories.DropDownStyle=ComboBoxStyle.DropDownList; factories.Width=155; factories.AccessibleName="工厂"; factories.Margin=new Padding(0,2,8,0);
            devices.DropDownStyle=ComboBoxStyle.DropDownList; devices.Width=145; devices.AccessibleName="设备"; devices.Margin=new Padding(0,2,8,0);
            var searchWrap=new RoundedSurface { SurfaceColor=Color.White,BorderColor=Color.FromArgb(214,214,222),CornerRadius=8,Size=new Size(146,27),Padding=new Padding(9,5,9,3),Margin=new Padding(0,1,8,0) };
            search.BorderStyle=BorderStyle.None;search.Dock=DockStyle.Fill;search.BackColor=Color.White;search.ForeColor=Color.FromArgb(28,28,33);search.AccessibleName="搜索点位";RoundedSurface.SetHint(search,"搜索点位 / 地址…");searchWrap.Controls.Add(search);
            login.Text="登录后台";login.Size=new Size(84,27);login.Margin=new Padding(0,1,0,0);login.BackColor=Color.FromArgb(79,70,229);login.ForeColor=Color.White;login.FlatAppearance.BorderSize=0;login.Click+=async(s,e)=>await SignIn();
            bar.Controls.AddRange(new Control[]{factories,devices,searchWrap,login});layout.Controls.Add(bar,0,0);
            var infoPill=new RoundedSurface { Dock=DockStyle.Fill,SurfaceColor=Color.FromArgb(249,249,251),BorderColor=Color.FromArgb(228,228,234),CornerRadius=8,Padding=new Padding(10,0,10,0),Margin=new Padding(0,2,0,4) };
            info.Text="点位使用后台账号权限";info.ForeColor=Color.FromArgb(75,75,83);info.Font=new Font("Microsoft YaHei UI",8.5F);info.BackColor=infoPill.SurfaceColor;info.Dock=DockStyle.Fill;info.TextAlign=ContentAlignment.MiddleLeft;info.AutoEllipsis=true;infoPill.Controls.Add(info);layout.Controls.Add(infoPill,0,1);
            grid.Dock=DockStyle.Fill;grid.Margin=new Padding(0,4,0,0);grid.ReadOnly=true;grid.VirtualMode=true;grid.AllowUserToAddRows=false;grid.AllowUserToDeleteRows=false;
            grid.RowHeadersVisible=false;grid.BackgroundColor=Color.White;grid.BorderStyle=BorderStyle.None;grid.SelectionMode=DataGridViewSelectionMode.FullRowSelect;
            grid.EnableHeadersVisualStyles=false;grid.ColumnHeadersHeight=32;grid.ColumnHeadersHeightSizeMode=DataGridViewColumnHeadersHeightSizeMode.DisableResizing;
            grid.ColumnHeadersDefaultCellStyle.BackColor=Color.FromArgb(249,249,251);grid.ColumnHeadersDefaultCellStyle.ForeColor=Color.FromArgb(133,133,141);grid.ColumnHeadersDefaultCellStyle.Font=new Font("Microsoft YaHei UI",8.5F,FontStyle.Bold);grid.ColumnHeadersDefaultCellStyle.Padding=new Padding(6,0,6,0);
            grid.GridColor=Color.FromArgb(236,236,240);grid.DefaultCellStyle.ForeColor=Color.FromArgb(28,28,33);grid.DefaultCellStyle.Padding=new Padding(6,0,6,0);grid.DefaultCellStyle.SelectionBackColor=Color.FromArgb(238,237,253);grid.DefaultCellStyle.SelectionForeColor=Color.FromArgb(55,48,163);grid.RowTemplate.Height=29;
            foreach(var column in new[]{"点位","地址","类型","当前值","单位","质量","更新时间"}) grid.Columns.Add(column,column);
            grid.ColumnHeadersBorderStyle=DataGridViewHeaderBorderStyle.None;grid.CellBorderStyle=DataGridViewCellBorderStyle.SingleHorizontal;grid.Columns[0].Width=125;grid.Columns[1].Width=145;grid.Columns[2].Width=60;grid.Columns[3].Width=82;grid.Columns[4].Width=52;grid.Columns[5].Width=55;grid.Columns[6].AutoSizeMode=DataGridViewAutoSizeColumnMode.Fill;grid.Columns[6].MinimumWidth=90;
            grid.CellValueNeeded+=(s,e)=>{ if(e.RowIndex>=visible.Count)return;var p=visible[e.RowIndex]; e.Value=new[]{p.Name,p.Address,p.Type,p.Value,p.Unit,p.Quality,p.Time}[e.ColumnIndex]; };
            layout.Controls.Add(grid,0,2);card.Controls.Add(layout);Controls.Add(card);
            factories.SelectedIndexChanged+=async(s,e)=>{ if(!updating){generation++;rows.Clear();Filter();info.Text="读取中…";await RefreshPoints();} };
            devices.SelectedIndexChanged+=async(s,e)=>{ if(!updating){generation++;rows.Clear();Filter();info.Text="读取中…";await RefreshPoints();} };
            search.TextChanged+=(s,e)=>Filter();
            Disposed+=(s,e)=>{generation++;if(client!=null)client.Dispose();};
        }
        void Filter()
        {
            string query=search.Text;
            visible=rows.Where(p=>query=="" || p.Name.IndexOf(query,StringComparison.OrdinalIgnoreCase)>=0 || p.Address.IndexOf(query,StringComparison.OrdinalIgnoreCase)>=0).ToList();
            grid.RowCount=visible.Count;grid.Invalidate();
        }
        static string Selected(ComboBox box) { var choice=box.SelectedItem as Choice;return choice==null ? "" : choice.Id; }
        void Fill(ComboBox box,IEnumerable<Choice> choices,string selected)
        {
            box.Items.Clear(); foreach(var choice in choices)box.Items.Add(choice);
            int index=box.Items.Cast<Choice>().ToList().FindIndex(c=>c.Id==selected);box.SelectedIndex=index<0 && box.Items.Count>0 ? 0 : index;
        }
        void SetLoginButton(bool signedIn)
        {
            login.Text=signedIn?"退出":"登录后台";
            login.BackColor=signedIn?Color.White:Color.FromArgb(79,70,229);
            login.ForeColor=signedIn?Color.FromArgb(28,28,33):Color.White;
            login.FlatAppearance.BorderSize=signedIn?1:0;
        }
        async Task SignIn()
        {
            if(loading)return;
            if(client!=null && client.LoggedIn) {
                generation++;var previous=client;client=null;rows.Clear();Filter();SetLoginButton(false);
                try {await previous.Logout();}catch{}finally{previous.Dispose();}info.Text="已退出";return;
            }
            var current=status();if(current.Api!="可达"){info.Text="请先启动后台服务";return;}
            using(var dialog=new Form {Text="后台登录",ClientSize=new Size(336,168),BackColor=Color.FromArgb(244,244,246),Font=new Font("Microsoft YaHei UI",9F),FormBorderStyle=FormBorderStyle.FixedDialog,StartPosition=FormStartPosition.CenterParent,MaximizeBox=false,MinimizeBox=false}) {
                var box=new RoundedSurface {Left=14,Top=12,Width=308,Height=142,Padding=new Padding(14)};
                var username=new TextBox {Left=68,Top=18,Width=220,MaxLength=80,BorderStyle=BorderStyle.FixedSingle};var password=new TextBox {Left=68,Top=53,Width=220,UseSystemPasswordChar=true,MaxLength=512,BorderStyle=BorderStyle.FixedSingle};
                var submit=new SoftButton {Text="登录",Left=208,Top=95,Width=80,Height=29,BackColor=Color.FromArgb(79,70,229),ForeColor=Color.White};submit.FlatAppearance.BorderSize=0;
                box.Controls.AddRange(new Control[]{new Label {Text="账号",Left=18,Top=21,Width=44,ForeColor=Color.FromArgb(75,75,83),BackColor=Color.White},username,new Label {Text="密码",Left=18,Top=56,Width=44,ForeColor=Color.FromArgb(75,75,83),BackColor=Color.White},password,submit});
                dialog.Controls.Add(box);dialog.AcceptButton=submit;
                submit.Click+=async(s,e)=>{
                    submit.Enabled=false;
                    var next=new PointClient(current.Origin);
                    try {await next.Login(username.Text,password.Text);if(dialog.IsDisposed){next.Dispose();return;}password.Clear();if(client!=null)client.Dispose();client=next;dialog.DialogResult=DialogResult.OK;dialog.Close();}
                    catch(Exception error){next.Dispose();if(!dialog.IsDisposed){password.Clear();MessageBox.Show(dialog,Ops.Redact(error.Message),"登录失败",MessageBoxButtons.OK,MessageBoxIcon.Warning);submit.Enabled=true;}}
                };
                if(dialog.ShowDialog(FindForm())==DialogResult.OK){SetLoginButton(true);generation++;await RefreshPoints();}
            }
        }
        internal async Task RefreshPoints()
        {
            if(loading || IsDisposed || client==null || !client.LoggedIn)return;
            loading=true;int version=generation;var active=client;
            string selectedFactory=Selected(factories),selectedDevice=Selected(devices);
            try {
                if(status().Api!="可达")throw new Exception("后台连接中断");
                if(active.Origin!=status().Origin)throw new Exception("服务地址已改变，请重新登录");
                var factoryData=await active.Factories();
                // Map visibility is independent of collection and point lookup.
                var list=Ops.Items(Ops.Get(factoryData,"factories")).ToArray();
                if(selectedFactory!="" && !list.Any(f=>Ops.Str(f,"id")==selectedFactory))selectedFactory="";
                var activeName=list.FirstOrDefault(f=>Ops.Str(f,"id")==Ops.Str(factoryData,"activeFactoryId"));
                var deviceData=await active.Devices(selectedFactory);
                var deviceList=Ops.Items(deviceData).ToArray();
                if(!deviceList.Any(d=>Ops.Str(d,"id")==selectedDevice))selectedDevice=deviceList.Length>0 ? Ops.Str(deviceList[0],"id") : "";
                object pointData=deviceList.Length>0 ? await active.Points(selectedFactory,selectedDevice) : Ops.Parse("{\"points\":[]}");
                if(IsDisposed || version!=generation || active!=client)return;
                updating=true;
                Fill(factories,new[]{new Choice {Id="",Name="跟随后台 · "+Ops.Str(activeName,"name")}}.Concat(list.Select(f=>new Choice {Id=Ops.Str(f,"id"),Name=Ops.Str(f,"name")})),selectedFactory);
                Fill(devices,deviceList.Select(d=>new Choice {Id=Ops.Str(d,"id"),Name=Ops.Str(d,"name")}),selectedDevice);
                rows=PointRow.From(pointData);Filter();
                var device=Ops.Get(pointData,"device");var runtime=Ops.Get(pointData,"deviceStatus");
                string state=Ops.Str(runtime,"status");state=state=="connected" ? "已连接" : state=="offline" ? "离线" : state=="disabled" ? "未启用" : state=="" ? "无连接遥测" : state;
                info.Text=Ops.Str(device,"plc_protocol")+"  "+Ops.Str(device,"plc_ip")+"  ·  "+state+"  ·  "+rows.Count+" 点  ·  "+DateTime.Now.ToString("HH:mm:ss");
            } catch(Exception error) {
                if(!IsDisposed && active==client){rows.Clear();Filter();info.Text=Ops.Redact(error.Message);if(!active.LoggedIn)SetLoginButton(false);}
            } finally {updating=false;loading=false;}
        }
        internal void SmokeFixture()
        {
            updating=true;
            Fill(factories,new[]{new Choice {Id="",Name="跟随后台 · 测试工厂"}},"");
            Fill(devices,new[]{new Choice {Id="fixture",Name="炉1"}},"fixture");
            rows=PointRow.From(Ops.Parse("{\"points\":[{\"label\":\"温度\",\"plc_tag\":\"DB1,REAL0\",\"data_type\":\"REAL\",\"value\":0,\"unit\":\"℃\",\"quality\":\"good\"},{\"label\":\"运行\",\"plc_tag\":\"DB1,X4.0\",\"data_type\":\"BOOL\",\"value\":true,\"quality\":\"good\"},{\"label\":\"压力\",\"plc_tag\":\"DB1,REAL8\",\"data_type\":\"REAL\",\"value\":99,\"quality\":\"bad\"}]}"));
            Filter();info.Text="测试夹具 · 非现场数据";updating=false;
        }
    }
}

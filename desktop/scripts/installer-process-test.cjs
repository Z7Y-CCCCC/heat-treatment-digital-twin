'use strict';
const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path');
const { fixture, quote, root } = require('./installer-test-fixtures.cjs');
const windows = { skip: process.platform !== 'win32' };

test('UTF-8 PowerShell children forward Chinese, emoji, genuine warnings and stderr to the UTF-16 nsExec boundary', windows, t => {
    const f = fixture(t), child = path.join(f.directory, '中文-子进程.ps1');
    fs.writeFileSync(child, '\uFEFF' + f.helper + [
        'Initialize-InstallerOutput',
        "Write-Host '中文 Host：采集服务 😀'",
        "Write-Warning '真正的 warning：校验失败不能隐藏'",
        "[Console]::Error.WriteLine('中文 stderr：错误信息 😀')",
        "[Console]::WriteLine('纯文本没有混合编码')",
        'exit 7'
    ].join('\n'));
    const r = f.runPowerShell(f.helper + 'Initialize-InstallerOutput -ForNsis\n$code=Invoke-InstallerPowerShell ' + quote(child) + '\nexit $code', { nsis: true });
    assert.equal(r.status, 7, r.text + r.errorText);
    assert.equal(r.stdout.readUInt16LE(0), 0xfeff);
    for (const text of ['中文 Host：采集服务 😀','真正的 warning：校验失败不能隐藏','stderr: 中文 stderr：错误信息 😀','纯文本没有混合编码']) assert.ok(r.text.includes(text), r.text);
    assert.doesNotMatch(r.text, /\uFFFD|鐑|閲囬|氀捥|CLIXML/);
});

test('Windows argument quoting round-trips empty strings, quotes and trailing backslashes', windows, t => {
    const f = fixture(t), child = path.join(f.directory, 'arguments.cjs');
    fs.writeFileSync(child, 'console.log(JSON.stringify(process.argv.slice(2)));');
    const values = ['', '中文 with spaces', '"quoted"', 'C:\\ends in slash\\', '\\before"quote', 'a\\\\"b\\'];
    const args = [child, ...values].map(quote).join(',');
    const r = f.runPowerShell(f.helper + 'Initialize-InstallerOutput\n$code=Invoke-InstallerProcess -FilePath ' + quote(process.execPath) + ' -ArgumentList @(' + args + ')\nexit $code');
    assert.equal(r.status, 0, r.text + r.errorText);
    const json = r.text.split(/\r?\n/).find(line => line.includes('["')).replace(/^\[\+[^\]]+\] /,'');
    assert.deepEqual(JSON.parse(json), values);
});

test('native OEM output is decoded before Unicode logging, not mistaken for UTF-8', windows, t => {
    const f = fixture(t), file = path.join(f.directory, '中文日志.txt'); fs.writeFileSync(file, 'fixture');
    const r = f.runPowerShell(f.helper + 'Initialize-InstallerOutput\n$code=Invoke-InstallerProcess -NativeOutput -FilePath (Join-Path $env:SystemRoot "System32\\icacls.exe") -ArgumentList @(' + quote(file) + ')\nexit $code');
    assert.equal(r.status, 0, r.text + r.errorText);
    assert.ok(r.text.includes('中文日志.txt'), r.text);
    assert.doesNotMatch(r.text, /\uFFFD/);
});

test('stream draining does not impose a sleep per line or deadlock stderr; a failed child keeps its exit code', windows, t => {
    const f = fixture(t), child = path.join(f.directory, 'many-lines.cjs');
    fs.writeFileSync(child, 'for(let i=0;i<400;i++){console.log("stdout-"+i); console.error("stderr-"+i);} process.exitCode=23;');
    const before = Date.now();
    const r = f.runPowerShell(f.helper + 'Initialize-InstallerOutput\n$code=Invoke-InstallerProcess -FilePath ' + quote(process.execPath) + ' -ArgumentList @(' + quote(child) + ') -TimeoutSeconds 8\nexit $code');
    assert.equal(r.status, 23, r.text + r.errorText);
    assert.ok(r.text.includes('stdout-399') && r.text.includes('stderr-399'));
    assert.ok(Date.now() - before < 12000, 'logging 800 short lines must not add 20 seconds of artificial sleeps');
});

test('a timed-out owned child fails explicitly rather than claiming success', windows, t => {
    const f = fixture(t), child = path.join(f.directory, 'wait.cjs'); fs.writeFileSync(child, 'setTimeout(()=>{},10000);');
    const r = f.runPowerShell(f.helper + 'Initialize-InstallerOutput\ntry { $null=Invoke-InstallerProcess -FilePath ' + quote(process.execPath) + ' -ArgumentList @(' + quote(child) + ') -TimeoutSeconds 1; exit 0 } catch { Write-InstallerMessage $_.Exception.Message; exit 41 }');
    assert.equal(r.status, 41, r.text + r.errorText);
    assert.match(r.text, /超过 1 秒/);
});

test('service waits use pure fake controllers, avoid repeating Start/Stop on pending states, and retain real failures', windows, t => {
    const f = fixture(t);
    const script = f.helper + [
        'Initialize-InstallerOutput',
        'class FakeService {',
        ' [string]$Status; [int]$Starts=0; [int]$Stops=0; [bool]$Finish=$true',
        ' FakeService([string]$state,[bool]$finish) { $this.Status=$state; $this.Finish=$finish }',
        ' [void]Refresh() { if ($this.Finish) { if ($this.Status -eq "StartPending") { $this.Status="Running" }; if ($this.Status -eq "StopPending") { $this.Status="Stopped" } } }',
        ' [void]Start() { $this.Starts++; $this.Status="Running" }',
        ' [void]Stop() { $this.Stops++; $this.Status="Stopped" }',
        '}',
        '$pendingStart=[FakeService]::new("StartPending",$true); Start-InstallerService $pendingStart -TimeoutSeconds 2',
        '$pendingStop=[FakeService]::new("StopPending",$true); Stop-InstallerService $pendingStop -TimeoutSeconds 2',
        '$stopped=[FakeService]::new("Stopped",$true); Start-InstallerService $stopped -TimeoutSeconds 2',
        '$running=[FakeService]::new("Running",$true); Stop-InstallerService $running -TimeoutSeconds 2',
        '$timeout=$false; try { Wait-InstallerServiceStatus ([FakeService]::new("StartPending",$false)) -Target Running -TimeoutSeconds 0 } catch { $timeout=$true }',
        '$crash=$false; try { Wait-InstallerServiceStatus ([FakeService]::new("Stopped",$false)) -Target Running -TimeoutSeconds 2 } catch { $crash=$true }',
        '[Console]::WriteLine((@{ pendingStarts=$pendingStart.Starts; pendingStops=$pendingStop.Stops; starts=$stopped.Starts; stops=$running.Stops; timeout=$timeout; crash=$crash } | ConvertTo-Json -Compress))'
    ].join('\n');
    const r = f.runPowerShell(script);
    assert.equal(r.status, 0, r.text + r.errorText);
    const result = JSON.parse(r.text.split(/\r?\n/).find(line=>line.startsWith('{')));
    assert.deepEqual(result, {pendingStarts:0,pendingStops:0,starts:1,stops:1,timeout:true,crash:true});
    assert.doesNotMatch(r.text, /警告:|WARNING:/);
    const service = fs.readFileSync(path.join(root,'desktop/安装采集服务.ps1'),'utf8');
    assert.match(service, /Start-InstallerService.*TimeoutSeconds 900/);
    assert.match(service, /health\.db\.connected -eq \$true/);
    assert.match(service, /health\.runtime\.owner -eq 'windows-service'/);
    assert.doesNotMatch(service, /Start-Service|Stop-Service/);
});

test('Windows PowerShell installer restores its built-in modules before hashing under an incompatible inherited module path',windows,t=>{
    const f=fixture(t),file=path.join(f.directory,'hash-fixture.txt'),bad=path.join(f.directory,'only-powershell-7-modules');fs.writeFileSync(file,'abc');
    const source=f.helper+'$env:PSModulePath='+quote(bad)+'\nInitialize-InstallerOutput\n'+
        '[Console]::WriteLine(([ordered]@{hash=(Get-FileHash -LiteralPath '+quote(file)+
        ' -Algorithm SHA256).Hash.ToLowerInvariant();modulePath=$env:PSModulePath;major=$PSVersionTable.PSVersion.Major}|ConvertTo-Json -Compress))';
    const result=f.runPowerShell(source);assert.equal(result.status,0,result.text+result.errorText);const actual=JSON.parse(result.text.trim());
    assert.equal(actual.hash,require('node:crypto').createHash('sha256').update('abc').digest('hex'));assert.equal(actual.major,5);
    assert.equal(actual.modulePath.includes(bad),false);assert.match(actual.modulePath,/WindowsPowerShell[\\/]v1\.0[\\/]Modules/);
});

test('NSIS first pipe chunk includes UTF-16 text with its BOM, so the legacy ANSI-or-wide decoder cannot misread a bare BOM',{...windows,timeout:20000},async t=>{
    const f=fixture(t),script=path.join(f.directory,'first-chunk.ps1');
    fs.writeFileSync(script,'\uFEFF'+f.helper+'Initialize-InstallerOutput -ForNsis\nStart-Sleep -Milliseconds 300\n[Console]::WriteLine("后续中文日志")');
    const powershell=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
    const child=require('node:child_process').spawn(powershell,['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',script],
        {windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:15000});
    const chunks=[],errors=[];let first;
    child.stdout.on('data',chunk=>{if(!first)first=Buffer.from(chunk);chunks.push(chunk);});child.stderr.on('data',chunk=>errors.push(chunk));
    const status=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
    assert.equal(status,0,Buffer.concat(errors).toString('utf8'));assert.ok(first&&first.length>2);
    assert.equal(first.readUInt16LE(0),0xfeff);assert.equal(first.includes(0),true,'old WideConvertIfASCII must select the wide branch for the first read');
    assert.match(first.toString('utf16le'),/\[\+0\.0s\].*UTF-16LE/);assert.ok(Buffer.concat(chunks).toString('utf16le').includes('后续中文日志'));
});
